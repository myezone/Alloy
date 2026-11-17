/*
 * Russ Community Credit Union (Demo): digital account opening
 *
 * This file plays the role of the credit union's ESB / API layer (think MuleSoft).
 * The browser never talks to Alloy and never sees Alloy credentials. It calls this
 * service, and this service calls Alloy's Journeys API.
 *
 *   Browser  ->  POST /api/applications        ->  POST {ALLOY}/journeys/{journey_token}/applications
 *   Browser  ->  GET  /api/applications/:token ->  GET  {ALLOY}/journeys/{journey_token}/applications/:token
 *
 * No dependencies: Node 18+ only (built-in http and fetch).
 * If no workflow secret is set in .env, the service runs in MOCK mode and returns
 * simulated responses shaped like Alloy's, so the whole flow can be rehearsed offline.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------- config
function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const env = { ...loadEnv(path.join(__dirname, '.env')), ...process.env };

const CONFIG = {
  port: Number(env.PORT || 3000),
  institution: 'Russ Community Credit Union',
  baseUrl: (env.ALLOY_BASE_URL || '').replace(/\/+$/, ''),
  journeyToken: env.ALLOY_JOURNEY_TOKEN || '',
  workflowToken: env.ALLOY_WORKFLOW_TOKEN || '',
  workflowSecret: env.ALLOY_WORKFLOW_SECRET || '',
  sdkKey: env.ALLOY_SDK_KEY || '',
  namePrefix: env.TEST_NAME_PREFIX || '',
  forceMock: String(env.MOCK_MODE || '').toLowerCase() === 'true',
  demoPassword: env.DEMO_PASSWORD || '',
};
const LIVE = !CONFIG.forceMock && Boolean(CONFIG.baseUrl && CONFIG.journeyToken && CONFIG.workflowToken && CONFIG.workflowSecret);
if (!CONFIG.baseUrl) CONFIG.baseUrl = 'https://sandbox.alloy.co'; // shown in mock mode only
if (!CONFIG.journeyToken) CONFIG.journeyToken = 'J-DEMO';

// ---------------------------------------------------------------- helpers
const now = () => new Date().toISOString();
const digits = (s) => String(s || '').replace(/\D/g, '');

function maskSsn(ssn) {
  const d = digits(ssn);
  return d.length >= 4 ? `***-**-${d.slice(-4)}` : '***';
}

/** Copy of an Alloy request body that is safe to show on screen. */
function redact(body) {
  const copy = JSON.parse(JSON.stringify(body));
  for (const e of copy.entities || []) {
    if (e.data && e.data.document_ssn) e.data.document_ssn = maskSsn(e.data.document_ssn);
  }
  return copy;
}

/** Keep the X-ray readable: the fields an integrator parses, plus a small slice of the embedded detail. */
function trimResponse(r) {
  if (!r || typeof r !== 'object') return r;
  const out = {};
  for (const k of ['journey_application_token', 'status', 'complete_outcome', 'journey_application_status',
    'sandbox', 'created_at', 'updated_at', 'closed_at', 'error', 'minor_code', 'status_code']) {
    if (k in r) out[k] = r[k];
  }
  const emb = r._embedded || {};
  if (Array.isArray(emb.entity_applications)) {
    out._embedded = {
      entity_applications: emb.entity_applications.map((ea) => ({
        entity_token: ea.entity_token,
        entity_application_token: ea.entity_application_token,
        entity_application_status: ea.entity_application_status,
        entity_application_outcome: ea.entity_application_outcome,
        output: ea.output ? { outcome_reasons: ea.output.outcome_reasons, tags: ea.output.tags } : undefined,
      })),
    };
  }
  if (Array.isArray(emb.events)) {
    out._embedded = out._embedded || {};
    out._embedded.events = emb.events.map((ev) => ({
      type: ev.type,
      timestamp: ev.timestamp,
      node: ev._embedded && ev._embedded.node ? { name: ev._embedded.node.name, type: ev._embedded.node.type } : undefined,
    }));
  }
  if (!Object.keys(out).length) return r;
  return out;
}

// ---------------------------------------------------------------- the ESB mapping
/**
 * The one piece of business logic the credit union owns: turn Alloy's two fields
 * (status + complete_outcome) into the experience the member should see.
 */
function normalize(alloy) {
  const status = String(alloy.status || '').toLowerCase();
  const outcome = alloy.complete_outcome || null;
  let state = 'processing';
  if (status === 'completed') {
    state = String(outcome).toLowerCase() === 'approved' ? 'approved'
      : String(outcome).toLowerCase() === 'denied' ? 'denied' : 'review';
  } else if (status === 'pending_step_up' || status === 'pending_documents') state = 'step_up';
  else if (status === 'waiting_review' || status === 'pending_journey_application_review') state = 'review';
  else if (status === 'pending_action' || status === 'data_request') state = 'more_info';
  else if (status === 'error') state = 'error';
  else if (status === 'expired' || status === 'pending_step_up_expired') state = 'expired';

  const ea = ((alloy._embedded || {}).entity_applications || [])[0] || {};
  const output = ea.output || {};
  return {
    state,
    applicationId: alloy.journey_application_token || null,
    status: alloy.status || null,
    completeOutcome: outcome,
    dashboardStatus: alloy.journey_application_status || null,
    entityOutcome: ea.entity_application_outcome || null,
    outcomeReasons: (output.outcome_reasons || []).map((r) => (typeof r === 'string' ? r : r.name)).filter(Boolean),
    tags: output.tags || [],
  };
}

/** Front-end form -> Alloy Journeys payload. */
function toAlloyPayload(form) {
  const first = [CONFIG.namePrefix, form.firstName].filter(Boolean).join(' ').trim();
  return {
    external_application_id: `rccu-${crypto.randomUUID()}`,
    entities: [
      {
        external_entity_id: `rccu-member-${crypto.randomUUID()}`,
        entity_type: 'person',
        branch_name: 'persons',
        data: {
          name_first: first,
          name_last: form.lastName,
          birth_date: form.birthDate, // YYYY-MM-DD
          document_ssn: digits(form.ssn),
          email_address: form.email,
          phone_number: digits(form.phone),
          addresses: [
            {
              type: 'primary',
              line_1: form.addressLine1,
              line_2: form.addressLine2 || undefined,
              city: form.city,
              state: form.state,
              postal_code: form.postalCode,
              country_code: 'US',
            },
          ],
        },
      },
    ],
  };
}

function validate(form) {
  const missing = [];
  for (const k of ['firstName', 'lastName', 'birthDate', 'ssn', 'email', 'phone', 'addressLine1', 'city', 'state', 'postalCode']) {
    if (!form || !String(form[k] || '').trim()) missing.push(k);
  }
  if (form && form.ssn && digits(form.ssn).length !== 9) missing.push('ssn (9 digits)');
  return missing;
}

// ---------------------------------------------------------------- Alloy client
const authHeader = () => 'Basic ' + Buffer.from(`${CONFIG.workflowToken}:${CONFIG.workflowSecret}`).toString('base64');

async function alloyCall(method, pathname, body) {
  const url = CONFIG.baseUrl + pathname;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
    return { ok: res.ok, httpStatus: res.status, json, ms: Date.now() - started, url };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    return {
      ok: false, httpStatus: 0, ms: Date.now() - started, url,
      json: { error: timedOut ? 'Alloy did not respond within 20 seconds' : `Could not reach Alloy: ${err.message}` },
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- mock Alloy (offline rehearsal)
const mockStore = new Map();

/** Mirrors the sandbox profiles in the SE Hiring account: the postal code picks the result. */
function mockDecision(postalCode) {
  switch (String(postalCode)) {
    case '00001': return { status: 'pending_step_up', outcome: null, entity: 'Step Up Required', reasons: ['Fraud Review', 'Velocity Warning'], tags: ['CIP SSN Verified', 'CIP Name Verified', 'Medium Fraud Risk', 'SSN Velocity'] };
    case '00002': return { status: 'completed', outcome: 'Denied', entity: 'Denied', reasons: ['Denied Fraud'], tags: ['High Synthetic Fraud Risk', 'High Fraud Risk'] };
    case '00003': return { status: 'waiting_review', outcome: null, entity: 'Manual Review', reasons: ['CIP Review', 'Fraud Review'], tags: ['CIP Name Not Verified', 'Medium Fraud Risk'] };
    case '00004': return { status: 'waiting_review', outcome: null, entity: 'Manual Review', reasons: ['CIP Review'], tags: ['CIP Address Not Verified', 'CIP SSN Verified'] };
    default: return { status: 'completed', outcome: 'Approved', entity: 'Approved', reasons: [], tags: ['CIP SSN Verified', 'CIP Name Verified', 'CIP Address Verified', 'CIP DOB Verified', 'Phone Match'] };
  }
}

function mockBody(rec) {
  return {
    journey_application_token: rec.token,
    status: rec.status,
    complete_outcome: rec.outcome,
    journey_application_status: rec.outcome || (rec.status === 'pending_step_up' ? 'Pending Step Up' : rec.status === 'waiting_review' ? 'Waiting Review' : rec.status),
    sandbox: true,
    created_at: rec.createdAt,
    updated_at: Date.now(),
    _embedded: {
      entity_applications: [{
        entity_token: rec.entityToken,
        entity_application_token: rec.entityAppToken,
        entity_application_status: rec.status,
        entity_application_outcome: rec.entity,
        output: { outcome_reasons: rec.reasons.map((name) => ({ name })), tags: rec.tags },
      }],
      events: rec.events,
    },
  };
}

const rid = (p) => `${p}-` + crypto.randomBytes(15).toString('base64url').slice(0, 20);
const mockEvent = (type, node) => ({ type, timestamp: Date.now(), _embedded: { node: node || { name: null, type: null } } });

async function mockCall(method, pathname, body, action) {
  await new Promise((r) => setTimeout(r, 650 + Math.random() * 500)); // feel like a real network hop
  const url = CONFIG.baseUrl + pathname;
  const base = { ok: true, httpStatus: method === 'POST' ? 201 : 200, ms: 0, url };
  if (method === 'POST') {
    const postal = body.entities[0].data.addresses[0].postal_code;
    const d = mockDecision(postal);
    const wf = { name: 'Fraud & CIP (LexisNexis)', type: 'workflow' };
    const rec = {
      token: rid('JA'), entityToken: rid('P'), entityAppToken: rid('EA'), createdAt: Date.now(),
      status: d.status, outcome: d.outcome, entity: d.entity, reasons: d.reasons, tags: d.tags,
      events: [mockEvent('started_application'), mockEvent('started_evaluation', wf), mockEvent('completed_evaluation', wf)],
    };
    if (d.status === 'pending_step_up') rec.events.push(mockEvent('pending_step_up', { name: 'Document Verification (Socure)', type: 'step_up' }));
    else if (d.status === 'waiting_review') rec.events.push(mockEvent('pending_review', { name: 'Manual Review', type: 'review' }));
    else rec.events.push(mockEvent('completed_application'));
    mockStore.set(rec.token, rec);
    return { ...base, json: mockBody(rec) };
  }
  const token = pathname.split('/').pop();
  const rec = mockStore.get(token);
  if (!rec) return { ...base, ok: false, httpStatus: 404, json: { error: 'Journey application not found' } };
  if (action === 'documents_submitted' && rec.status === 'pending_step_up') {
    Object.assign(rec, { status: 'completed', outcome: 'Approved', entity: 'Approved', reasons: [] });
    rec.tags = [...rec.tags, 'Document Verified'];
    rec.events.push(mockEvent('completed_evaluation', { name: 'Document Verification (Socure)', type: 'workflow' }), mockEvent('completed_application'));
  } else if ((action === 'review_approved' || action === 'review_denied') && rec.status === 'waiting_review') {
    const approved = action === 'review_approved';
    Object.assign(rec, { status: 'completed', outcome: approved ? 'Approved' : 'Denied', entity: approved ? 'Approved' : 'Denied' });
    rec.events.push(mockEvent('completed_review', { name: 'Manual Review', type: 'review' }), mockEvent('completed_application'));
  }
  return { ...base, json: mockBody(rec) };
}

const callAlloy = (method, pathname, body, action) => (LIVE ? alloyCall(method, pathname, body) : mockCall(method, pathname, body, action));

// ---------------------------------------------------------------- X-ray trace
/** Each hop the request makes, in order, for the X-ray panel. */
function hop(from, to, title, detail = {}) {
  return { at: now(), from, to, title, ...detail };
}

// ---------------------------------------------------------------- HTTP plumbing
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(__dirname, 'public', rel));
  if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

const TOKEN_RE = /^JA-[A-Za-z0-9_-]{6,40}$/;

/** Optional password gate for a hosted demo. Any username; the password is DEMO_PASSWORD. */
function authorized(req) {
  if (!CONFIG.demoPassword) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const given = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
  const want = Buffer.from(CONFIG.demoPassword);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Russ Community Credit Union demo", charset="UTF-8"', 'Content-Type': 'text/plain' });
    return res.end('Password required.');
  }
  try {
    // What the browser is allowed to know. No credentials here.
    if (req.method === 'GET' && p === '/api/config') {
      return sendJson(res, 200, {
        institution: CONFIG.institution,
        mode: LIVE ? 'live' : 'mock',
        alloyHost: new URL(CONFIG.baseUrl).host,
        journeyToken: CONFIG.journeyToken,
        journeyName: 'Consumer Onboarding',
        sdkKey: CONFIG.sdkKey,
      });
    }

    // Step 2 on the process map: the digital application submits to the ESB.
    if (req.method === 'POST' && p === '/api/applications') {
      const form = await readBody(req);
      const missing = validate(form);
      if (missing.length) return sendJson(res, 400, { error: 'Missing or invalid fields', fields: missing });

      const payload = toAlloyPayload(form);
      const pathName = `/journeys/${CONFIG.journeyToken}/applications`;
      const trace = [
        hop('app', 'esb', 'Application received by the ESB', { method: 'POST', url: '/api/applications', note: 'TLS from the browser. No Alloy credentials leave this service.' }),
      ];
      const r = await callAlloy('POST', pathName, payload);
      trace.push(hop('esb', 'alloy', 'ESB requests a decision from Alloy', {
        method: 'POST', url: r.url, auth: 'Basic workflow_token:workflow_secret (held by the ESB)', request: redact(payload),
      }));
      trace.push(hop('alloy', 'esb', r.ok ? 'Alloy returns the journey result' : 'Alloy call failed', {
        httpStatus: r.httpStatus, ms: r.ms, response: trimResponse(r.json),
      }));
      if (!r.ok) {
        trace.push(hop('esb', 'app', 'ESB reports a technical error', { mapped: { state: 'error' } }));
        return sendJson(res, 502, { state: 'error', error: (r.json && (r.json.error || r.json.message)) || `Alloy returned HTTP ${r.httpStatus}`, trace, mode: LIVE ? 'live' : 'mock' });
      }
      const n = normalize(r.json);
      trace.push(hop('esb', 'app', 'ESB maps the result to a member experience', { mapped: { status: n.status, complete_outcome: n.completeOutcome, experience: n.state } }));
      return sendJson(res, 200, { ...n, trace, mode: LIVE ? 'live' : 'mock' });
    }

    // Status check. Production would react to Alloy webhooks; this sandbox account has none, so the ESB polls.
    const m = p.match(/^\/api\/applications\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const token = m[1];
      if (!TOKEN_RE.test(token)) return sendJson(res, 400, { error: 'Invalid application reference' });
      const r = await callAlloy('GET', `/journeys/${CONFIG.journeyToken}/applications/${token}`);
      const trace = [
        hop('esb', 'alloy', 'ESB checks the application status', { method: 'GET', url: r.url, note: 'Polling stands in for webhooks in this sandbox account.' }),
        hop('alloy', 'esb', r.ok ? 'Alloy returns the current status' : 'Alloy call failed', { httpStatus: r.httpStatus, ms: r.ms, response: trimResponse(r.json) }),
      ];
      if (!r.ok) return sendJson(res, r.httpStatus === 404 ? 404 : 502, { state: 'error', error: (r.json && (r.json.error || r.json.message)) || `Alloy returned HTTP ${r.httpStatus}`, trace });
      const n = normalize(r.json);
      trace.push(hop('esb', 'app', 'ESB maps the result to a member experience', { mapped: { status: n.status, complete_outcome: n.completeOutcome, experience: n.state } }));
      return sendJson(res, 200, { ...n, trace, mode: LIVE ? 'live' : 'mock' });
    }

    // Mock mode only: stand-ins for the applicant finishing the SDK and for the analyst deciding in the dashboard.
    const sim = p.match(/^\/api\/mock\/applications\/([^/]+)\/advance$/);
    if (req.method === 'POST' && sim) {
      if (LIVE) return sendJson(res, 409, { error: 'Simulation is only available in mock mode' });
      const { action } = await readBody(req);
      const token = sim[1];
      const r = await mockCall('GET', `/journeys/${CONFIG.journeyToken}/applications/${token}`, null, action);
      if (!r.ok) return sendJson(res, 404, { error: 'Application not found' });
      const n = normalize(r.json);
      const who = action === 'documents_submitted' ? ['applicant', 'alloy', 'Alloy SDK sends ID and selfie straight to Alloy'] : ['analyst', 'alloy', `Analyst ${action === 'review_approved' ? 'approves' : 'denies'} in the Alloy dashboard`];
      const trace = [
        hop(who[0], who[1], who[2], { note: 'Simulated in mock mode.' }),
        hop('alloy', 'esb', 'Journey resumes and reports the new status', { httpStatus: 200, response: trimResponse(r.json) }),
        hop('esb', 'app', 'ESB maps the result to a member experience', { mapped: { status: n.status, complete_outcome: n.completeOutcome, experience: n.state } }),
      ];
      return sendJson(res, 200, { ...n, trace, mode: 'mock' });
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'Unknown endpoint' });
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, p);
  } catch (err) {
    return sendJson(res, 500, { state: 'error', error: err.message || 'Unexpected error' });
  }
});

if (require.main === module) {
  server.listen(CONFIG.port, () => {
    console.log(`\n  ${CONFIG.institution} (Demo)`);
    console.log(`  Open http://localhost:${CONFIG.port}\n`);
    console.log(`  Mode:    ${LIVE ? 'LIVE  -> ' + CONFIG.baseUrl : 'MOCK  (Alloy settings incomplete; responses are simulated)'}`);
    console.log(`  Journey: ${CONFIG.journeyToken}`);
    console.log(`  Access:  ${CONFIG.demoPassword ? 'password protected' : 'open (set DEMO_PASSWORD to protect)'}\n`);
  });
}

module.exports = { normalize, toAlloyPayload, validate, mockDecision, server };
