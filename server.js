const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { PersistentStore } = require('./persistent_store');

const app = express();
// Hostinger routes Node.js Web Apps to port 3000 when it does not inject PORT.
// Preserve platform overrides while using the required production fallback.
const PORT = Number(process.env.PORT) || 3000;
const SCRIPT_DIR = __dirname;
const DATA_DIR = path.resolve(process.env.ESC_DATA_DIR || SCRIPT_DIR);
const ALLOW_INSECURE_DEV_PASSWORDS = process.env.ESC_ALLOW_INSECURE_DEV_PASSWORDS === '1';
const COOKIE_SECURE = process.env.ESC_COOKIE_SECURE !== '0';

// File paths
const PIPELINE_STATE_FILE = path.join(DATA_DIR, 'pipeline_state.json');
const CALL_HISTORY_FILE = path.join(DATA_DIR, 'call_history.json');
const DELETED_COMPANIES_FILE = path.join(DATA_DIR, 'deleted_companies.json');
const WORKSPACE_SETTINGS_FILE = path.join(DATA_DIR, 'workspace_settings.json');
const METADATA_FILE = path.join(DATA_DIR, 'metadata.json');
const OUTPUT_JSON = path.join(DATA_DIR, 'companies_intelligence.json');
const SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');

if (!fs.existsSync(SNAPSHOTS_DIR)) {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
}

const persistentStore = new PersistentStore({ dataDir: DATA_DIR, snapshotsDir: SNAPSHOTS_DIR });

// Global settings & auth
const DEFAULT_WORKSPACE_SETTINGS = { unreachable_after_attempts: 2 };
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const AUTH_SESSIONS = new Map();
const LOGIN_ATTEMPTS = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const RESEARCH_IMPORT_SCHEMA = 'esc-research-import/v1';
const MAX_RESEARCH_IMPORT_COMPANIES = 500;
const IMPORTABLE_RESEARCH_STATUSES = new Set(['QUALIFIED', 'DISQUALIFIED', 'NEEDS_REVIEW']);
const RUNTIME_COMPANY_FIELDS = new Set([
  'pipeline_list',
  'contact_attempts',
  'call_notes',
  'last_outcome',
  'last_phone_used',
  'last_dm_reached',
  'last_caller',
  'last_updated',
  'pipeline_updated_at',
  'notes_updated_at',
  'is_pinned',
  'pinned_at',
  'pinned_by',
  'pin_updated_at',
  'jalees_notes',
  'jalees_notes_updated_at',
  'jalees_notes_updated_by'
]);
const COMPANY_INDEX_FIELDS = [
  'crn',
  'company_name',
  'rank',
  'tier',
  'deterministic_score',
  'confidence_score',
  'prospect_status',
  'has_full_dossier',
  'is_physical_guarding',
  'is_sia_acs_approved',
  'sia_acs_registered_name',
  'sia_acs_activities',
  'primary_service_verdict',
  'pipeline_list',
  'contact_attempts',
  'last_outcome',
  'last_phone_used',
  'last_dm_reached',
  'last_caller',
  'last_updated',
  'pipeline_updated_at',
  'notes_updated_at',
  'is_pinned',
  'pinned_at',
  'pinned_by',
  'pin_updated_at',
  'phone',
  'phone_numbers',
  'email',
  'website',
  'website_status',
  'registered_address',
  'operational_address',
  'decision_makers'
];

if (!ALLOW_INSECURE_DEV_PASSWORDS && (!process.env.ESC_AROOSA_PASSWORD || !process.env.ESC_JALEES_PASSWORDS)) {
  throw new Error('ESC_AROOSA_PASSWORD and ESC_JALEES_PASSWORDS must be set before the server starts.');
}

const AUTH_USERS = {
  aroosa: {
    name: 'Aroosa',
    role: 'caller',
    passwords: [process.env.ESC_AROOSA_PASSWORD || 'aroosa']
  },
  jalees: {
    name: 'Jalees',
    role: 'handler',
    passwords: (process.env.ESC_JALEES_PASSWORDS || 'goraya,jalees').split(',').filter(Boolean)
  }
};

// Middleware
app.use(cookieParser());
app.use(express.json({ limit: '32mb', type: ['application/json', 'application/*+json'] }));
app.disable('x-powered-by');
app.set('trust proxy', 1);

// No-cache headers for real-time live sync
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
  next();
});

// Helper: Atomic JSON save
function saveJsonAtomic(filepath, data) {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tempFile = `${filepath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tempFile, filepath);
  if (path.resolve(filepath) === OUTPUT_JSON) {
    companyDatabaseCache = { mtimeMs: -1, size: -1, companies: {} };
  }
  persistentStore.queueFileWrite(filepath, data);
}

// Helper: Safe JSON load
function loadJsonSafe(filepath, defaultVal = {}) {
  try {
    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.error(`[-] Error loading ${filepath}:`, err.message);
  }
  return defaultVal;
}

function getDeletedCompanies() {
  const data = loadJsonSafe(DELETED_COMPANIES_FILE, {});
  return typeof data === 'object' && data !== null ? data : {};
}

let companyDatabaseCache = { mtimeMs: -1, size: -1, companies: {} };

function loadCompanyDatabase() {
  try {
    const stats = fs.statSync(OUTPUT_JSON);
    if (companyDatabaseCache.mtimeMs === stats.mtimeMs && companyDatabaseCache.size === stats.size) {
      return companyDatabaseCache.companies;
    }
    const companies = loadJsonSafe(OUTPUT_JSON, {});
    companyDatabaseCache = { mtimeMs: stats.mtimeMs, size: stats.size, companies };
    return companies;
  } catch (_) {
    companyDatabaseCache = { mtimeMs: -1, size: -1, companies: {} };
    return {};
  }
}

function getVisibleCompanies() {
  const companies = loadCompanyDatabase();
  const deletedCrns = new Set(Object.keys(getDeletedCompanies()).map(crn => String(crn).trim().toUpperCase()));
  if (!deletedCrns.size) return companies;
  const visible = {};
  for (const [crn, company] of Object.entries(companies)) {
    if (!deletedCrns.has(String(crn).trim().toUpperCase())) visible[crn] = company;
  }
  return visible;
}

function getVisibleCompany(crn) {
  const normalizedCrn = String(crn || '').trim().toUpperCase();
  if (!normalizedCrn) return null;
  const deletedCrns = new Set(Object.keys(getDeletedCompanies()).map(key => String(key).trim().toUpperCase()));
  if (deletedCrns.has(normalizedCrn)) return null;
  const companies = loadCompanyDatabase();
  if (companies[normalizedCrn]) return companies[normalizedCrn];
  const matchedKey = Object.keys(companies).find(key => String(key).trim().toUpperCase() === normalizedCrn);
  return matchedKey ? companies[matchedKey] : null;
}

function getVisibleCompanyIndex() {
  const index = {};
  for (const [crn, company] of Object.entries(getVisibleCompanies())) {
    const summary = { _summary_only: true };
    for (const field of COMPANY_INDEX_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(company, field)) summary[field] = company[field];
    }
    summary.crn = summary.crn || crn;
    index[crn] = summary;
  }
  return index;
}

async function flushPersistenceOrFail(res) {
  try {
    await persistentStore.flush();
    return true;
  } catch (error) {
    console.error('[Persistence] Could not confirm durable save:', error.message);
    res.status(503).json({
      error: 'The change reached the local process but could not be confirmed in durable storage. Please retry before continuing.'
    });
    return false;
  }
}

function getStateRevision() {
  const files = [
    OUTPUT_JSON,
    METADATA_FILE,
    PIPELINE_STATE_FILE,
    CALL_HISTORY_FILE,
    WORKSPACE_SETTINGS_FILE,
    DELETED_COMPANIES_FILE
  ];
  let maxTime = 0;
  for (const f of files) {
    try {
      if (fs.existsSync(f)) {
        const st = fs.statSync(f);
        const mtimeNs = Math.floor(st.mtimeMs * 1e6);
        if (mtimeNs > maxTime) maxTime = mtimeNs;
      }
    } catch (_) {}
  }
  return maxTime || (Date.now() * 1e6);
}

function normalizeWorkspaceSettings(settings) {
  const normalized = { ...DEFAULT_WORKSPACE_SETTINGS };
  if (settings && typeof settings === 'object') {
    const val = parseInt(settings.unreachable_after_attempts, 10);
    if (!isNaN(val)) {
      normalized.unreachable_after_attempts = Math.min(20, Math.max(1, val));
    }
  }
  return normalized;
}

function loadWorkspaceSettings() {
  return normalizeWorkspaceSettings(loadJsonSafe(WORKSPACE_SETTINGS_FILE, {}));
}

function saveWorkspaceSettings(settings) {
  const normalized = normalizeWorkspaceSettings(settings);
  saveJsonAtomic(WORKSPACE_SETTINGS_FILE, normalized);
  return normalized;
}

function loadWorkspaceState() {
  const pipeline = loadJsonSafe(PIPELINE_STATE_FILE, {});
  const history = loadJsonSafe(CALL_HISTORY_FILE, []);
  const settings = loadWorkspaceSettings();
  const revision = getStateRevision();
  return { pipeline, history, settings, revision };
}

function entryRevision(entry, field, fallbackField = null) {
  if (!entry || typeof entry !== 'object') return 0;
  return entry[field] || (fallbackField && entry[fallbackField]) || entry.last_updated || 0;
}

function mergePipelineEntriesByRevision(diskEntry = {}, incomingEntry = {}) {
  const diskLast = diskEntry.last_updated || 0;
  const incomingLast = incomingEntry.last_updated || 0;
  const merged = incomingLast >= diskLast
    ? { ...diskEntry, ...incomingEntry }
    : { ...incomingEntry, ...diskEntry };
  const groups = [
    ['pipeline_updated_at', null, ['pipeline_list', 'contact_attempts', 'last_phone_used', 'last_dm_reached']],
    ['notes_updated_at', null, ['call_notes', 'last_outcome']],
    ['pin_updated_at', 'pinned_at', ['is_pinned', 'pinned_at', 'pinned_by']]
  ];

  for (const [revisionField, fallbackField, fields] of groups) {
    const source = entryRevision(incomingEntry, revisionField, fallbackField) >= entryRevision(diskEntry, revisionField, fallbackField)
      ? incomingEntry
      : diskEntry;
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(source, field)) merged[field] = source[field];
    }
    merged[revisionField] = entryRevision(source, revisionField, fallbackField);
  }
  merged.last_updated = Math.max(diskLast, incomingLast);
  return merged;
}

function computeSnapshotStats(pipelineState, callHistory, totalCompaniesCount = 0) {
  const counts = {
    all_qualified: 0,
    todays_targets: 0,
    sia_approved_entries: 0,
    contacted: 0,
    reached: 0,
    unreachable: 0,
    off_our_list: 0,
    permanently_off_our_list: 0,
    master_list: 0
  };

  if (pipelineState && typeof pipelineState === 'object') {
    for (const item of Object.values(pipelineState)) {
      const listName = item && item.pipeline_list;
      if (listName && counts[listName] !== undefined) {
        counts[listName]++;
      } else if (listName) {
        counts.master_list++;
      }
    }
  }

  return {
    total_tracked: pipelineState && typeof pipelineState === 'object' ? Object.keys(pipelineState).length : 0,
    total_companies: totalCompaniesCount || (pipelineState && typeof pipelineState === 'object' ? Object.keys(pipelineState).length : 0),
    todays_targets: counts.todays_targets,
    all_qualified: counts.all_qualified,
    sia_approved_entries: counts.sia_approved_entries,
    contacted: counts.contacted,
    reached: counts.reached,
    unreachable: counts.unreachable,
    off_our_list: counts.off_our_list,
    permanently_off_our_list: counts.permanently_off_our_list,
    total_history_records: Array.isArray(callHistory) ? callHistory.length : 0
  };
}

function listAllSnapshots() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) return [];
  const files = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.startsWith('snapshot_') && f.endsWith('.json'));
  const snapshots = [];
  for (const filename of files) {
    const filepath = path.join(SNAPSHOTS_DIR, filename);
    try {
      const data = loadJsonSafe(filepath, null);
      if (data) {
        const st = fs.statSync(filepath);
        snapshots.push({
          id: data.id || filename.replace('.json', ''),
          filename,
          name: data.name || filename,
          type: data.type || 'manual',
          timestamp: data.timestamp || Math.floor(st.mtimeMs),
          date_str: data.date_str || new Date(st.mtimeMs).toISOString().replace('T', ' ').substring(0, 19),
          created_by: data.created_by || 'User',
          notes: data.notes || '',
          stats: data.stats || {},
          size_bytes: st.size
        });
      }
    } catch (_) {}
  }
  snapshots.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return snapshots;
}

function createSnapshot({
  name = 'Manual Snapshot',
  notes = '',
  created_by = 'User',
  snap_type = 'manual',
  custom_state = null,
  custom_history = null,
  custom_settings = null,
  custom_companies = null,
  custom_metadata = null,
  include_company_database = false
} = {}) {
  const pipeline = custom_state !== null ? custom_state : loadJsonSafe(PIPELINE_STATE_FILE, {});
  const history = custom_history !== null ? custom_history : loadJsonSafe(CALL_HISTORY_FILE, []);
  const settings = normalizeWorkspaceSettings(custom_settings !== null ? custom_settings : loadWorkspaceSettings());
  const includeCompanies = include_company_database || custom_companies !== null;
  const companies = custom_companies !== null ? custom_companies : loadJsonSafe(OUTPUT_JSON, {});
  const companyMetadata = custom_metadata !== null ? custom_metadata : loadJsonSafe(METADATA_FILE, {});

  const nowTs = Date.now();
  const dateStr = new Date(nowTs).toISOString().replace('T', ' ').substring(0, 19);
  const cleanName = (name || 'snapshot').trim();
  const slug = cleanName.toLowerCase().replace(/[^a-z0-9_-]/g, '_').substring(0, 35);
  const dStamp = new Date(nowTs).toISOString().replace(/\D/g, '').substring(0, 14);
  const snapId = `snapshot_${dStamp}_${String(nowTs % 1000).padStart(3, '0')}_${slug}`;
  const filename = `${snapId}.json`;
  const filepath = path.join(SNAPSHOTS_DIR, filename);

  const stats = computeSnapshotStats(
    pipeline,
    history,
    includeCompanies && companies && typeof companies === 'object' ? Object.keys(companies).length : 0
  );
  const snapshotDoc = {
    id: snapId,
    name: cleanName || `Snapshot ${dateStr}`,
    type: snap_type,
    timestamp: nowTs,
    date_str: dateStr,
    created_by: created_by || 'User',
    notes: notes || '',
    stats,
    pipeline_state: pipeline,
    call_history: history,
    settings
  };
  if (includeCompanies) {
    snapshotDoc.company_database = companies;
    snapshotDoc.company_metadata = companyMetadata;
  }

  saveJsonAtomic(filepath, snapshotDoc);

  // Auto-prune old auto snapshots
  if (snap_type === 'auto') {
    const all = listAllSnapshots().filter(s => s.type === 'auto');
    if (all.length > 25) {
      for (const old of all.slice(25)) {
        try {
          const oldPath = path.join(SNAPSHOTS_DIR, old.filename);
          fs.unlinkSync(oldPath);
          persistentStore.queueFileDelete(oldPath);
        } catch (_) {}
      }
    }
  }

  return {
    id: snapId,
    filename,
    name: snapshotDoc.name,
    type: snap_type,
    timestamp: nowTs,
    date_str: dateStr,
    created_by: snapshotDoc.created_by,
    notes: snapshotDoc.notes,
    stats,
    size_bytes: fs.statSync(filepath).size
  };
}

function restoreSnapshot(snapIdOrFilename) {
  const resolved = resolveSnapshotFile(snapIdOrFilename);
  if (!resolved) return { err: 'Invalid snapshot id or filename.' };
  const { filepath } = resolved;
  if (!fs.existsSync(filepath)) return { err: `Snapshot '${snapIdOrFilename}' not found.` };

  const doc = loadJsonSafe(filepath, null);
  if (!doc || !doc.pipeline_state) {
    return { err: 'Corrupted snapshot file: missing pipeline_state.' };
  }

  const pipeline = doc.pipeline_state || {};
  const history = doc.call_history || [];
  const settings = normalizeWorkspaceSettings(doc.settings || {});

  saveJsonAtomic(PIPELINE_STATE_FILE, pipeline);
  saveJsonAtomic(CALL_HISTORY_FILE, history);
  saveJsonAtomic(WORKSPACE_SETTINGS_FILE, settings);
  if (doc.company_database && typeof doc.company_database === 'object') {
    const restoredAt = Date.now();
    saveJsonAtomic(OUTPUT_JSON, doc.company_database);
    saveJsonAtomic(METADATA_FILE, {
      ...(doc.company_metadata || {}),
      status: 'restored',
      total_prospects: Object.keys(doc.company_database).length,
      last_updated: restoredAt / 1000,
      last_updated_str: new Date(restoredAt).toISOString(),
      last_restore: { snapshot_id: doc.id || null, restored_at: new Date(restoredAt).toISOString() }
    });
  }

  return {
    res: {
      id: doc.id,
      name: doc.name,
      restored_at: Date.now(),
      stats: computeSnapshotStats(pipeline, history),
      pipeline_state: pipeline,
      call_history: history,
      settings,
      company_database_restored: Boolean(doc.company_database)
    }
  };
}

function cleanResearchCompany(company, crn) {
  const clean = {};
  for (const [key, value] of Object.entries(company || {})) {
    if (RUNTIME_COMPANY_FIELDS.has(key)) continue;
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    clean[key] = value;
  }
  clean.crn = crn;
  clean.prospect_status = String(clean.prospect_status || '').trim().toUpperCase();
  return clean;
}

function validateResearchImportArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return { fatal_error: 'Import file must contain a JSON object.' };
  }
  if (artifact.schema_version !== RESEARCH_IMPORT_SCHEMA) {
    return { fatal_error: `Unsupported import schema. Expected ${RESEARCH_IMPORT_SCHEMA}.` };
  }
  const batchId = String(artifact.batch_id || '').trim();
  if (!batchId || batchId.length > 160) {
    return { fatal_error: 'Import file has a missing or invalid batch_id.' };
  }
  if (!artifact.companies || typeof artifact.companies !== 'object' || Array.isArray(artifact.companies)) {
    return { fatal_error: 'Import file must contain a companies object.' };
  }

  const entries = Object.entries(artifact.companies);
  if (entries.length > MAX_RESEARCH_IMPORT_COMPANIES) {
    return { fatal_error: `Import contains more than ${MAX_RESEARCH_IMPORT_COMPANIES} companies.` };
  }
  if (Number(artifact.company_count) !== entries.length) {
    return { fatal_error: 'Import company_count does not match the companies object.' };
  }

  const currentCompanies = loadJsonSafe(OUTPUT_JSON, {});
  const deletedCrns = new Set(Object.keys(getDeletedCompanies()).map(crn => String(crn).trim().toUpperCase()));
  const accepted = [];
  const rejected = [];
  const seen = new Set();

  for (const [rawKey, rawCompany] of entries) {
    const rawCrn = rawCompany && typeof rawCompany === 'object' ? (rawCompany.crn || rawKey) : rawKey;
    const crn = String(rawCrn || '').trim().toUpperCase();
    const companyName = rawCompany && typeof rawCompany === 'object'
      ? String(rawCompany.company_name || '').trim()
      : '';
    let reason = '';

    if (!rawCompany || typeof rawCompany !== 'object' || Array.isArray(rawCompany)) {
      reason = 'Company record is not an object.';
    } else if (!/^[A-Z0-9]{4,12}$/.test(crn) || crn === 'UNKNOWN') {
      reason = 'Invalid company registration number.';
    } else if (seen.has(crn)) {
      reason = 'Duplicate CRN inside the import file.';
    } else if (deletedCrns.has(crn)) {
      reason = 'Company was deleted in the live app and cannot be resurrected by import.';
    } else if (!companyName) {
      reason = 'Company name is missing.';
    } else {
      const status = String(rawCompany.prospect_status || '').trim().toUpperCase();
      if (!IMPORTABLE_RESEARCH_STATUSES.has(status) || rawCompany.has_full_dossier !== true) {
        reason = 'Record is not a completed research dossier.';
      }
    }

    seen.add(crn);
    if (reason) {
      rejected.push({ crn: crn || String(rawKey), company_name: companyName || 'Unknown', reason });
      continue;
    }

    const company = cleanResearchCompany(rawCompany, crn);
    accepted.push({
      crn,
      company_name: companyName,
      prospect_status: company.prospect_status,
      action: currentCompanies[crn] ? 'update' : 'new',
      company
    });
  }

  const newCount = accepted.filter(item => item.action === 'new').length;
  const updateCount = accepted.length - newCount;
  return {
    fatal_error: null,
    schema_version: artifact.schema_version,
    batch_id: batchId,
    generated_at: artifact.generated_at || null,
    submitted_count: entries.length,
    accepted,
    rejected,
    new_count: newCount,
    update_count: updateCount
  };
}

function publicResearchImportPreview(validation) {
  if (validation.fatal_error) return { error: validation.fatal_error };
  return {
    status: 'preview',
    schema_version: validation.schema_version,
    batch_id: validation.batch_id,
    generated_at: validation.generated_at,
    submitted_count: validation.submitted_count,
    accepted_count: validation.accepted.length,
    new_count: validation.new_count,
    update_count: validation.update_count,
    rejected_count: validation.rejected.length,
    accepted: validation.accepted.map(({ crn, company_name, prospect_status, action }) => ({
      crn, company_name, prospect_status, action
    })),
    rejected: validation.rejected
  };
}

function mergeWorkspaceState(pipelineState, callHistory, replaceHistory = false, authUser = null) {
  const deleted = getDeletedCompanies();
  const deletedCrns = new Set(Object.keys(deleted).map(c => String(c).trim().toUpperCase()));

  if (pipelineState && typeof pipelineState === 'object') {
    const current = loadJsonSafe(PIPELINE_STATE_FILE, {});
    for (const [crn, entry] of Object.entries(pipelineState)) {
      const uCrn = String(crn).trim().toUpperCase();
      if (deletedCrns.has(uCrn) || !entry || typeof entry !== 'object') continue;

      const incomingEntry = { ...entry };
      if (!authUser || authUser.role !== 'handler') {
        delete incomingEntry.jalees_notes;
        delete incomingEntry.jalees_notes_updated_at;
        delete incomingEntry.jalees_notes_updated_by;
      }

      const diskEntry = current[crn];
      if (!diskEntry || typeof diskEntry !== 'object') {
        current[crn] = incomingEntry;
        continue;
      }

      const merged = mergePipelineEntriesByRevision(diskEntry, incomingEntry);

      const inMgrRev = incomingEntry.jalees_notes_updated_at || 0;
      const diskMgrRev = diskEntry.jalees_notes_updated_at || 0;
      const mgrSource = authUser && authUser.role === 'handler' && inMgrRev >= diskMgrRev ? incomingEntry : diskEntry;
      for (const field of ['jalees_notes', 'jalees_notes_updated_at', 'jalees_notes_updated_by']) {
        if (field in mgrSource) merged[field] = mgrSource[field];
      }
      current[crn] = merged;
    }
    saveJsonAtomic(PIPELINE_STATE_FILE, current);
  }

  if (Array.isArray(callHistory)) {
    const filtered = callHistory.filter(item => item && typeof item === 'object' && !deletedCrns.has(String(item.crn || '').trim().toUpperCase()));
    const mayReplace = Boolean(replaceHistory && authUser && authUser.role === 'handler');
    if (mayReplace) {
      const replaced = filtered.map(item => ({ ...item, caller: item.caller || authUser.name }));
      saveJsonAtomic(CALL_HISTORY_FILE, replaced);
    } else {
      const diskHistory = loadJsonSafe(CALL_HISTORY_FILE, []).filter(item => item && typeof item === 'object' && !deletedCrns.has(String(item.crn || '').trim().toUpperCase()));
      const map = new Map();
      for (const item of diskHistory) map.set(String(item.id || item.timestamp), item);
      for (const item of filtered) {
        const key = String(item.id || item.timestamp);
        if (!map.has(key)) map.set(key, { ...item, caller: authUser ? authUser.name : (item.caller || 'User') });
      }
      const merged = Array.from(map.values()).sort((a, b) => (b.id || 0) - (a.id || 0));
      saveJsonAtomic(CALL_HISTORY_FILE, merged);
    }
  }

  return getStateRevision();
}

function getCurrentUser(req) {
  const token = req.cookies && req.cookies.esc_session;
  if (!token) return null;
  const session = AUTH_SESSIONS.get(token);
  if (!session || session.expires_at <= Date.now()) {
    AUTH_SESSIONS.delete(token);
    return null;
  }
  return { username: session.username, name: session.name, role: session.role };
}

function requireAuthenticated(req, res, next) {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required.' });
  req.authUser = user;
  next();
}

function requireHandler(req, res, next) {
  if (!req.authUser || req.authUser.username !== 'jalees' || req.authUser.role !== 'handler') {
    return res.status(403).json({ error: 'Only Jalees can perform this action.' });
  }
  next();
}

function loginAttemptKey(req, username) {
  return `${req.ip || req.socket.remoteAddress || 'unknown'}:${username || 'unknown'}`;
}

function recordFailedLogin(key) {
  const now = Date.now();
  const current = LOGIN_ATTEMPTS.get(key);
  const next = !current || current.resetAt <= now
    ? { count: 1, resetAt: now + LOGIN_WINDOW_MS }
    : { count: current.count + 1, resetAt: current.resetAt };
  LOGIN_ATTEMPTS.set(key, next);
  return next;
}

function clearLoginAttempts(key) {
  LOGIN_ATTEMPTS.delete(key);
}

function resolveSnapshotFile(snapIdOrFilename) {
  const raw = String(snapIdOrFilename || '');
  const filename = raw.endsWith('.json') ? raw : `${raw}.json`;
  if (!/^snapshot_[A-Za-z0-9_-]+\.json$/.test(filename)) return null;
  const filepath = path.join(SNAPSHOTS_DIR, filename);
  return filepath.startsWith(`${SNAPSHOTS_DIR}${path.sep}`) ? { filename, filepath } : null;
}

function sendAppOrLogin(req, res) {
  if (getCurrentUser(req)) {
    return res.sendFile(path.join(SCRIPT_DIR, 'esc_cold_call_copilot.html'));
  }

  return res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ESC Call Desk — Sign in</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f5ff; color: #171529; }
    main { width: min(92vw, 420px); background: white; border: 1px solid #dedcf2; border-radius: 20px; padding: 30px; box-shadow: 0 18px 50px rgba(42,32,95,.12); }
    .mark { width: 48px; height: 48px; display: grid; place-items: center; border-radius: 14px; background: #673de6; color: white; font-weight: 900; margin-bottom: 18px; }
    h1 { margin: 0 0 8px; font-size: 25px; }
    p { margin: 0 0 24px; color: #666078; line-height: 1.5; }
    label { display: block; margin: 14px 0 7px; font-size: 13px; font-weight: 800; }
    select, input, button { width: 100%; min-height: 46px; border-radius: 10px; font: inherit; }
    select, input { border: 1px solid #cbc7df; padding: 0 12px; background: white; }
    button { border: 0; margin-top: 20px; background: #673de6; color: white; font-weight: 850; cursor: pointer; }
    button:disabled { opacity: .65; cursor: wait; }
    #error { min-height: 20px; margin: 12px 0 0; color: #b42318; font-size: 13px; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <div class="mark">E</div>
    <h1>ESC Call Desk</h1>
    <p>Sign in to access company research, calling records and the shared pipeline.</p>
    <form id="loginForm">
      <label for="username">User</label>
      <select id="username" name="username">
        <option value="aroosa">Aroosa</option>
        <option value="jalees">Jalees</option>
      </select>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      <button id="submitButton" type="submit">Sign in</button>
      <div id="error" role="alert" aria-live="polite"></div>
    </form>
  </main>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async function (event) {
      event.preventDefault();
      const button = document.getElementById('submitButton');
      const error = document.getElementById('error');
      button.disabled = true;
      error.textContent = '';
      try {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Sign in failed.');
        window.location.reload();
      } catch (failure) {
        error.textContent = failure.message || 'Sign in failed.';
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`);
}

// ----------------- AUTH ROUTES -----------------
app.get('/api/auth/session', (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = String(username || '').trim().toLowerCase();
  const p = String(password || '');
  const userObj = AUTH_USERS[u];
  const attemptKey = loginAttemptKey(req, u);
  const attempt = LOGIN_ATTEMPTS.get(attemptKey);

  if (attempt && attempt.resetAt > Date.now() && attempt.count >= LOGIN_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }

  if (!userObj || !p || !userObj.passwords.includes(p)) {
    recordFailedLogin(attemptKey);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  clearLoginAttempts(attemptKey);

  const token = crypto.randomBytes(24).toString('base64url');
  AUTH_SESSIONS.set(token, {
    username: u,
    name: userObj.name,
    role: userObj.role,
    expires_at: Date.now() + SESSION_TTL_SECONDS * 1000
  });

  res.cookie('esc_session', token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: COOKIE_SECURE,
    maxAge: SESSION_TTL_SECONDS * 1000
  });

  res.json({ status: 'ok', user: { username: u, name: userObj.name, role: userObj.role } });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies && req.cookies.esc_session;
  if (token) AUTH_SESSIONS.delete(token);
  res.clearCookie('esc_session', { path: '/', httpOnly: true, sameSite: 'strict', secure: COOKIE_SECURE });
  res.json({ status: 'ok' });
});

// Every business-data API below this point requires a valid server session.
app.use('/api', requireAuthenticated);

// ----------------- DATA & WORKSPACE ROUTES -----------------
app.get('/api/status', (req, res) => {
  const meta = loadJsonSafe(METADATA_FILE, {
    status: 'active',
    case_count: 0,
    qualified_count: 0,
    total_prospects: 0,
    last_updated: Math.floor(Date.now() / 1000)
  });
  res.json({ ...meta, persistence: persistentStore.status() });
});

app.get('/api/companies', (req, res) => {
  if (fs.existsSync(OUTPUT_JSON)) {
    return res.json(getVisibleCompanies());
  }
  res.status(404).json({ error: 'Database not compiled' });
});

// Fast startup payload: list/search fields only. Full research remains in
// MySQL-backed storage and is fetched for one selected company at a time.
app.get('/api/company-index', (req, res) => {
  if (!fs.existsSync(OUTPUT_JSON)) {
    return res.status(404).json({ error: 'Database not compiled' });
  }
  res.json(getVisibleCompanyIndex());
});

app.get('/api/company/:crn', (req, res) => {
  const crn = String(req.params.crn || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(crn)) {
    return res.status(400).json({ error: 'Invalid company registration number.' });
  }
  const company = getVisibleCompany(crn);
  if (!company) return res.status(404).json({ error: 'Company not found.' });
  res.json(company);
});

app.get('/api/state', (req, res) => {
  const { pipeline, history, settings, revision } = loadWorkspaceState();
  const stats = computeSnapshotStats(pipeline, history);
  res.json({
    status: 'ok',
    last_updated: Math.floor(revision / 1e6),
    revision,
    stats,
    pipeline_state: pipeline,
    call_history: history,
    settings
  });
});

app.post('/api/state', async (req, res) => {
  const { pipeline_state, call_history, active_user, replace_history, create_snapshot: reqSnap, auto_snapshot } = req.body || {};
  const caller = req.authUser.name;

  mergeWorkspaceState(pipeline_state, call_history, Boolean(replace_history), req.authUser);

  if (reqSnap || auto_snapshot) {
    const snapName = req.body.snapshot_name || `Auto Save by ${caller}`;
    createSnapshot({
      name: snapName,
      notes: req.body.snapshot_notes || '',
      created_by: caller,
      snap_type: 'auto'
    });
  }

  if (!await flushPersistenceOrFail(res)) return;

  const { pipeline, history, settings, revision } = loadWorkspaceState();
  const stats = computeSnapshotStats(pipeline, history);
  res.json({
    status: 'ok',
    saved_at: Date.now(),
    revision,
    settings,
    stats
  });
});

app.get('/api/settings', (req, res) => {
  res.json({ status: 'ok', settings: loadWorkspaceSettings(), revision: getStateRevision() });
});

app.post('/api/settings', requireHandler, async (req, res) => {
  const settings = saveWorkspaceSettings(req.body.settings || req.body);
  if (!await flushPersistenceOrFail(res)) return;
  res.json({ status: 'ok', settings, revision: getStateRevision() });
});

app.post('/api/companies/delete', async (req, res) => {
  const user = req.authUser;
  if (user.username !== 'jalees' || user.role !== 'handler') {
    return res.status(403).json({ error: 'Only Jalees can delete companies.' });
  }

  const crn = String((req.body && req.body.crn) || '').trim().toUpperCase();
  if (!crn || !/^[A-Z0-9]{4,12}$/.test(crn)) {
    return res.status(400).json({ error: 'Invalid company registration number.' });
  }

  const companies = loadJsonSafe(OUTPUT_JSON, {});
  const company = companies[crn];
  if (!company) {
    return res.status(404).json({ error: 'Company not found or already deleted.' });
  }

  const pipeline = loadJsonSafe(PIPELINE_STATE_FILE, {});
  const history = loadJsonSafe(CALL_HISTORY_FILE, []);
  createSnapshot({
    name: `Before deleting ${company.company_name || crn}`,
    notes: `Automatic recovery point before Jalees deleted ${crn}.`,
    created_by: user.name,
    snap_type: 'pre_delete',
    custom_state: pipeline,
    custom_history: history
  });

  const deleted = getDeletedCompanies();
  deleted[crn] = {
    crn,
    company_name: company.company_name || crn,
    deleted_at: Date.now(),
    deleted_by: user.name
  };
  saveJsonAtomic(DELETED_COMPANIES_FILE, deleted);

  delete pipeline[crn];
  saveJsonAtomic(PIPELINE_STATE_FILE, pipeline);

  const cleanHistory = history.filter(item => String(item && item.crn || '').toUpperCase() !== crn);
  saveJsonAtomic(CALL_HISTORY_FILE, cleanHistory);

  if (!await flushPersistenceOrFail(res)) return;
  res.json({ status: 'ok', deleted: deleted[crn], revision: getStateRevision() });
});

app.post('/api/history/clear', requireHandler, async (req, res) => {
  const user = req.authUser;
  const cleared_by = (user && user.name) || (req.body && req.body.active_user) || 'User';

  const history = loadJsonSafe(CALL_HISTORY_FILE, []);
  if (history.length > 0) {
    createSnapshot({
      name: `Before clearing history (${history.length} records)`,
      notes: `Automatic recovery point before call history was cleared by ${cleared_by}.`,
      created_by,
      snap_type: 'pre_clear_history'
    });
  }

  saveJsonAtomic(CALL_HISTORY_FILE, []);
  if (!await flushPersistenceOrFail(res)) return;
  res.json({
    status: 'ok',
    message: 'Call history cleared successfully.',
    revision: getStateRevision(),
    call_history: []
  });
});

// ----------------- SNAPSHOT ROUTES -----------------
app.get('/api/snapshots', (req, res) => {
  const list = listAllSnapshots();
  res.json({ status: 'ok', snapshots: list, total_snapshots: list.length });
});

app.get('/api/snapshots/download', (req, res) => {
  const snapId = req.query.id || req.query.filename;
  if (!snapId) return res.status(400).json({ error: 'Missing snapshot id or filename' });

  const resolved = resolveSnapshotFile(snapId);
  if (!resolved) return res.status(400).json({ error: 'Invalid snapshot id or filename' });
  const { filename, filepath } = resolved;
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Snapshot file not found' });

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  fs.createReadStream(filepath).pipe(res);
});

app.post('/api/snapshots/create', async (req, res) => {
  const { name, notes, created_by, type, pipeline_state, call_history, settings } = req.body || {};
  if (pipeline_state || call_history) {
    mergeWorkspaceState(pipeline_state, call_history, false, req.authUser);
  }
  if (settings && req.authUser.role === 'handler') {
    saveWorkspaceSettings(settings);
  }
  const info = createSnapshot({
    name: name || 'Manual Snapshot',
    notes: notes || '',
    created_by: req.authUser.name,
    snap_type: type || 'manual',
    custom_settings: settings
  });
  if (!await flushPersistenceOrFail(res)) return;
  res.json({ status: 'ok', snapshot: info });
});

app.post('/api/snapshots/restore', requireHandler, async (req, res) => {
  const snapId = req.body.id || req.body.filename;
  if (!snapId) return res.status(400).json({ error: 'Missing snapshot id or filename' });
  if (!resolveSnapshotFile(snapId)) return res.status(400).json({ error: 'Invalid snapshot id or filename' });

  const { res: restored, err } = restoreSnapshot(snapId);
  if (err) return res.status(400).json({ error: err });

  if (!await flushPersistenceOrFail(res)) return;
  res.json({
    status: 'ok',
    message: `Successfully restored snapshot '${restored.name}'.`,
    restored
  });
});

app.post('/api/snapshots/delete', requireHandler, async (req, res) => {
  const snapId = req.body.id || req.body.filename;
  if (!snapId) return res.status(400).json({ error: 'Missing snapshot id or filename' });

  const resolved = resolveSnapshotFile(snapId);
  if (!resolved) return res.status(400).json({ error: 'Invalid snapshot id or filename' });
  const { filepath } = resolved;
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Snapshot not found' });

  try {
    fs.unlinkSync(filepath);
    persistentStore.queueFileDelete(filepath);
    if (!await flushPersistenceOrFail(res)) return;
    res.json({ status: 'ok', message: 'Snapshot deleted.' });
  } catch (e) {
    res.status(500).json({ error: `Failed to delete snapshot: ${e.message}` });
  }
});

app.post('/api/snapshots/upload', requireHandler, async (req, res) => {
  const payload = req.body.snapshot || req.body;
  if (!payload || typeof payload !== 'object' || !payload.pipeline_state) {
    return res.status(400).json({ error: 'Invalid snapshot file format: missing pipeline_state' });
  }

  const nowTs = Date.now();
  const dateStr = new Date(nowTs).toISOString().replace('T', ' ').substring(0, 19);
  const snapName = payload.name || `Imported Snapshot ${dateStr.substring(0, 16)}`;
  const slug = snapName.toLowerCase().replace(/[^a-z0-9_-]/g, '_').substring(0, 30);
  const dStamp = new Date(nowTs).toISOString().replace(/\D/g, '').substring(0, 14);
  const snapId = `snapshot_${dStamp}_${slug}`;
  const filename = `${snapId}.json`;
  const filepath = path.join(SNAPSHOTS_DIR, filename);

  payload.id = snapId;
  payload.timestamp = payload.timestamp || nowTs;
  payload.date_str = payload.date_str || dateStr;
  payload.stats = computeSnapshotStats(payload.pipeline_state || {}, payload.call_history || []);

  saveJsonAtomic(filepath, payload);

  if (req.body.restore_immediately) {
    restoreSnapshot(snapId);
  }

  if (!await flushPersistenceOrFail(res)) return;
  res.json({
    status: 'ok',
    message: 'Snapshot imported successfully.',
    snapshot: {
      id: snapId,
      filename,
      name: snapName,
      type: 'imported',
      timestamp: payload.timestamp,
      date_str: payload.date_str,
      created_by: payload.created_by || 'Imported',
      notes: payload.notes || '',
      stats: payload.stats,
      size_bytes: fs.statSync(filepath).size
    }
  });
});

// ----------------- V9 RESEARCH IMPORT BRIDGE -----------------
app.post('/api/research-import/preview', requireHandler, (req, res) => {
  const validation = validateResearchImportArtifact(req.body && (req.body.artifact || req.body));
  const preview = publicResearchImportPreview(validation);
  if (preview.error) return res.status(400).json(preview);
  res.json(preview);
});

app.post('/api/research-import/commit', requireHandler, async (req, res) => {
  const artifact = req.body && (req.body.artifact || req.body);
  const validation = validateResearchImportArtifact(artifact);
  if (validation.fatal_error) return res.status(400).json({ error: validation.fatal_error });
  if (validation.accepted.length === 0) {
    return res.status(400).json({
      error: 'This import contains no acceptable completed research dossiers.',
      preview: publicResearchImportPreview(validation)
    });
  }

  const currentCompanies = loadJsonSafe(OUTPUT_JSON, {});
  const currentMetadata = loadJsonSafe(METADATA_FILE, {});
  const recoverySnapshot = createSnapshot({
    name: `Before research import ${validation.batch_id}`,
    notes: `Automatic recovery point before Jalees imported ${validation.accepted.length} researched companies.`,
    created_by: req.authUser.name,
    snap_type: 'pre_research_import',
    custom_companies: currentCompanies,
    custom_metadata: currentMetadata,
    include_company_database: true
  });

  const mergedCompanies = { ...currentCompanies };
  for (const item of validation.accepted) {
    const existing = currentCompanies[item.crn] && typeof currentCompanies[item.crn] === 'object'
      ? currentCompanies[item.crn]
      : {};
    const preservedRuntime = {};
    for (const field of RUNTIME_COMPANY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(existing, field)) {
        preservedRuntime[field] = existing[field];
      }
    }
    mergedCompanies[item.crn] = {
      ...existing,
      ...item.company,
      ...preservedRuntime,
      crn: item.crn
    };
  }

  const deletedCrns = new Set(Object.keys(getDeletedCompanies()).map(crn => String(crn).trim().toUpperCase()));
  const visibleCompanies = Object.entries(mergedCompanies)
    .filter(([crn, company]) => company && typeof company === 'object' && !deletedCrns.has(String(crn).trim().toUpperCase()))
    .map(([, company]) => company);
  const now = Date.now();
  const nextMetadata = {
    ...currentMetadata,
    status: 'synced',
    last_updated: now / 1000,
    last_updated_str: new Date(now).toISOString(),
    case_count: visibleCompanies.filter(company => company.has_full_dossier === true).length,
    qualified_count: visibleCompanies.filter(company => company.prospect_status === 'QUALIFIED').length,
    total_prospects: visibleCompanies.length,
    last_import: {
      batch_id: validation.batch_id,
      imported_at: new Date(now).toISOString(),
      imported_by: req.authUser.name,
      accepted_count: validation.accepted.length,
      new_count: validation.new_count,
      update_count: validation.update_count,
      rejected_count: validation.rejected.length
    }
  };

  saveJsonAtomic(OUTPUT_JSON, mergedCompanies);
  saveJsonAtomic(METADATA_FILE, nextMetadata);
  if (!await flushPersistenceOrFail(res)) return;

  res.json({
    ...publicResearchImportPreview(validation),
    status: 'imported',
    metadata: nextMetadata,
    recovery_snapshot: recoverySnapshot
  });
});

// Refreshes the browser from the remote database. New research reaches this
// database through the Jalees-only research-import endpoints above.
app.post('/api/sync', requireHandler, (req, res) => {
  res.json(loadJsonSafe(METADATA_FILE, { status: 'active', last_updated: Math.floor(Date.now() / 1000) }));
});

// ----------------- STATIC APP SHELL -----------------
// Serve only the HTML shell. Business data and state use authenticated APIs.
app.get(['/', '/index.html', '/esc_cold_call_copilot.html'], (req, res) => {
  sendAppOrLogin(req, res);
});

app.get('*', (req, res) => {
  res.status(404).send('Not found');
});

// Auto Snapshot Timer (at most every 5 minutes, and only after state changed)
let lastAutoSnapshotRevision = 0;
setInterval(async () => {
  try {
    const rev = getStateRevision();
    if (rev === lastAutoSnapshotRevision) return;
    createSnapshot({
      name: 'Automatic recovery point',
      notes: 'Periodic host-side backup of the shared workspace.',
      created_by: 'System',
      snap_type: 'auto'
    });
    await persistentStore.flush();
    lastAutoSnapshotRevision = rev;
  } catch (err) {
    console.error('[-] Auto snapshot error:', err.message);
  }
}, 5 * 60 * 1000);

async function startServer() {
  await persistentStore.initialize();
  lastAutoSnapshotRevision = getStateRevision();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[✓] ESC Cold Calling Server running on port ${PORT} (${persistentStore.status().mode})`);
  });
}

startServer().catch(error => {
  console.error('[-] ESC Cold Calling Server failed to start:', error.message);
  process.exit(1);
});
