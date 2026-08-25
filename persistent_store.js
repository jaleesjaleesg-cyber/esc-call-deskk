const fs = require('fs');
const path = require('path');

const STATE_FILE_KEYS = new Map([
  ['companies_intelligence.json', 'company_database'],
  ['metadata.json', 'company_metadata'],
  ['pipeline_state.json', 'pipeline_state'],
  ['call_history.json', 'call_history'],
  ['workspace_settings.json', 'workspace_settings'],
  ['deleted_companies.json', 'deleted_companies']
]);

function writeJsonAtomic(filepath, data) {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tempFile = `${filepath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempFile, filepath);
}

class PersistentStore {
  constructor({ dataDir, snapshotsDir }) {
    this.dataDir = path.resolve(dataDir);
    this.snapshotsDir = path.resolve(snapshotsDir);
    this.required = process.env.ESC_REQUIRE_DATABASE === '1';
    this.pool = null;
    this.ready = false;
    this.mode = 'json-files';
    this.writeQueue = Promise.resolve();
    this.lastWriteError = null;
  }

  databaseConfig() {
    const config = {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    };
    const complete = Boolean(config.host && config.user && config.password && config.database);
    return { complete, config };
  }

  async initialize() {
    const { complete, config } = this.databaseConfig();
    if (!complete) {
      if (this.required) {
        throw new Error('ESC_REQUIRE_DATABASE=1 but DB_HOST, DB_USER, DB_PASSWORD and DB_NAME are not all configured.');
      }
      console.warn('[Persistence] MySQL is not configured; using JSON files. Do not use GitHub auto-deploy for live data in this mode.');
      return this.status();
    }

    const mysql = require('mysql2/promise');
    this.pool = mysql.createPool({
      ...config,
      waitForConnections: true,
      connectionLimit: 4,
      queueLimit: 0,
      connectTimeout: 10000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0
    });

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS esc_app_state (
        state_key VARCHAR(64) PRIMARY KEY,
        payload LONGTEXT NOT NULL,
        updated_at BIGINT NOT NULL
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS esc_app_snapshots (
        snapshot_id VARCHAR(191) PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        payload LONGTEXT NOT NULL,
        created_at BIGINT NOT NULL,
        INDEX idx_esc_snapshot_created_at (created_at)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    await this.hydrateOrSeedState();
    await this.hydrateOrSeedSnapshots();
    this.ready = true;
    this.mode = 'mysql';
    console.log('[Persistence] MySQL connected; runtime state will survive redeployments.');
    return this.status();
  }

  async hydrateOrSeedState() {
    for (const [filename, stateKey] of STATE_FILE_KEYS) {
      const filepath = path.join(this.dataDir, filename);
      const [rows] = await this.pool.execute(
        'SELECT payload FROM esc_app_state WHERE state_key = ? LIMIT 1',
        [stateKey]
      );
      if (rows.length > 0) {
        writeJsonAtomic(filepath, JSON.parse(rows[0].payload));
      } else if (fs.existsSync(filepath)) {
        const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        await this.upsertState(stateKey, data);
      }
    }
  }

  async hydrateOrSeedSnapshots() {
    if (!fs.existsSync(this.snapshotsDir)) fs.mkdirSync(this.snapshotsDir, { recursive: true });
    const [rows] = await this.pool.query(
      'SELECT snapshot_id, filename, payload FROM esc_app_snapshots ORDER BY created_at ASC'
    );
    if (rows.length > 0) {
      for (const row of rows) {
        if (!/^snapshot_[A-Za-z0-9_-]+\.json$/.test(row.filename)) continue;
        writeJsonAtomic(path.join(this.snapshotsDir, row.filename), JSON.parse(row.payload));
      }
      return;
    }

    const files = fs.readdirSync(this.snapshotsDir)
      .filter(filename => /^snapshot_[A-Za-z0-9_-]+\.json$/.test(filename));
    for (const filename of files) {
      const filepath = path.join(this.snapshotsDir, filename);
      const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      await this.upsertSnapshot(filename, data);
    }
  }

  async upsertState(stateKey, data) {
    await this.pool.execute(
      `INSERT INTO esc_app_state (state_key, payload, updated_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE payload = VALUES(payload), updated_at = VALUES(updated_at)`,
      [stateKey, JSON.stringify(data), Date.now()]
    );
  }

  async upsertSnapshot(filename, data) {
    const snapshotId = String(data.id || filename.replace(/\.json$/, '')).slice(0, 191);
    const createdAt = Number(data.timestamp || Date.now());
    await this.pool.execute(
      `INSERT INTO esc_app_snapshots (snapshot_id, filename, payload, created_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE filename = VALUES(filename), payload = VALUES(payload), created_at = VALUES(created_at)`,
      [snapshotId, filename, JSON.stringify(data), createdAt]
    );
  }

  enqueue(operation) {
    if (!this.ready || !this.pool) return Promise.resolve();
    const pending = this.writeQueue.then(operation);
    this.writeQueue = pending.catch(error => {
      this.lastWriteError = error;
      console.error('[Persistence] MySQL write failed:', error.message);
    });
    return pending;
  }

  queueFileWrite(filepath, data) {
    const absolute = path.resolve(filepath);
    const filename = path.basename(absolute);
    const stateKey = STATE_FILE_KEYS.get(filename);
    if (stateKey && path.dirname(absolute) === this.dataDir) {
      return this.enqueue(() => this.upsertState(stateKey, data));
    }
    if (path.dirname(absolute) === this.snapshotsDir && /^snapshot_[A-Za-z0-9_-]+\.json$/.test(filename)) {
      return this.enqueue(() => this.upsertSnapshot(filename, data));
    }
    return Promise.resolve();
  }

  queueFileDelete(filepath) {
    const absolute = path.resolve(filepath);
    const filename = path.basename(absolute);
    if (path.dirname(absolute) !== this.snapshotsDir || !/^snapshot_[A-Za-z0-9_-]+\.json$/.test(filename)) {
      return Promise.resolve();
    }
    return this.enqueue(() => this.pool.execute(
      'DELETE FROM esc_app_snapshots WHERE filename = ?',
      [filename]
    ));
  }

  async flush() {
    await this.writeQueue;
    if (this.lastWriteError) {
      const error = this.lastWriteError;
      this.lastWriteError = null;
      throw error;
    }
  }

  status() {
    return {
      mode: this.mode,
      database_required: this.required,
      database_configured: this.databaseConfig().complete,
      ready: this.ready
    };
  }
}

module.exports = { PersistentStore, STATE_FILE_KEYS };
