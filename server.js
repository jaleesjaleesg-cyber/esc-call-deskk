const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { PersistentStore } = require('./persistent_store');
const { CloudResearchBridge } = require('./cloud_research_bridge');
const phoneSearch = require('./phone_search');

const app = express();
const autoCommitRuns = new Map();

// Auto-load .env if present into process.env
const envCandidates = [
  path.join(__dirname, '.env'),
  path.join(process.cwd(), '.env'),
  path.join(__dirname, '../../config/.env')
];
for (const envFile of envCandidates) {
  if (fs.existsSync(envFile)) {
    try {
      const raw = fs.readFileSync(envFile, 'utf8');
      raw.split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          const key = trimmed.slice(0, idx).trim();
          let val = trimmed.slice(idx + 1).trim();
          if ((val.startsWith('\'') && val.endsWith('\'')) || (val.startsWith('"') && val.endsWith('"'))) {
            val = val.slice(1, -1);
          }
          if (process.env[key] === undefined || process.env[key] === '') {
            process.env[key] = val;
          }
        }
      });
    } catch (_) {}
  }
}

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
const cloudResearchBridge = new CloudResearchBridge({
  baseUrl: process.env.ESC_RESEARCH_CONTROL_URL,
  secret: process.env.ESC_RESEARCH_BRIDGE_SECRET,
  timeoutMs: Number(process.env.ESC_RESEARCH_BRIDGE_TIMEOUT_MS || 30000),
  // Production is HTTPS-only. This narrow localhost exception exists solely
  // so the offline integration suite can exercise the signed bridge.
  allowInsecureHttp: process.env.NODE_ENV === 'test' && process.env.ESC_RESEARCH_ALLOW_HTTP === '1'
});

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
const ASSIGNMENT_SOURCES = new Set(['qualified', 'human_review', 'website', 'contactable']);
const BULK_PIPELINE_TARGETS = new Set([
  'todays_targets', 'sia_approved_entries', 'reached',
  'unreachable', 'off_our_list', 'permanently_off_our_list', 'master_list'
]);
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
  'jalees_notes_updated_by',
  'assigned_to',
  'assigned_username',
  'assignment_status',
  'assigned_at',
  'assigned_by',
  'assignment_batch_id',
  'assignment_note',
  'assignment_updated_at'
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
  ,'decision_basis'
  ,'review_owner'
  ,'activity_classifications'
  ,'service_routes'
  ,'service_route'
  ,'reachability'
  ,'website_opportunity'
  ,'evidence_search_exhausted'
  ,'research_batch_id'
  ,'research_imported_at'
  ,'research_imported_by'
  ,'assigned_to'
  ,'assigned_username'
  ,'assignment_status'
  ,'assignment_batch_id'
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
    ['pin_updated_at', 'pinned_at', ['is_pinned', 'pinned_at', 'pinned_by']],
    ['assignment_updated_at', 'assigned_at', [
      'assigned_to', 'assigned_username', 'assignment_status', 'assigned_at',
      'assigned_by', 'assignment_batch_id', 'assignment_note'
    ]]
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

function companyIsContactable(company = {}) {
  if (company.reachability && typeof company.reachability === 'object') {
    return company.reachability.contactable === true;
  }
  const socials = company.social_profiles && typeof company.social_profiles === 'object'
    ? Object.values(company.social_profiles).some(Boolean)
    : false;
  return Boolean(company.phone || company.email || company.website || socials ||
    (Array.isArray(company.phone_numbers) && company.phone_numbers.length));
}

function companyHasWebsiteOpportunity(company = {}) {
  if (company.website_opportunity === true) return true;
  const hasWebsite = Boolean(company.website || (company.reachability && company.reachability.has_website));
  return !hasWebsite && companyIsContactable(company);
}

function companyServiceRoute(company = {}) {
  let route = company.service_route && company.service_route !== 'NONE'
    ? company.service_route
    : (company.is_sia_acs_approved ? 'ACS_MAINTENANCE' : (company.prospect_status === 'QUALIFIED' ? 'ACS_NEW' : 'NONE'));
  if (companyHasWebsiteOpportunity(company)) {
    route = route === 'NONE' ? 'WEBSITE' : 'DUAL';
  }
  return route;
}

function companyMatchesAssignmentSource(company, source) {
  if (company.is_sia_acs_approved) return false;
  if (source === 'qualified') return company.prospect_status === 'QUALIFIED';
  if (source === 'human_review') return company.prospect_status === 'NEEDS_REVIEW' && company.review_owner !== 'RESEARCH_RETRY';
  if (source === 'website') return companyHasWebsiteOpportunity(company);
  return companyIsContactable(company) && ['QUALIFIED', 'NEEDS_REVIEW'].includes(company.prospect_status);
}

function getAssignableCompanies(companies, pipeline, source, specificCrns = []) {
  const specific = new Set(specificCrns);
  return Object.values(companies)
    .filter(company => company && typeof company === 'object')
    .filter(company => !company.is_sia_acs_approved)
    .filter(company => !specific.size || specific.has(String(company.crn || '').toUpperCase()))
    .filter(company => companyMatchesAssignmentSource(company, source))
    .filter(company => {
      const state = pipeline[company.crn] || {};
      const operationalList = state.pipeline_list || (company.rank && company.rank <= 25 ? 'todays_targets' : (company.is_sia_acs_approved ? 'sia_approved_entries' : (company.pipeline_list || 'all_qualified')));
      if (['todays_targets', 'sia_approved_entries', 'contacted', 'reached', 'unreachable', 'off_our_list', 'permanently_off_our_list'].includes(operationalList)) return false;
      return !state.assigned_username || !['assigned', 'in_progress'].includes(state.assignment_status);
    })
    .sort((a, b) => {
      const aRank = Number(a.rank || Number.MAX_SAFE_INTEGER);
      const bRank = Number(b.rank || Number.MAX_SAFE_INTEGER);
      if (aRank !== bRank) return aRank - bRank;
      return Number(b.deterministic_score || 0) - Number(a.deterministic_score || 0);
    });
}

function computeHandlerAnalytics(companies, pipeline, history) {
  const callers = Object.entries(AUTH_USERS)
    .filter(([, user]) => user.role === 'caller')
    .map(([username, user]) => ({ username, name: user.name }));
  const rows = callers.map(caller => {
    const assignments = Object.entries(pipeline).filter(([, state]) => state && state.assigned_username === caller.username);
    const assignedCrns = new Set(assignments.map(([crn]) => crn));
    const calls = (history || []).filter(item => String(item.caller || '').toLowerCase() === caller.name.toLowerCase());
    const attemptedCrns = new Set(calls.filter(item => item.event_type === 'contact_attempt' || Number(item.attempt_number || 0) > 0).map(item => item.crn));
    const reachedCrns = new Set(assignments.filter(([, state]) => state.pipeline_list === 'reached').map(([crn]) => crn));
    return {
      ...caller,
      assigned: assignedCrns.size,
      open: assignments.filter(([, state]) => ['assigned', 'in_progress'].includes(state.assignment_status)).length,
      attempted: Array.from(attemptedCrns).filter(crn => assignedCrns.has(crn)).length,
      reached: reachedCrns.size,
      conversion_rate: assignedCrns.size ? Math.round((reachedCrns.size / assignedCrns.size) * 1000) / 10 : 0,
    };
  });
  const values = Object.values(companies);
  return {
    generated_at: new Date().toISOString(),
    callers: rows,
    inventory: {
      qualified_unassigned: getAssignableCompanies(companies, pipeline, 'qualified').length,
      human_review_unassigned: getAssignableCompanies(companies, pipeline, 'human_review').length,
      website_unassigned: getAssignableCompanies(companies, pipeline, 'website').length,
      active_assignments: Object.values(pipeline).filter(state => state && ['assigned', 'in_progress'].includes(state.assignment_status)).length,
      researched: values.filter(company => company.has_full_dossier === true).length,
      total_companies: values.length,
    },
  };
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

// Snapshot files can be tens of megabytes (research imports include the whole
// company database), so listing caches each file's summary until it changes.
const snapshotSummaryCache = new Map();

function listAllSnapshots() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) return [];
  const files = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.startsWith('snapshot_') && f.endsWith('.json'));
  const snapshots = [];
  const present = new Set(files);
  for (const cached of snapshotSummaryCache.keys()) {
    if (!present.has(cached)) snapshotSummaryCache.delete(cached);
  }
  for (const filename of files) {
    const filepath = path.join(SNAPSHOTS_DIR, filename);
    try {
      const st = fs.statSync(filepath);
      const cached = snapshotSummaryCache.get(filename);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        snapshots.push(cached.summary);
        continue;
      }
      const data = loadJsonSafe(filepath, null);
      if (data) {
        const summary = {
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
        };
        snapshotSummaryCache.set(filename, { mtimeMs: st.mtimeMs, size: st.size, summary });
        snapshots.push(summary);
      }
    } catch (_) {}
  }
  snapshots.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return snapshots;
}

// System-created recovery points are pruned per type. Snapshots a person
// created or uploaded (manual / imported) are never deleted automatically.
const SNAPSHOT_RETENTION = {
  auto: 25,
  pre_research_import: 3,
  pre_restore: 5,
  pre_assignment: 10,
  pre_bulk_move: 10,
  pre_delete: 10,
  pre_clear_history: 5
};

function pruneAutomaticSnapshots(snapType) {
  const keep = SNAPSHOT_RETENTION[snapType];
  if (!keep) return;
  const sameType = listAllSnapshots().filter(s => s.type === snapType);
  for (const old of sameType.slice(keep)) {
    try {
      const oldPath = path.join(SNAPSHOTS_DIR, old.filename);
      fs.unlinkSync(oldPath);
      persistentStore.queueFileDelete(oldPath);
    } catch (_) {}
  }
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
  const companies = includeCompanies
    ? (custom_companies !== null ? custom_companies : loadJsonSafe(OUTPUT_JSON, {}))
    : null;
  const companyMetadata = includeCompanies
    ? (custom_metadata !== null ? custom_metadata : loadJsonSafe(METADATA_FILE, {}))
    : null;

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

  pruneAutomaticSnapshots(snap_type);

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

function restoreSnapshot(snapIdOrFilename, restoredBy = null) {
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
  const restoresCompanies = Boolean(doc.company_database && typeof doc.company_database === 'object');

  // Restoring the wrong snapshot must never be a one-way trip.
  const safetySnapshot = createSnapshot({
    name: `Before restoring ${doc.name || doc.id || 'snapshot'}`,
    notes: 'Automatic recovery point taken immediately before a snapshot restore.',
    created_by: restoredBy || 'System',
    snap_type: 'pre_restore',
    include_company_database: restoresCompanies
  });

  saveJsonAtomic(PIPELINE_STATE_FILE, pipeline);
  saveJsonAtomic(CALL_HISTORY_FILE, history);
  saveJsonAtomic(WORKSPACE_SETTINGS_FILE, settings);
  if (restoresCompanies) {
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
      company_database_restored: restoresCompanies,
      safety_snapshot: safetySnapshot
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
      for (const item of diskHistory) map.set(historyRecordKey(item), item);
      for (const item of filtered) {
        const key = historyRecordKey(item);
        if (!map.has(key)) map.set(key, { ...item, caller: authUser ? authUser.name : (item.caller || 'User') });
      }
      const merged = Array.from(map.values()).sort((a, b) => (b.id || 0) - (a.id || 0));
      saveJsonAtomic(CALL_HISTORY_FILE, merged);
    }
  }

  return getStateRevision();
}

// Two different events can share a millisecond id (for example a caller's log
// and a manager's bulk move). Keying on the company as well stops the merge
// from silently discarding one of them.
function historyRecordKey(item) {
  return `${String(item.id || item.timestamp)}|${String(item.crn || '').trim().toUpperCase()}`;
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
  res.json({ ...meta, workspace_revision: getStateRevision(), persistence: persistentStore.status() });
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

app.get('/api/companies/search', (req, res) => {
  if (!fs.existsSync(OUTPUT_JSON)) {
    return res.status(404).json({ error: 'Database not compiled' });
  }
  const query = String(req.query.q || req.query.phone || '').trim();
  if (!query) {
    return res.json({ query: '', count: 0, results: [] });
  }
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
  const companies = getVisibleCompanies();
  const pipeline = loadJsonSafe(PIPELINE_STATE_FILE, {});
  const liveList = company => (pipeline[company.crn] && pipeline[company.crn].pipeline_list) || company.pipeline_list || 'all_qualified';

  // Search by mobile or landline phone
  const phoneMatches = phoneSearch.searchCompaniesByPhone(companies, query, limit);
  if (phoneMatches.length > 0) {
    return res.json({
      query,
      type: 'phone',
      count: phoneMatches.length,
      results: phoneMatches.map(({ company, match }) => ({
        crn: company.crn,
        company_name: company.company_name,
        matched_phone: match.number,
        is_mobile: match.isMobile,
        phone_purpose: match.purpose,
        dm_name: match.dmName,
        dm_role: match.dmRole,
        pipeline_list: liveList(company)
      }))
    });
  }

  // Fallback to name/crn search
  const lowerQuery = query.toLowerCase();
  const textMatches = [];
  for (const [crn, company] of Object.entries(companies)) {
    if (crn.toLowerCase().includes(lowerQuery) || (company.company_name && company.company_name.toLowerCase().includes(lowerQuery))) {
      textMatches.push({
        crn: company.crn,
        company_name: company.company_name,
        matched_phone: company.phone || '',
        pipeline_list: liveList(company)
      });
      if (textMatches.length >= limit) break;
    }
  }

  res.json({
    query,
    type: 'text',
    count: textMatches.length,
    results: textMatches
  });
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
    server_time: Date.now(),
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
    server_time: Date.now(),
    revision,
    settings,
    stats
  });
});

app.get('/api/callers', requireHandler, (req, res) => {
  const callers = Object.entries(AUTH_USERS)
    .filter(([, user]) => user.role === 'caller')
    .map(([username, user]) => ({ username, name: user.name, role: user.role }));
  res.json({ status: 'ok', callers });
});

app.get('/api/handler/analytics', requireHandler, (req, res) => {
  const companies = getVisibleCompanies();
  const pipeline = loadJsonSafe(PIPELINE_STATE_FILE, {});
  const history = loadJsonSafe(CALL_HISTORY_FILE, []);
  res.json({ status: 'ok', analytics: computeHandlerAnalytics(companies, pipeline, history) });
});

app.post('/api/assignments', requireHandler, async (req, res) => {
  const body = req.body || {};
  const callerUsername = String(body.caller_username || '').trim().toLowerCase();
  const caller = AUTH_USERS[callerUsername];
  const source = String(body.source || 'qualified').trim().toLowerCase();
  const count = Math.min(500, Math.max(1, Number.parseInt(body.count, 10) || 25));
  const previewOnly = body.preview_only === true;
  const specificCrns = Array.isArray(body.crns)
    ? Array.from(new Set(body.crns.map(value => String(value || '').trim().toUpperCase()).filter(Boolean)))
    : [];

  if (!caller || caller.role !== 'caller') {
    return res.status(400).json({ error: 'Choose a configured caller account.' });
  }
  if (!ASSIGNMENT_SOURCES.has(source)) {
    return res.status(400).json({ error: 'Choose a valid assignment source.' });
  }
  if (specificCrns.length > 500) {
    return res.status(400).json({ error: 'A single assignment batch cannot exceed 500 companies.' });
  }

  const companies = getVisibleCompanies();
  const pipeline = loadJsonSafe(PIPELINE_STATE_FILE, {});
  const history = loadJsonSafe(CALL_HISTORY_FILE, []);
  const eligible = getAssignableCompanies(companies, pipeline, source, specificCrns).slice(0, count);
  const publicCompanies = eligible.map(company => ({
    crn: company.crn,
    company_name: company.company_name,
    rank: company.rank || null,
    deterministic_score: company.deterministic_score || 0,
    prospect_status: company.prospect_status,
    service_route: companyServiceRoute(company),
    website_opportunity: companyHasWebsiteOpportunity(company),
  }));

  if (previewOnly) {
    return res.json({
      status: 'preview', caller: { username: callerUsername, name: caller.name }, source,
      requested_count: count, eligible_count: eligible.length, companies: publicCompanies,
    });
  }
  if (!eligible.length) return res.status(400).json({ error: 'No unassigned companies match this cohort.' });

  const assignedAt = Date.now();
  const batchId = `assignment-${assignedAt}-${callerUsername}`;
  const recoverySnapshot = createSnapshot({
    name: `Before assigning ${eligible.length} companies to ${caller.name}`,
    notes: `Recovery point before ${req.authUser.name} created ${batchId}.`,
    created_by: req.authUser.name,
    snap_type: 'pre_assignment',
    custom_state: pipeline,
    custom_history: history,
  });

  eligible.forEach((company, index) => {
    const existing = pipeline[company.crn] && typeof pipeline[company.crn] === 'object' ? pipeline[company.crn] : {};
    pipeline[company.crn] = {
      ...existing,
      pipeline_list: 'todays_targets',
      assigned_to: caller.name,
      assigned_username: callerUsername,
      assignment_status: 'assigned',
      assigned_at: assignedAt,
      assigned_by: req.authUser.name,
      assignment_batch_id: batchId,
      assignment_note: String(body.note || '').trim().slice(0, 500),
      pipeline_updated_at: assignedAt,
      assignment_updated_at: assignedAt,
      last_updated: Math.max(Number(existing.last_updated || 0), assignedAt),
    };
    history.unshift({
      id: assignedAt + index,
      timestamp: new Date(assignedAt).toLocaleString('en-GB'),
      isoDate: new Date(assignedAt).toISOString().slice(0, 10),
      caller: req.authUser.name,
      assigned_to: caller.name,
      crn: company.crn,
      company_name: company.company_name || company.crn,
      transition: 'todays_targets',
      outcome: `Assigned to ${caller.name} (Today's Targets)`,
      notes: String(body.note || '').trim(),
      list: 'todays_targets',
      event_type: 'assignment',
      assignment_batch_id: batchId,
      attempt_number: Number(existing.contact_attempts || 0),
    });
  });

  saveJsonAtomic(PIPELINE_STATE_FILE, pipeline);
  saveJsonAtomic(CALL_HISTORY_FILE, history);
  if (!await flushPersistenceOrFail(res)) return;
  res.json({
    status: 'assigned', batch_id: batchId, assigned_count: eligible.length,
    caller: { username: callerUsername, name: caller.name }, source,
    companies: publicCompanies, recovery_snapshot: recoverySnapshot,
    pipeline_state: pipeline, call_history: history, revision: getStateRevision(),
  });
});

app.post('/api/pipeline/bulk', requireHandler, async (req, res) => {
  const targetList = String((req.body && req.body.target_list) || '').trim();
  const requestedCrns = Array.isArray(req.body && req.body.crns) ? req.body.crns : [];
  const crns = Array.from(new Set(requestedCrns
    .map(value => String(value || '').trim().toUpperCase())
    .filter(value => /^[A-Z0-9]{4,12}$/.test(value))));

  if (!BULK_PIPELINE_TARGETS.has(targetList)) {
    return res.status(400).json({ error: 'Invalid bulk destination list.' });
  }
  if (!crns.length || crns.length > 2500) {
    return res.status(400).json({ error: 'Choose between 1 and 2500 valid companies.' });
  }

  const companies = getVisibleCompanies();
  const pipeline = loadJsonSafe(PIPELINE_STATE_FILE, {});
  const history = loadJsonSafe(CALL_HISTORY_FILE, []);
  const accepted = crns.filter(crn => companies[crn]);
  const rejected = crns.filter(crn => !companies[crn]);
  if (!accepted.length) return res.status(404).json({ error: 'None of the selected companies exist.' });

  const recoverySnapshot = createSnapshot({
    name: `Before bulk move of ${accepted.length} companies`,
    notes: `Recovery point before ${req.authUser.name} moved companies to ${targetList}.`,
    created_by: req.authUser.name,
    snap_type: 'pre_bulk_move',
    custom_state: pipeline,
    custom_history: history
  });

  const movedAt = Date.now();
  accepted.forEach((crn, index) => {
    const existing = pipeline[crn] && typeof pipeline[crn] === 'object' ? pipeline[crn] : {};
    pipeline[crn] = {
      ...existing,
      pipeline_list: targetList,
      pipeline_updated_at: movedAt,
      last_updated: Math.max(Number(existing.last_updated || 0), movedAt),
      last_caller: req.authUser.name
    };
    history.unshift({
      id: movedAt + index,
      timestamp: new Date(movedAt).toLocaleString('en-GB'),
      isoDate: new Date(movedAt).toISOString().slice(0, 10),
      caller: req.authUser.name,
      crn,
      company_name: companies[crn].company_name || crn,
      decision_maker: '—',
      phone_used: '—',
      transition: targetList,
      outcome: `Bulk moved to ${targetList}`,
      notes: `Bulk action by ${req.authUser.name}`,
      list: targetList,
      event_type: 'bulk_move',
      attempt_number: Number(existing.contact_attempts || 0)
    });
  });

  saveJsonAtomic(PIPELINE_STATE_FILE, pipeline);
  saveJsonAtomic(CALL_HISTORY_FILE, history);
  if (!await flushPersistenceOrFail(res)) return;
  res.json({
    status: 'ok',
    moved_count: accepted.length,
    rejected_crns: rejected,
    target_list: targetList,
    recovery_snapshot: recoverySnapshot,
    pipeline_state: pipeline,
    call_history: history,
    revision: getStateRevision()
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
      created_by: cleared_by,
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

  const { res: restored, err } = restoreSnapshot(snapId, req.authUser.name);
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
  const snapId = `snapshot_${dStamp}_${String(nowTs % 1000).padStart(3, '0')}_${slug}`;
  const filename = `${snapId}.json`;
  const filepath = path.join(SNAPSHOTS_DIR, filename);

  payload.id = snapId;
  payload.timestamp = payload.timestamp || nowTs;
  payload.date_str = payload.date_str || dateStr;
  payload.stats = computeSnapshotStats(payload.pipeline_state || {}, payload.call_history || []);

  saveJsonAtomic(filepath, payload);

  let restoreError = null;
  if (req.body.restore_immediately) {
    restoreError = restoreSnapshot(snapId, req.authUser.name).err || null;
  }

  if (!await flushPersistenceOrFail(res)) return;
  if (restoreError) {
    return res.status(400).json({ error: `Snapshot was imported but could not be restored: ${restoreError}` });
  }
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

async function commitResearchImportArtifact(artifact, authUser) {
  const validation = validateResearchImportArtifact(artifact);
  if (validation.fatal_error) {
    const error = new Error(validation.fatal_error);
    error.statusCode = 400;
    throw error;
  }
  if (validation.accepted.length === 0) {
    const error = new Error('This import contains no acceptable completed research dossiers.');
    error.statusCode = 400;
    error.preview = publicResearchImportPreview(validation);
    throw error;
  }

  const currentCompanies = loadJsonSafe(OUTPUT_JSON, {});
  const currentMetadata = loadJsonSafe(METADATA_FILE, {});
  const recoverySnapshot = createSnapshot({
    name: `Before research import ${validation.batch_id}`,
    notes: `Automatic recovery point before Jalees imported ${validation.accepted.length} researched companies.`,
    created_by: authUser.name,
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
      crn: item.crn,
      research_batch_id: validation.batch_id,
      research_imported_at: new Date().toISOString(),
      research_imported_by: authUser.name
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
      imported_by: authUser.name,
      accepted_count: validation.accepted.length,
      new_count: validation.new_count,
      update_count: validation.update_count,
      rejected_count: validation.rejected.length
    }
  };

  saveJsonAtomic(OUTPUT_JSON, mergedCompanies);
  saveJsonAtomic(METADATA_FILE, nextMetadata);
  await persistentStore.flush();

  return {
    ...publicResearchImportPreview(validation),
    status: 'imported',
    metadata: nextMetadata,
    recovery_snapshot: recoverySnapshot
  };
}

function sendResearchError(res, error) {
  const statusCode = Number(error && error.statusCode) || 502;
  return res.status(statusCode >= 400 && statusCode <= 599 ? statusCode : 502).json({
    error: (error && error.message) || 'Research service request failed.',
    ...(error && error.preview ? { preview: error.preview } : {})
  });
}

app.post('/api/research-import/commit', requireHandler, async (req, res) => {
  try {
    const artifact = req.body && (req.body.artifact || req.body);
    res.json(await commitResearchImportArtifact(artifact, req.authUser));
  } catch (error) {
    sendResearchError(res, error);
  }
});

// ----------------- AZURE V9 RESEARCH CONTROL -----------------
// These routes proxy requests server-to-server. The browser never receives the
// bridge secret, approval email, Azure storage credentials, or a job-start API.
app.get('/api/research-cloud/config', (req, res) => {
  res.json({
    configured: cloudResearchBridge.isConfigured(),
    approval_location: 'Azure-hosted approval page',
    one_active_run: true
  });
});

function computeRunProgress(run) {
  if (!run || typeof run !== 'object') return 0;
  const status = String(run.status || '').toUpperCase();
  if (['COMPLETED', 'PARTIAL_SUCCESS'].includes(status)) return 100;
  if (['FAILED', 'DENIED', 'EXPIRED', 'APPROVAL_LOCKED', 'RETRY_APPROVAL_REQUIRED', 'EMAIL_FAILED'].includes(status)) return 0;
  if (status === 'PENDING_APPROVAL') return 0;
  if (['APPROVED_ENQUEUEING', 'QUEUED'].includes(status)) return 5;

  const progress = run.progress || {};
  const total = Number(progress.total || (run.parameters && run.parameters.count) || 0);
  const completed = Number(progress.completed || 0);
  if (total > 0 && completed > 0) {
    return Math.min(99, Math.max(10, Math.round((completed / total) * 100)));
  }
  return 10;
}

// A failed commit is retried with a growing delay, never in a tight loop:
// each attempt takes a full-database recovery snapshot.
const AUTO_COMMIT_MAX_ATTEMPTS = 3;
const AUTO_COMMIT_RETRY_MS = 60 * 1000;

async function checkAndAutoCommitRun(run, authUser) {
  if (!run || !run.run_id) return run;
  const status = String(run.status || '').toUpperCase();
  const runId = run.run_id;
  const entry = autoCommitRuns.get(runId);
  const isComplete = ['COMPLETED', 'PARTIAL_SUCCESS'].includes(status);

  run.completion_percentage = computeRunProgress(run);

  if (entry && entry.committed) {
    run.auto_committed = true;
    run.commit_result = entry.commitResult;
    return run;
  }

  if (entry && entry.failed && entry.lastError) run.auto_commit_error = entry.lastError;
  if (isComplete && entry && !entry.committed && !entry.isCommitting && !entry.failed && !(entry.retryAfter > Date.now())) {
    entry.isCommitting = true;
    try {
      console.log(`[AutoCommit] Run ${runId} finished. Fetching artifact and updating database in one step...`);
      const artifact = await cloudResearchBridge.getArtifact(runId);
      const commitResult = await commitResearchImportArtifact(artifact, authUser || { name: entry.requested_by || 'Jalees' });
      entry.committed = true;
      entry.commitResult = commitResult;
      run.auto_committed = true;
      run.commit_result = commitResult;
      console.log(`[✓] AutoCommit complete for ${runId}: ${commitResult.accepted_count} companies integrated.`);
    } catch (err) {
      entry.commitAttempts = (entry.commitAttempts || 0) + 1;
      entry.lastError = err.message;
      if (entry.commitAttempts >= AUTO_COMMIT_MAX_ATTEMPTS) {
        entry.failed = true;
        console.error(`[-] AutoCommit gave up on ${runId} after ${entry.commitAttempts} attempts. Use the manual commit button.`);
      } else {
        entry.retryAfter = Date.now() + AUTO_COMMIT_RETRY_MS * entry.commitAttempts;
      }
      console.error(`[-] AutoCommit failed for ${runId}:`, err.message);
      run.auto_commit_error = err.message;
    } finally {
      entry.isCommitting = false;
    }
  }
  return run;
}

app.post('/api/research-cloud/requests', async (req, res) => {
  try {
    const parameters = req.body && req.body.parameters ? req.body.parameters : (req.body || {});
    const result = await cloudResearchBridge.requestRun(req.authUser.name, parameters);
    res.status(202).json(result);
  } catch (error) {
    sendResearchError(res, error);
  }
});

app.post('/api/research-cloud/runs/:runId/approve', requireHandler, async (req, res) => {
  try {
    const runId = req.params.runId;
    const otp = String(req.body && req.body.otp ? req.body.otp : '').trim();
    if (!/^\d{8}$/.test(otp)) {
      return res.status(400).json({ error: 'Please enter the 8-digit verification code sent to your email.' });
    }
    const result = await cloudResearchBridge.approveRun(runId, otp);
    // Register for automatic commit in one single seamless pipeline
    autoCommitRuns.set(runId, {
      requested_by: req.authUser.name,
      committed: false,
      auto_commit: true,
      approved_at: Date.now()
    });
    result.auto_commit_enabled = true;
    result.completion_percentage = 5;
    res.json(result);
  } catch (error) {
    sendResearchError(res, error);
  }
});

app.get('/api/research-cloud/runs', async (req, res) => {
  try {
    const listResult = await cloudResearchBridge.listRuns(req.query.limit);
    const runs = listResult.runs || [];
    const enriched = await Promise.all(runs.map(run => checkAndAutoCommitRun(run, req.authUser)));
    res.json({ runs: enriched });
  } catch (error) {
    sendResearchError(res, error);
  }
});

app.get('/api/research-cloud/runs/:runId', async (req, res) => {
  try {
    const rawRun = await cloudResearchBridge.getRun(req.params.runId);
    const run = await checkAndAutoCommitRun(rawRun, req.authUser);
    res.json(run);
  } catch (error) {
    sendResearchError(res, error);
  }
});

app.post('/api/research-cloud/runs/:runId/preview', requireHandler, async (req, res) => {
  try {
    const artifact = await cloudResearchBridge.getArtifact(req.params.runId);
    const validation = validateResearchImportArtifact(artifact);
    const preview = publicResearchImportPreview(validation);
    if (preview.error) return res.status(400).json(preview);
    res.json({ ...preview, cloud_run_id: req.params.runId });
  } catch (error) {
    sendResearchError(res, error);
  }
});

app.post('/api/research-cloud/runs/:runId/commit', requireHandler, async (req, res) => {
  try {
    const artifact = await cloudResearchBridge.getArtifact(req.params.runId);
    const result = await commitResearchImportArtifact(artifact, req.authUser);
    res.json({ ...result, cloud_run_id: req.params.runId });
  } catch (error) {
    sendResearchError(res, error);
  }
});


// Refreshes the browser from the remote database. New research reaches this
// database through the Jalees-only research-import endpoints above.
app.post('/api/sync', requireHandler, (req, res) => {
  res.json(loadJsonSafe(METADATA_FILE, { status: 'active', last_updated: Math.floor(Date.now() / 1000) }));
});

// ----------------- STATIC APP SHELL -----------------
// Serve only authenticated code assets. Business data and state use authenticated APIs.
app.get('/phone_search.js', (req, res) => {
  if (!getCurrentUser(req)) return res.status(401).type('text').send('Authentication required.');
  res.type('application/javascript').sendFile(path.join(SCRIPT_DIR, 'phone_search.js'));
});

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

// Background Auto-Commit Poller

// When a research pipeline finishes in the cloud, automatically download,
// validate, and commit the new records without requiring manual intervention.
setInterval(async () => {
  if (autoCommitRuns.size === 0) return;
  for (const [runId, entry] of autoCommitRuns.entries()) {
    if (entry.committed || entry.isCommitting || entry.failed) continue;
    if (entry.retryAfter && entry.retryAfter > Date.now()) continue;
    try {
      const run = await cloudResearchBridge.getRun(runId);
      const status = String(run.status || '').toUpperCase();
      if (['COMPLETED', 'PARTIAL_SUCCESS'].includes(status)) {
        await checkAndAutoCommitRun(run, { name: entry.requested_by || 'Jalees' });
      } else if (['FAILED', 'DENIED', 'EXPIRED', 'APPROVAL_LOCKED', 'RETRY_APPROVAL_REQUIRED', 'EMAIL_FAILED'].includes(status)) {
        entry.failed = true;
        entry.lastError = `Cloud run ended with status ${status}.`;
      }
    } catch (_) {
      // Ignore background transient errors
    }
  }
}, 5000);

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
