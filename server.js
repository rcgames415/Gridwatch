import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import {
  db, getRow, getRows, id, audit, nowIso, ensureMonth, currentManilaMonth
} from './db.js';
import { runIngestionForMonth, startDailyScheduler } from './ingestion.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicRoot = resolve(root, 'public');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon'
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error('Request body exceeds 1 MB.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request body must contain valid JSON.'), { status: 400 }); }
}

function requireAdmin(req) {
  const configured = process.env.GRIDWATCH_ADMIN_TOKEN || '';
  if (!configured) throw Object.assign(new Error('Admin actions are disabled. Set GRIDWATCH_ADMIN_TOKEN to enable them.'), { status: 503 });
  const supplied = req.headers['x-admin-token'] || '';
  const left = Buffer.from(configured);
  const right = Buffer.from(String(supplied));
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw Object.assign(new Error('Admin token is missing or invalid.'), { status: 401 });
  }
}

function safeUrl(value, label) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    return parsed.toString();
  } catch {
    throw Object.assign(new Error(`${label} must be an HTTP or HTTPS URL.`), { status: 400 });
  }
}

function validSourceType(value) {
  const allowed = ['official_website', 'official_social', 'regulatory_reference', 'third_party_lead'];
  if (!allowed.includes(value)) throw Object.assign(new Error(`source_type must be one of: ${allowed.join(', ')}.`), { status: 400 });
  return value;
}

function validateMonth(value) {
  const month = value || currentManilaMonth();
  try { ensureMonth(month); }
  catch { throw Object.assign(new Error('Month must use YYYY-MM format.'), { status: 400 }); }
  return month;
}

function getRateRows({ month, from, to, duIds, customerClassId, approvedOnly = true } = {}) {
  const where = [];
  const params = [];
  if (month) { where.push('r.effective_month = ?'); params.push(month); }
  if (from) { where.push('r.effective_month >= ?'); params.push(from); }
  if (to) { where.push('r.effective_month <= ?'); params.push(to); }
  if (duIds?.length) { where.push(`r.du_id IN (${duIds.map(() => '?').join(',')})`); params.push(...duIds); }
  if (customerClassId) { where.push('r.customer_class_id = ?'); params.push(customerClassId); }
  if (approvedOnly) where.push("r.review_status = 'approved'");
  const rows = getRows(`SELECT r.*, d.acronym, d.full_name AS du_name, d.region_id, c.name AS customer_class,
    s.label AS source_label, s.source_type AS registry_source_type,
    COALESCE(r.source_url, s.url) AS resolved_source_url
    FROM rates r JOIN distribution_utilities d ON d.id = r.du_id
    JOIN customer_classes c ON c.id = r.customer_class_id LEFT JOIN sources s ON s.id = r.source_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY r.effective_month, d.acronym`, ...params);
  const componentsByRate = new Map();
  const ids = rows.map((row) => row.id);
  if (ids.length) {
    const parts = getRows(`SELECT * FROM rate_components WHERE rate_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort_order, original_label`, ...ids);
    for (const item of parts) {
      if (!componentsByRate.has(item.rate_id)) componentsByRate.set(item.rate_id, []);
      componentsByRate.get(item.rate_id).push(item);
    }
  }
  return rows.map((row) => ({ ...row, components: componentsByRate.get(row.id) || [] }));
}

function getCoverage(month) {
  const utilities = getRows(`SELECT d.*, r.name AS region_name, r.region_code FROM distribution_utilities d
    JOIN regions r ON r.id = d.region_id WHERE d.active = 1 ORDER BY d.acronym`);
  return utilities.map((du) => {
    const rate = getRow(`SELECT r.*, c.name AS customer_class FROM rates r JOIN customer_classes c ON c.id = r.customer_class_id
      WHERE r.du_id = ? AND r.effective_month = ? AND r.review_status = 'approved' AND c.comparison_default = 1`, du.id, month);
    const candidate = getRow(`SELECT id FROM ingest_candidates WHERE du_id = ? AND effective_month = ? AND status = 'needs_review' LIMIT 1`, du.id, month);
    const sourceCounts = getRow(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN recent.source_id IS NOT NULL THEN 1 ELSE 0 END) AS checked,
      SUM(CASE WHEN recent.status IN ('fetch_failed','parse_failed') THEN 1 ELSE 0 END) AS failures
      FROM sources s LEFT JOIN (
        SELECT source_id, status, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY checked_at DESC) AS position
        FROM source_checks WHERE du_id = ? AND effective_month = ?
      ) recent ON recent.source_id = s.id AND recent.position = 1
      WHERE s.du_id = ? AND s.enabled = 1 AND s.ingest_enabled = 1`, du.id, month, du.id) || { total: 0, checked: 0, failures: 0 };
    const latestCheck = getRow(`SELECT MAX(checked_at) AS checked_at FROM source_checks WHERE du_id = ? AND effective_month = ?`, du.id, month)?.checked_at || null;
    let status = 'pending';
    if (candidate) status = 'needs_review';
    else if (rate) status = 'current';
    else if (sourceCounts.total > 0 && sourceCounts.checked === sourceCounts.total && sourceCounts.failures === sourceCounts.total && latestCheck) status = 'unavailable';
    return {
      du_id: du.id, acronym: du.acronym, full_name: du.full_name, du_type: du.du_type,
      region_id: du.region_id, region_name: du.region_name, service_area_notes: du.service_area_notes,
      status, rate: rate?.published_total ?? null, currency: rate?.currency || 'PHP', unit: rate?.unit || 'kWh',
      rate_id: rate?.id || null, candidate_pending: Boolean(candidate), last_checked_at: latestCheck,
      enabled_source_count: sourceCounts.total || 0
    };
  });
}

function getBootstrap() {
  const regions = getRows('SELECT * FROM regions ORDER BY region_code');
  const utilities = getRows(`SELECT d.*, r.name AS region_name, r.region_code FROM distribution_utilities d
    JOIN regions r ON r.id = d.region_id ORDER BY r.region_code, d.acronym`);
  const sources = getRows(`SELECT s.*, d.acronym, d.full_name FROM sources s LEFT JOIN distribution_utilities d ON d.id = s.du_id
    ORDER BY d.acronym, s.source_type, s.label`);
  const rates = getRateRows();
  const latest = getRow("SELECT MAX(effective_month) AS month FROM rates WHERE review_status = 'approved'")?.month || null;
  const months = getRows('SELECT month FROM effective_months ORDER BY month DESC');
  const classes = getRows('SELECT * FROM customer_classes ORDER BY sort_order, name');
  return {
    regions, utilities, sources, rates, months: months.map((item) => item.month), customer_classes: classes,
    current_month: currentManilaMonth(), latest_available_month: latest,
    coverage: getCoverage(currentManilaMonth()),
    counts: {
      utilities: utilities.filter((item) => item.active).length,
      approved_rates: rates.length,
      pending_review: getRow("SELECT COUNT(*) AS count FROM ingest_candidates WHERE status = 'needs_review'")?.count || 0,
      source_checks: getRow('SELECT COUNT(*) AS count FROM source_checks')?.count || 0
    }
  };
}

function parseComponents(raw) {
  if (!Array.isArray(raw)) throw Object.assign(new Error('components must be an array.'), { status: 400 });
  return raw.map((item) => {
    const valueState = item.value_state || (item.value === 0 || item.value === '0' ? 'zero' : item.value == null ? 'missing' : 'value');
    if (!['value', 'zero', 'missing', 'not_published'].includes(valueState)) throw Object.assign(new Error(`Unsupported component state: ${valueState}`), { status: 400 });
    if (!item.normalized_category || !item.original_label) throw Object.assign(new Error('Every component needs a normalized category and original label.'), { status: 400 });
    const numericValue = item.value == null ? null : Number(item.value);
    if (['value', 'zero'].includes(valueState) && (!Number.isFinite(numericValue) || numericValue < 0)) throw Object.assign(new Error('Component values must be non-negative numbers.'), { status: 400 });
    if (valueState === 'zero' && numericValue !== 0) throw Object.assign(new Error('A zero component must store a value of 0.'), { status: 400 });
    return {
      id: id(), normalized_category: String(item.normalized_category), original_label: String(item.original_label),
      original_value: valueState === 'missing' || valueState === 'not_published' ? null : String(item.original_value ?? (valueState === 'zero' ? '0' : item.value)),
      value: valueState === 'missing' || valueState === 'not_published' ? null : String(valueState === 'zero' ? '0' : item.value),
      value_state: valueState, currency: item.currency || 'PHP', unit: item.unit || 'kWh', sort_order: Number(item.sort_order || 100)
    };
  });
}

function replaceComponents(rateId, components) {
  db.prepare('DELETE FROM rate_components WHERE rate_id = ?').run(rateId);
  const statement = db.prepare(`INSERT INTO rate_components
    (id, rate_id, normalized_category, original_label, original_value, value, value_state, currency, unit, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const c of components) statement.run(c.id, rateId, c.normalized_category, c.original_label, c.original_value, c.value, c.value_state, c.currency, c.unit, c.sort_order);
}

function writeRate(body, existingId = null, changedBy = 'admin') {
  const duId = body.du_id;
  const month = body.effective_month;
  const customerClassId = body.customer_class_id || 'residential';
  if (!duId || !month) throw Object.assign(new Error('du_id and effective_month are required.'), { status: 400 });
  if (!getRow('SELECT id FROM distribution_utilities WHERE id = ?', duId)) throw Object.assign(new Error('Unknown utility.'), { status: 404 });
  ensureMonth(month);
  if (!getRow('SELECT id FROM customer_classes WHERE id = ?', customerClassId)) throw Object.assign(new Error('Unknown customer class.'), { status: 400 });
  if (body.published_total == null) throw Object.assign(new Error('published_total is required for an approved rate.'), { status: 400 });
  if (body.published_total != null && !/^\d+(?:\.\d{1,6})?$/.test(String(body.published_total))) throw Object.assign(new Error('published_total must be a non-negative decimal with up to six places.'), { status: 400 });
  const before = existingId ? getRow('SELECT * FROM rates WHERE id = ?', existingId) : getRow(`SELECT * FROM rates WHERE du_id = ? AND effective_month = ? AND customer_class_id = ?`, duId, month, customerClassId);
  const rateId = before?.id || existingId || id();
  if (existingId && !before) throw Object.assign(new Error('Rate record not found.'), { status: 404 });
  if (existingId && (duId !== before.du_id || month !== before.effective_month || customerClassId !== before.customer_class_id)) {
    throw Object.assign(new Error('A correction cannot change a rate’s utility, effective month, or customer class.'), { status: 400 });
  }
  const componentInput = body.components !== undefined
    ? body.components
    : before ? getRows('SELECT * FROM rate_components WHERE rate_id = ? ORDER BY sort_order', before.id) : [];
  const components = parseComponents(componentInput);
  const beforeSnapshot = before ? {
    ...before,
    components: getRows('SELECT * FROM rate_components WHERE rate_id = ? ORDER BY sort_order', before.id)
  } : null;
  const sourceId = body.source_id || before?.source_id || null;
  const source = sourceId ? getRow('SELECT * FROM sources WHERE id = ?', sourceId) : null;
  if (sourceId && !source) throw Object.assign(new Error('Unknown source.'), { status: 400 });
  const sourceUrl = safeUrl(body.source_url ?? before?.source_url ?? source?.url ?? null, 'Rate source URL');
  const sourceType = validSourceType(body.source_type || source?.source_type || before?.source_type);
  const reviewStatus = body.review_status || 'approved';
  if (!['draft', 'needs_review', 'approved', 'rejected'].includes(reviewStatus)) throw Object.assign(new Error('Unsupported rate review_status.'), { status: 400 });
  if (!sourceUrl || !sourceType) throw Object.assign(new Error('A source URL and source_type are required for every rate.'), { status: 400 });
  const totalChanged = before && String(body.published_total) !== String(before.published_total);
  const originalTotal = body.published_total_original ?? (totalChanged ? String(body.published_total) : before?.published_total_original ?? String(body.published_total));
  const statement = db.prepare(`INSERT INTO rates
    (id, du_id, effective_month, customer_class_id, currency, unit, published_total, published_total_original, source_id, source_url,
     source_type, publication_date, retrieved_at, extraction_status, review_status, review_note, basis, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(du_id, effective_month, customer_class_id) DO UPDATE SET
      currency=excluded.currency, unit=excluded.unit, published_total=excluded.published_total,
      published_total_original=excluded.published_total_original,
      source_id=excluded.source_id, source_url=excluded.source_url, source_type=excluded.source_type,
      publication_date=excluded.publication_date, retrieved_at=excluded.retrieved_at,
      extraction_status=excluded.extraction_status, review_status=excluded.review_status,
      review_note=excluded.review_note, basis=excluded.basis, updated_at=excluded.updated_at`);
  statement.run(rateId, duId, month, customerClassId, body.currency || 'PHP', body.unit || 'kWh',
    body.published_total == null ? null : String(body.published_total), String(originalTotal), sourceId, sourceUrl, sourceType,
    body.publication_date || null, body.retrieved_at || nowIso(), body.extraction_status || 'manual_verified',
    reviewStatus, body.review_note || 'Reviewed and entered by an administrator.',
    body.basis || 'Published rate per kWh', nowIso());
  replaceComponents(rateId, components);
  const after = { ...getRow('SELECT * FROM rates WHERE id = ?', rateId), components };
  audit('rate', rateId, before ? 'correction' : 'create', beforeSnapshot, after, changedBy);
  return after;
}

async function handleApi(req, res, url) {
  const path = url.pathname;
  const method = req.method;
  if (method === 'GET' && path === '/api/bootstrap') return sendJson(res, 200, getBootstrap());
  if (method === 'GET' && path === '/api/coverage') {
    const month = validateMonth(url.searchParams.get('month'));
    return sendJson(res, 200, { month, coverage: getCoverage(month) });
  }
  if (method === 'GET' && path === '/api/rates') {
    const duIds = (url.searchParams.get('dus') || '').split(',').filter(Boolean);
    const customerClassId = url.searchParams.get('customer_class_id') || 'residential';
    return sendJson(res, 200, { rates: getRateRows({
      month: url.searchParams.get('month') || null, from: url.searchParams.get('from') || null,
      to: url.searchParams.get('to') || null, duIds, customerClassId
    }) });
  }
  if (method === 'GET' && path === '/api/breakdown') {
    const month = validateMonth(url.searchParams.get('month'));
    const duIds = (url.searchParams.get('dus') || '').split(',').filter(Boolean);
    return sendJson(res, 200, { month, rates: getRateRows({ month, duIds, customerClassId: url.searchParams.get('customer_class_id') || 'residential' }) });
  }
  if (path.startsWith('/api/admin/')) requireAdmin(req);
  if (method === 'GET' && path === '/api/admin/candidates') {
    const rows = getRows(`SELECT c.*, d.acronym, d.full_name AS du_name, s.label AS source_label, cc.name AS customer_class
      FROM ingest_candidates c JOIN distribution_utilities d ON d.id = c.du_id
      JOIN sources s ON s.id = c.source_id JOIN customer_classes cc ON cc.id = c.customer_class_id
      WHERE c.status = 'needs_review' ORDER BY c.effective_month DESC, d.acronym`)
      .map((item) => ({ ...item, parsed: JSON.parse(item.parsed_json || '{}') }));
    return sendJson(res, 200, { candidates: rows });
  }
  if (method === 'GET' && path === '/api/admin/audit') {
    const params = [];
    let where = '';
    if (url.searchParams.has('entity_type')) { where = 'WHERE entity_type = ?'; params.push(url.searchParams.get('entity_type')); }
    if (url.searchParams.has('entity_id')) { where += `${where ? ' AND' : 'WHERE'} entity_id = ?`; params.push(url.searchParams.get('entity_id')); }
    const events = getRows(`SELECT * FROM audit_log ${where} ORDER BY changed_at DESC LIMIT 250`, ...params)
      .map((event) => ({ ...event, before: event.before_json ? JSON.parse(event.before_json) : null, after: event.after_json ? JSON.parse(event.after_json) : null }));
    return sendJson(res, 200, { events });
  }
  if (method === 'POST' && path === '/api/admin/refresh') {
    const body = await readJson(req);
    const summary = await runIngestionForMonth(body.month || currentManilaMonth());
    return sendJson(res, 200, summary);
  }
  if (method === 'POST' && path === '/api/admin/regions') {
    const body = await readJson(req);
    if (!body.name || !body.region_code) return sendJson(res, 400, { error: 'name and region_code are required.' });
    const regionId = body.id || body.region_code.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    db.prepare('INSERT INTO regions (id, name, region_code) VALUES (?, ?, ?)').run(regionId, body.name, body.region_code);
    const row = getRow('SELECT * FROM regions WHERE id = ?', regionId);
    audit('region', regionId, 'create', null, row);
    return sendJson(res, 201, { region: row });
  }
  const regionMatch = path.match(/^\/api\/admin\/regions\/([^/]+)$/);
  if (method === 'PUT' && regionMatch) {
    const body = await readJson(req);
    const before = getRow('SELECT * FROM regions WHERE id = ?', regionMatch[1]);
    if (!before) return sendJson(res, 404, { error: 'Region not found.' });
    const next = { ...before, name: body.name ?? before.name, region_code: body.region_code ?? before.region_code, country: body.country ?? before.country };
    db.prepare('UPDATE regions SET name=?, region_code=?, country=?, updated_at=? WHERE id=?')
      .run(next.name, next.region_code, next.country, nowIso(), before.id);
    const after = getRow('SELECT * FROM regions WHERE id = ?', before.id);
    audit('region', before.id, 'update', before, after);
    return sendJson(res, 200, { region: after });
  }
  if (method === 'POST' && path === '/api/admin/dus') {
    const body = await readJson(req);
    if (!body.full_name || !body.acronym || !body.region_id || !body.du_type) return sendJson(res, 400, { error: 'full_name, acronym, region_id and du_type are required.' });
    const duId = body.id || body.acronym.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    db.prepare(`INSERT INTO distribution_utilities (id, region_id, full_name, acronym, du_type, service_area_notes, identity_source_url, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(duId, body.region_id, body.full_name, body.acronym, body.du_type, body.service_area_notes || '', safeUrl(body.identity_source_url, 'Identity source URL'), body.active === false ? 0 : 1);
    const row = getRow('SELECT * FROM distribution_utilities WHERE id = ?', duId);
    audit('distribution_utility', duId, 'create', null, row);
    return sendJson(res, 201, { utility: row });
  }
  const duMatch = path.match(/^\/api\/admin\/dus\/([^/]+)$/);
  if (method === 'PUT' && duMatch) {
    const body = await readJson(req);
    const before = getRow('SELECT * FROM distribution_utilities WHERE id = ?', duMatch[1]);
    if (!before) return sendJson(res, 404, { error: 'Utility not found.' });
    const fields = ['region_id', 'full_name', 'acronym', 'du_type', 'service_area_notes', 'identity_source_url', 'active'];
    const next = { ...before, ...Object.fromEntries(fields.filter((key) => body[key] !== undefined).map((key) => [key, body[key]])) };
    db.prepare(`UPDATE distribution_utilities SET region_id=?, full_name=?, acronym=?, du_type=?, service_area_notes=?, identity_source_url=?, active=?, updated_at=? WHERE id=?`)
      .run(next.region_id, next.full_name, next.acronym, next.du_type, next.service_area_notes || '', safeUrl(next.identity_source_url, 'Identity source URL'), next.active ? 1 : 0, nowIso(), before.id);
    const after = getRow('SELECT * FROM distribution_utilities WHERE id = ?', before.id);
    audit('distribution_utility', before.id, 'update', before, after);
    return sendJson(res, 200, { utility: after });
  }
  if (method === 'POST' && path === '/api/admin/sources') {
    const body = await readJson(req);
    if (!body.label || !body.source_type || !body.du_id) return sendJson(res, 400, { error: 'du_id, label and source_type are required.' });
    const sourceId = body.id || id();
    db.prepare(`INSERT INTO sources (id, du_id, label, source_type, url, notes, enabled, ingest_enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sourceId, body.du_id, body.label, validSourceType(body.source_type), safeUrl(body.url, 'Source URL'), body.notes || '', body.enabled === false ? 0 : 1, body.ingest_enabled ? 1 : 0);
    const row = getRow('SELECT * FROM sources WHERE id = ?', sourceId);
    audit('source', sourceId, 'create', null, row);
    return sendJson(res, 201, { source: row });
  }
  const sourceMatch = path.match(/^\/api\/admin\/sources\/([^/]+)$/);
  if (method === 'PUT' && sourceMatch) {
    const body = await readJson(req);
    const before = getRow('SELECT * FROM sources WHERE id = ?', sourceMatch[1]);
    if (!before) return sendJson(res, 404, { error: 'Source not found.' });
    const next = { ...before, ...body };
    db.prepare(`UPDATE sources SET label=?, source_type=?, url=?, notes=?, enabled=?, ingest_enabled=?, updated_at=? WHERE id=?`)
      .run(next.label, validSourceType(next.source_type), safeUrl(next.url, 'Source URL'), next.notes || '', next.enabled ? 1 : 0, next.ingest_enabled ? 1 : 0, nowIso(), before.id);
    const after = getRow('SELECT * FROM sources WHERE id = ?', before.id);
    audit('source', before.id, 'update', before, after);
    return sendJson(res, 200, { source: after });
  }
  const candidateMatch = path.match(/^\/api\/admin\/candidates\/([^/]+)\/(approve|reject)$/);
  if (method === 'POST' && candidateMatch) {
    const candidate = getRow('SELECT * FROM ingest_candidates WHERE id = ?', candidateMatch[1]);
    if (!candidate) return sendJson(res, 404, { error: 'Candidate not found.' });
    if (candidate.status !== 'needs_review') return sendJson(res, 409, { error: 'Candidate has already been reviewed.' });
    if (candidateMatch[2] === 'reject') {
      db.prepare(`UPDATE ingest_candidates SET status='rejected', reviewed_at=? WHERE id=?`).run(nowIso(), candidate.id);
      audit('ingest_candidate', candidate.id, 'reject', candidate, getRow('SELECT * FROM ingest_candidates WHERE id=?', candidate.id));
      return sendJson(res, 200, { status: 'rejected' });
    }
    const parsed = JSON.parse(candidate.parsed_json || '{}');
    const body = {
      du_id: candidate.du_id, effective_month: candidate.effective_month, customer_class_id: candidate.customer_class_id,
      published_total: candidate.published_total, published_total_original: candidate.published_total_original,
      currency: parsed.currency || 'PHP', unit: parsed.unit || 'kWh',
      source_id: candidate.source_id, source_url: candidate.source_url, source_type: candidate.source_type,
      publication_date: candidate.publication_date, retrieved_at: candidate.retrieved_at,
      extraction_status: 'auto_parsed_reviewed', review_status: 'approved',
      review_note: 'Reviewed and approved by an administrator.', basis: parsed.basis || 'Published residential rate per kWh',
      components: parsed.components || []
    };
    const rate = writeRate(body, null, 'admin');
    db.prepare(`UPDATE ingest_candidates SET status='approved', reviewed_at=? WHERE id=?`).run(nowIso(), candidate.id);
    audit('ingest_candidate', candidate.id, 'approve', candidate, getRow('SELECT * FROM ingest_candidates WHERE id=?', candidate.id));
    return sendJson(res, 200, { rate });
  }
  if (method === 'POST' && path === '/api/admin/rates') {
    const body = await readJson(req);
    return sendJson(res, 201, { rate: writeRate(body) });
  }
  const rateMatch = path.match(/^\/api\/admin\/rates\/([^/]+)$/);
  if (method === 'PUT' && rateMatch) {
    const body = await readJson(req);
    const before = getRow('SELECT * FROM rates WHERE id = ?', rateMatch[1]);
    if (!before) return sendJson(res, 404, { error: 'Rate not found.' });
    const next = { ...before, ...body };
    if (body.published_total !== undefined && body.published_total_original === undefined) next.published_total_original = String(body.published_total);
    return sendJson(res, 200, { rate: writeRate(next, before.id) });
  }
  return sendJson(res, 404, { error: 'API route not found.' });
}

async function serveStatic(res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { res.writeHead(400).end('Bad request'); return; }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const file = resolve(publicRoot, relative);
  if (file !== publicRoot && !file.startsWith(publicRoot + sep)) { res.writeHead(403).end('Forbidden'); return; }
  try {
    const info = await stat(file);
    const target = info.isDirectory() ? resolve(file, 'index.html') : file;
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': mimeTypes[extname(target)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    if (!extname(relative)) {
      try { res.writeHead(200, { 'content-type': mimeTypes['.html'] }).end(await readFile(resolve(publicRoot, 'index.html'))); }
      catch { res.writeHead(404).end('Not found'); }
    } else res.writeHead(404).end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(res, url.pathname);
    else sendJson(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    console.error(`${req.method} ${url.pathname}:`, error.message);
    if (!res.headersSent) sendJson(res, error.status || 500, { error: error.message || 'Internal server error.' });
    else res.end();
  }
});

if (process.argv.includes('--ingest-once')) {
  runIngestionForMonth(currentManilaMonth())
    .then((summary) => { console.log(JSON.stringify(summary, null, 2)); db.close(); })
    .catch((error) => { console.error(error); process.exitCode = 1; db.close(); });
} else {
  server.listen(port, host, () => {
    console.log(`Gridwatch listening on http://${host}:${port}`);
    startDailyScheduler();
  });
}
