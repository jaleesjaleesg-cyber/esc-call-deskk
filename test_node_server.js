const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROJECT_DIR = __dirname;

function writeJson(dir, filename, value) {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(value, null, 2), 'utf8');
}

function cleanEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) delete env[key];
  return env;
}

function startTestServer(dataDir, port, extraEnv = {}) {
  return spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_DIR,
    env: cleanEnvironment({
      PORT: String(port),
      ESC_DATA_DIR: dataDir,
      ESC_ALLOW_INSECURE_DEV_PASSWORDS: '1',
      ESC_COOKIE_SECURE: '0',
      NODE_ENV: 'test',
      ...extraEnv
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitForServer(child) {
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start. Output: ${output}`)), 10000);
    const inspect = chunk => {
      output += chunk.toString();
      if (output.includes('ESC Cold Calling Server running')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Server exited with ${code}. Output: ${output}`));
    });
  });
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie);
  return setCookie.split(';')[0];
}

async function api(baseUrl, cookie, route, options = {}) {
  return fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      Cookie: cookie,
      ...(options.headers || {})
    }
  });
}

test('Node server preserves routing revisions and tombstones deleted companies', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-node-test-'));
  fs.mkdirSync(path.join(dataDir, 'snapshots'));
  writeJson(dataDir, 'companies_intelligence.json', {
    TEST123: { crn: 'TEST123', company_name: 'Delete Me Ltd' },
    KEEP123: {
      crn: 'KEEP123', company_name: 'Keep Me Ltd', prospect_status: 'REGISTRY_PROSPECT',
      pipeline_list: 'reached', call_notes: 'Preserve this live note', is_pinned: true
    }
  });
  writeJson(dataDir, 'pipeline_state.json', { TEST123: { pipeline_list: 'todays_targets' } });
  writeJson(dataDir, 'call_history.json', [{ id: 1, crn: 'TEST123' }]);
  writeJson(dataDir, 'workspace_settings.json', { unreachable_after_attempts: 2 });
  writeJson(dataDir, 'deleted_companies.json', {});
  writeJson(dataDir, 'metadata.json', { status: 'active', total_prospects: 2 });

  const port = 33000 + (process.pid % 1000);
  const child = startTestServer(dataDir, port);
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer(child);

  const baseUrl = `http://127.0.0.1:${port}`;
  const cookie = await login(baseUrl, 'jalees', 'jalees');
  const aroosaCookie = await login(baseUrl, 'aroosa', 'aroosa');

  let response = await api(baseUrl, cookie, '/api/companies');
  let companies = await response.json();
  assert.deepEqual(Object.keys(companies).sort(), ['KEEP123', 'TEST123']);

  response = await api(baseUrl, cookie, '/api/companies/delete', {
    method: 'POST',
    body: JSON.stringify({ crn: 'TEST123' })
  });
  assert.equal(response.status, 200);

  response = await api(baseUrl, cookie, '/api/companies');
  companies = await response.json();
  assert.deepEqual(Object.keys(companies), ['KEEP123']);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dataDir, 'deleted_companies.json'), 'utf8')).TEST123);

  const researchArtifact = {
    schema_version: 'esc-research-import/v1',
    batch_id: 'node-test-batch',
    generated_at: '2026-08-25T12:00:00+00:00',
    company_count: 4,
    companies: {
      KEEP123: {
        crn: 'KEEP123', company_name: 'Keep Me Security Ltd', prospect_status: 'QUALIFIED',
        has_full_dossier: true, phone: '01234 111111', pipeline_list: 'off_our_list',
        call_notes: 'Imported files must not overwrite live notes', is_pinned: false
      },
      NEW123: {
        crn: 'NEW123', company_name: 'New Guarding Ltd', prospect_status: 'QUALIFIED',
        has_full_dossier: true, phone: '01234 222222'
      },
      TEST123: {
        crn: 'TEST123', company_name: 'Deleted Company', prospect_status: 'QUALIFIED',
        has_full_dossier: true
      },
      REG123: {
        crn: 'REG123', company_name: 'Registry Only Ltd', prospect_status: 'REGISTRY_PROSPECT',
        has_full_dossier: false
      }
    }
  };

  response = await fetch(`${baseUrl}/api/research-import/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artifact: researchArtifact })
  });
  assert.equal(response.status, 401);

  response = await api(baseUrl, aroosaCookie, '/api/research-import/preview', {
    method: 'POST', body: JSON.stringify({ artifact: researchArtifact })
  });
  assert.equal(response.status, 403);

  response = await api(baseUrl, cookie, '/api/research-import/preview', {
    method: 'POST', body: JSON.stringify({ artifact: researchArtifact })
  });
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.accepted_count, 2);
  assert.equal(preview.new_count, 1);
  assert.equal(preview.update_count, 1);
  assert.equal(preview.rejected_count, 2);

  response = await api(baseUrl, cookie, '/api/research-import/commit', {
    method: 'POST', body: JSON.stringify({ artifact: researchArtifact })
  });
  assert.equal(response.status, 200);
  const importResult = await response.json();
  assert.equal(importResult.status, 'imported');
  assert.equal(importResult.metadata.last_import.batch_id, 'node-test-batch');

  response = await api(baseUrl, cookie, '/api/companies');
  companies = await response.json();
  assert.deepEqual(Object.keys(companies).sort(), ['KEEP123', 'NEW123']);
  assert.equal(companies.KEEP123.company_name, 'Keep Me Security Ltd');
  assert.equal(companies.KEEP123.call_notes, 'Preserve this live note');
  assert.equal(companies.KEEP123.pipeline_list, 'reached');
  assert.equal(companies.KEEP123.is_pinned, true);
  assert.equal(companies.NEW123.phone, '01234 222222');

  const importSnapshots = fs.readdirSync(path.join(dataDir, 'snapshots'))
    .map(filename => JSON.parse(fs.readFileSync(path.join(dataDir, 'snapshots', filename), 'utf8')))
    .filter(snapshot => snapshot.type === 'pre_research_import');
  assert.equal(importSnapshots.length, 1);
  assert.ok(importSnapshots[0].company_database.KEEP123);
  assert.equal(importSnapshots[0].company_database.NEW123, undefined);

  response = await api(baseUrl, cookie, '/api/state', {
    method: 'POST',
    body: JSON.stringify({
      pipeline_state: {
        MERGE001: {
          pipeline_list: 'reached', contact_attempts: 1, pipeline_updated_at: 300,
          call_notes: 'older note', notes_updated_at: 100,
          is_pinned: true, pin_updated_at: 250, last_updated: 300
        }
      },
      call_history: []
    })
  });
  assert.equal(response.status, 200);

  response = await api(baseUrl, cookie, '/api/state', {
    method: 'POST',
    body: JSON.stringify({
      pipeline_state: {
        MERGE001: {
          pipeline_list: 'todays_targets', contact_attempts: 0, pipeline_updated_at: 200,
          call_notes: 'newer note', last_outcome: 'Email the info', notes_updated_at: 400,
          is_pinned: false, pin_updated_at: 200, last_updated: 400
        }
      },
      call_history: []
    })
  });
  assert.equal(response.status, 200);

  response = await api(baseUrl, cookie, '/api/state');
  const merged = (await response.json()).pipeline_state.MERGE001;
  assert.equal(merged.pipeline_list, 'reached');
  assert.equal(merged.contact_attempts, 1);
  assert.equal(merged.call_notes, 'newer note');
  assert.equal(merged.last_outcome, 'Email the info');
  assert.equal(merged.is_pinned, true);

  response = await api(baseUrl, cookie, '/api/status');
  assert.equal((await response.json()).persistence.mode, 'json-files');
});

test('database-required mode fails closed when credentials are missing', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-node-required-db-'));
  fs.mkdirSync(path.join(dataDir, 'snapshots'));
  const child = startTestServer(dataDir, 34000 + (process.pid % 1000), { ESC_REQUIRE_DATABASE: '1' });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const code = await new Promise(resolve => child.once('exit', resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
  assert.notEqual(code, 0);
  assert.match(output, /ESC_REQUIRE_DATABASE=1/);
});
