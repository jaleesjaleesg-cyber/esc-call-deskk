const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { PersistentStore } = require('./persistent_store');
const phoneSearch = require('./phone_search');
const { CloudResearchBridge, signRequest } = require('./cloud_research_bridge');

const PROJECT_DIR = __dirname;

test('phone search resolves UK callback-number formatting variants and mobile numbers', () => {
  const company = {
    crn: 'TEST001',
    company_name: 'Alpha Security Ltd',
    phone: '01234 567 890',
    phone_numbers: [{ number: '+44 (0) 7700 900123', purpose: 'Director mobile', type: 'mobile' }],
    decision_makers: [{ name: 'Example Director', phone: '020 7946 0999', mobile: '07890 123456' }]
  };

  assert.equal(phoneSearch.normalizeUkPhone('+44 1234 567890'), '01234567890');
  assert.equal(phoneSearch.normalizeUkPhone('0044 1234 567890'), '01234567890');
  assert.equal(phoneSearch.normalizeUkPhone('+44 (0) 7700 900123'), '07700900123');
  assert.equal(phoneSearch.matchingPhone(company, '+44 1234 567890'), '01234 567 890');
  assert.equal(phoneSearch.matchingPhone(company, '7700900123'), '+44 (0) 7700 900123');
  assert.equal(phoneSearch.matchingPhone(company, '7946 0999'), '020 7946 0999');
  assert.equal(phoneSearch.matchingPhone(company, '07890123456'), '07890 123456');
  assert.equal(phoneSearch.companyMatchesPhone(company, '555555'), false);
  assert.equal(phoneSearch.companyMatchesPhone(company, ''), false);

  // Mobile number identification
  assert.equal(phoneSearch.isUkMobile('07700 900123'), true);
  assert.equal(phoneSearch.isUkMobile('+44 7890 123456'), true);
  assert.equal(phoneSearch.isUkMobile('020 7946 0999'), false);
  assert.equal(phoneSearch.isUkMobile('01234 567890'), false);

  // Structured search by phone
  const searchResults = phoneSearch.searchCompaniesByPhone({ TEST001: company }, '07890123456');
  assert.equal(searchResults.length, 1);
  assert.equal(searchResults[0].company.crn, 'TEST001');
  assert.equal(searchResults[0].match.isMobile, true);
  assert.equal(searchResults[0].match.dmName, 'Example Director');
});

test('cloud bridge signs requests, approves runs, and keeps its shared secret server-side', async t => {
  const secret = 'offline-bridge-secret';
  const requests = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const expected = signRequest(
        secret,
        req.method,
        req.url,
        req.headers['x-esc-timestamp'],
        req.headers['x-esc-nonce'],
        body
      );
      requests.push({ req, body, expected });
      res.writeHead(req.headers['x-esc-signature'] === expected ? 202 : 401, { 'Content-Type': 'application/json' });
      if (req.url.includes('/approve/')) {
        res.end(JSON.stringify({ status: 'QUEUED', run_id: 'run-offline-test' }));
      } else {
        res.end(JSON.stringify({ status: 'PENDING_APPROVAL', run_id: 'run-offline-test' }));
      }
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());

  const address = upstream.address();
  const bridge = new CloudResearchBridge({
    baseUrl: `http://127.0.0.1:${address.port}`,
    secret,
    allowInsecureHttp: true
  });
  const result = await bridge.requestRun('Aroosa', {
    mode: 'workflow', count: 1, concurrency: 1, sic: '80100', location: ''
  });
  await bridge.listRuns(7);
  const approveResult = await bridge.approveRun('run-offline-test', '12345678');

  assert.equal(result.status, 'PENDING_APPROVAL');
  assert.equal(approveResult.status, 'QUEUED');
  assert.equal(requests.length, 3);
  assert.equal(requests[0].req.headers['x-esc-signature'], requests[0].expected);
  assert.equal(requests[1].req.url, '/v1/runs?limit=7');
  assert.equal(requests[2].req.url, '/v1/approve/run-offline-test');
  assert.equal(requests[2].req.headers['x-esc-signature'], requests[2].expected);
  assert.equal(requests[0].body.toString().includes(secret), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(new CloudResearchBridge({ baseUrl: 'http://example.com', secret }).isConfigured(), false);
});

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
      pipeline_list: 'reached', call_notes: 'Preserve this live note', is_pinned: true,
      decision_makers: [{ name: 'Example Director', role: 'Director' }],
      investigation_report_preview: 'Short research preview.',
      investigation_report_full: '# Full private research dossier\nDetailed evidence.'
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
  assert.equal((await fetch(`${baseUrl}/api/company-index`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/company/KEEP123`)).status, 401);
  const cookie = await login(baseUrl, 'jalees', 'jalees');
  const aroosaCookie = await login(baseUrl, 'aroosa', 'aroosa');

  let response = await api(baseUrl, cookie, '/api/companies');
  let companies = await response.json();
  assert.deepEqual(Object.keys(companies).sort(), ['KEEP123', 'TEST123']);

  response = await api(baseUrl, cookie, '/api/company-index');
  const companyIndex = await response.json();
  assert.deepEqual(Object.keys(companyIndex).sort(), ['KEEP123', 'TEST123']);
  assert.equal(companyIndex.KEEP123._summary_only, true);
  assert.equal(companyIndex.KEEP123.investigation_report_full, undefined);
  assert.equal(companyIndex.KEEP123.decision_makers[0].name, 'Example Director');

  response = await api(baseUrl, cookie, '/api/company/KEEP123');
  const companyDetail = await response.json();
  assert.equal(companyDetail.investigation_report_full, '# Full private research dossier\nDetailed evidence.');

  response = await api(baseUrl, cookie, '/api/companies/delete', {
    method: 'POST',
    body: JSON.stringify({ crn: 'TEST123' })
  });
  assert.equal(response.status, 200);

  response = await api(baseUrl, cookie, '/api/companies');
  companies = await response.json();
  assert.deepEqual(Object.keys(companies), ['KEEP123']);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dataDir, 'deleted_companies.json'), 'utf8')).TEST123);

  response = await api(baseUrl, cookie, '/api/company/TEST123');
  assert.equal(response.status, 404);

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
  assert.equal(companies.NEW123.research_batch_id, 'node-test-batch');
  assert.equal(companies.NEW123.research_imported_by, 'Jalees');

  response = await api(baseUrl, cookie, '/api/company/KEEP123');
  assert.equal((await response.json()).company_name, 'Keep Me Security Ltd');

  const importSnapshots = fs.readdirSync(path.join(dataDir, 'snapshots'))
    .map(filename => JSON.parse(fs.readFileSync(path.join(dataDir, 'snapshots', filename), 'utf8')))
    .filter(snapshot => snapshot.type === 'pre_research_import');
  assert.equal(importSnapshots.length, 1);
  assert.ok(importSnapshots[0].company_database.KEEP123);
  assert.equal(importSnapshots[0].company_database.NEW123, undefined);

  response = await api(baseUrl, aroosaCookie, '/api/assignments', {
    method: 'POST', body: JSON.stringify({ caller_username: 'aroosa', source: 'qualified', count: 2, preview_only: true })
  });
  assert.equal(response.status, 403);

  response = await api(baseUrl, cookie, '/api/assignments', {
    method: 'POST', body: JSON.stringify({ caller_username: 'aroosa', source: 'qualified', count: 2, preview_only: true })
  });
  assert.equal(response.status, 200);
  const assignmentPreview = await response.json();
  assert.equal(assignmentPreview.status, 'preview');
  assert.equal(assignmentPreview.eligible_count, 1);
  assert.equal(assignmentPreview.companies[0].service_route, 'DUAL');

  response = await api(baseUrl, cookie, '/api/assignments', {
    method: 'POST', body: JSON.stringify({ caller_username: 'aroosa', source: 'qualified', count: 2, note: 'Morning ACS campaign' })
  });
  assert.equal(response.status, 200);
  const assignmentResult = await response.json();
  assert.equal(assignmentResult.assigned_count, 1);
  assert.equal(assignmentResult.pipeline_state.NEW123.assigned_username, 'aroosa');
  assert.equal(assignmentResult.pipeline_state.NEW123.assignment_status, 'assigned');
  assert.equal(assignmentResult.pipeline_state.NEW123.pipeline_list, 'todays_targets');
  assert.equal(assignmentResult.call_history[0].event_type, 'assignment');
  assert.equal(assignmentResult.call_history[0].transition, 'todays_targets');
  assert.ok(assignmentResult.recovery_snapshot.id);

  response = await api(baseUrl, cookie, '/api/handler/analytics');
  assert.equal(response.status, 200);
  const analytics = (await response.json()).analytics;
  assert.equal(analytics.callers.find(item => item.username === 'aroosa').assigned, 1);
  assert.equal(analytics.inventory.active_assignments, 1);

  response = await api(baseUrl, cookie, '/api/snapshots/restore', {
    method: 'POST',
    body: JSON.stringify({ id: importResult.recovery_snapshot.id })
  });
  assert.equal(response.status, 200);
  const restoredImport = await response.json();
  assert.equal(restoredImport.restored.company_database_restored, true);

  response = await api(baseUrl, cookie, '/api/companies');
  companies = await response.json();
  assert.deepEqual(Object.keys(companies), ['KEEP123']);
  assert.equal(companies.KEEP123.company_name, 'Keep Me Ltd');
  assert.equal(companies.KEEP123.prospect_status, 'REGISTRY_PROSPECT');

  response = await api(baseUrl, cookie, '/api/state', {
    method: 'POST',
    body: JSON.stringify({
      pipeline_state: {
        MERGE001: {
          pipeline_list: 'reached', contact_attempts: 1, pipeline_updated_at: 300,
          call_notes: 'older note', notes_updated_at: 100,
          is_pinned: true, pin_updated_at: 250,
          assigned_to: 'Aroosa', assigned_username: 'aroosa', assignment_status: 'assigned',
          assignment_batch_id: 'batch-new', assignment_updated_at: 350, last_updated: 350
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
  assert.equal(merged.assigned_username, 'aroosa');
  assert.equal(merged.assignment_batch_id, 'batch-new');

  response = await api(baseUrl, aroosaCookie, '/api/pipeline/bulk', {
    method: 'POST',
    body: JSON.stringify({ crns: ['KEEP123'], target_list: 'todays_targets' })
  });
  assert.equal(response.status, 403);

  response = await api(baseUrl, cookie, '/api/pipeline/bulk', {
    method: 'POST',
    body: JSON.stringify({ crns: ['KEEP123'], target_list: 'all_qualified' })
  });
  assert.equal(response.status, 400);

  response = await api(baseUrl, cookie, '/api/pipeline/bulk', {
    method: 'POST',
    body: JSON.stringify({ crns: ['KEEP123', 'MISSING999'], target_list: 'todays_targets' })
  });
  assert.equal(response.status, 200);
  const bulkResult = await response.json();
  assert.equal(bulkResult.moved_count, 1);
  assert.deepEqual(bulkResult.rejected_crns, ['MISSING999']);
  assert.equal(bulkResult.pipeline_state.KEEP123.pipeline_list, 'todays_targets');
  assert.equal(bulkResult.call_history[0].event_type, 'bulk_move');
  const bulkSnapshot = JSON.parse(fs.readFileSync(
    path.join(dataDir, 'snapshots', bulkResult.recovery_snapshot.filename), 'utf8'
  ));
  assert.equal(bulkSnapshot.type, 'pre_bulk_move');
  assert.notEqual(bulkSnapshot.pipeline_state.KEEP123 && bulkSnapshot.pipeline_state.KEEP123.pipeline_list, 'todays_targets');

  response = await api(baseUrl, cookie, '/api/status');
  const status = await response.json();
  assert.equal(status.persistence.mode, 'json-files');
  assert.ok(Number(status.workspace_revision) > 0);
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

test('database-required mode rejects a code-only release before the company database is seeded', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-node-unseeded-db-'));
  const snapshotsDir = path.join(dataDir, 'snapshots');
  fs.mkdirSync(snapshotsDir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const store = new PersistentStore({ dataDir, snapshotsDir });
  store.required = true;
  store.pool = {
    execute: async () => [[]]
  };

  await assert.rejects(
    () => store.hydrateOrSeedState(),
    /one-time data migration before enabling code-only GitHub deployments/
  );
});
