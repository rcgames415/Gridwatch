import { createHash } from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import { getRow, getRows, run, transaction, id, nowIso, ensureMonth, currentManilaMonth, manilaDateParts } from './db.js';

const timeoutMs = Number(process.env.INGEST_REQUEST_TIMEOUT_MS || 18000);
const userAgent = process.env.INGEST_USER_AGENT || 'GridwatchRateMonitor/1.0';
const autoPublishThirdParty = String(process.env.INGEST_AUTO_PUBLISH_THIRD_PARTY || 'true').toLowerCase() !== 'false';
const autoPublishConfidence = Number(process.env.INGEST_AUTO_PUBLISH_CONFIDENCE || 0.95);

function monthLabel(month) {
  const [year, number] = month.split('-').map(Number);
  return { long: new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, number - 1, 1))), year };
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function htmlToText(source) {
  return decodeEntities(source
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/article|\/section)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

async function pdfToText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

function rateDocumentLinks(html, baseUrl, month) {
  const { long, year } = monthLabel(month);
  const monthPattern = new RegExp(`(?:${long}|${long.slice(0, 3)})\\.?\\s*,?\\s*${year}|${year}\\s+(?:${long}|${long.slice(0, 3)})`, 'i');
  const links = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1];
    if (!href) continue;
    const label = htmlToText(match[2]);
    const combined = `${label} ${href}`;
    if (!monthPattern.test(combined) || !/(rate|tariff|generation|charge|schedule|kwh)/i.test(combined)) continue;
    try {
      const url = new URL(decodeEntities(href), baseUrl);
      if (['http:', 'https:'].includes(url.protocol) && !links.some((item) => item.url === url.toString())) links.push({ url: url.toString(), label });
    } catch { /* ignore malformed link */ }
    if (links.length >= 3) break;
  }
  return links;
}

async function fetchSource(url, month) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Only public HTTP or HTTPS source URLs are supported.');
  const response = await fetch(parsed, {
    headers: { 'user-agent': userAgent, accept: 'text/html,application/pdf,text/plain,application/xhtml+xml,*/*;q=0.5' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) return { httpStatus: response.status, error: `Source returned HTTP ${response.status}.` };
  const contentType = response.headers.get('content-type') || '';
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 12 * 1024 * 1024) return { httpStatus: response.status, error: 'Document exceeds the 12 MB ingestion limit.' };
  const pdf = /application\/pdf/i.test(contentType) || parsed.pathname.toLowerCase().endsWith('.pdf') || buffer.subarray(0, 4).toString() === '%PDF';
  try {
    const rawText = buffer.toString('utf8');
    const text = pdf ? await pdfToText(buffer) : htmlToText(rawText);
    if (text.length < 24) return { httpStatus: response.status, error: 'The fetched page did not contain enough readable text.' };
    return { httpStatus: response.status, text, contentType, links: pdf ? [] : rateDocumentLinks(rawText, parsed, month) };
  } catch (error) {
    return { httpStatus: response.status, error: error.message };
  }
}

function findMonthEvidence(text, month) {
  const { long, year } = monthLabel(month);
  const abbreviated = long.slice(0, 3);
  const pattern = new RegExp(`\\b(?:${long}|${abbreviated})\\.?\\s*,?\\s*${year}\\b|\\b${year}\\s+(?:${long}|${abbreviated})\\b`, 'i');
  return pattern.exec(text);
}

function parseMoneyNear(text, index) {
  const window = text.slice(Math.max(0, index - 35), Math.min(text.length, index + 260));
  const amount = /(?:₱|PHP\s*)?\s*(\d{1,3}(?:,\d{3})*\.\d{2,6})\s*(?:PHP\s*)?(?:\/\s*kWh|per\s*kWh|kWh)/i.exec(window);
  return amount ? { amount: amount[1].replace(/,/g, ''), original: amount[1], window, index: Math.max(0, index - 35) + amount.index } : null;
}

function categoryFor(label) {
  const value = label.toLowerCase();
  if (/generation/.test(value)) return 'generation';
  if (/transmission/.test(value)) return 'transmission';
  if (/system\s*loss|systems\s*loss/.test(value)) return 'system_loss';
  if (/distribution/.test(value)) return 'distribution';
  if (/supply/.test(value)) return 'supply';
  if (/meter/.test(value)) return 'metering';
  if (/universal|uc-/.test(value)) return 'universal_charge';
  if (/tax|vat/.test(value)) return 'taxes';
  if (/adjustment|true[- ]?up|refund/.test(value)) return 'adjustments';
  return 'other';
}

function parseComponents(text) {
  const labels = [
    'Generation Charge', 'Transmission Charge', 'System Loss Charge', 'Distribution Charge',
    'Supply Charge', 'Metering Charge', 'Universal Charge', 'Lifeline Rate Subsidy',
    'Missionary Electrification', 'FIT-All', 'Taxes', 'VAT', 'Adjustments', 'Other Charges'
  ];
  const found = [];
  for (const label of labels) {
    const re = new RegExp(`(${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})[^\\d\\n]{0,50}(?:₱|PHP\\s*)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2,6})\\s*(?:PHP\\s*)?(?:/\\s*kWh|per\\s*kWh|kWh)`, 'i');
    const match = re.exec(text);
    if (match) found.push({ normalized_category: categoryFor(label), original_label: match[1], original_value: match[2], value: match[2].replace(/,/g, ''), value_state: Number(match[2].replace(/,/g, '')) === 0 ? 'zero' : 'value' });
  }
  return found;
}

function extractSmartEnergyCandidate(text, month) {
  const { long, year } = monthLabel(month);
  const monthPattern = new RegExp(`\\b${long}\\s+${year}\\b`, 'i');
  const lines = text.split('\n').map((line) => line.trim());
  const headerIndex = lines.findIndex((line) => /month/i.test(line) && /residential/i.test(line) && /generation/i.test(line));
  if (headerIndex < 0) return null;
  const row = lines.slice(headerIndex + 1).find((line) => monthPattern.test(line) && /₱\s*\d+\.\d{2}/.test(line));
  if (!row) return null;
  const amounts = [...row.matchAll(/₱\s*(\d+(?:,\d{3})*\.\d{2,6})/g)].map((match) => match[1].replace(/,/g, ''));
  if (amounts.length < 2) return null;
  const generation = amounts.length >= 2 ? amounts.at(-1) : null;
  const components = generation == null ? [] : [{
    normalized_category: 'generation', original_label: 'Generation charge',
    original_value: generation, value: generation, value_state: Number(generation) === 0 ? 'zero' : 'value'
  }];
  return {
    published_total: amounts[0], published_total_original: amounts[0], publication_date: null,
    confidence: 0.97,
    automatic_publish: true,
    raw_excerpt: row,
    parsed: {
      customer_class: 'Residential', currency: 'PHP', unit: 'kWh',
      basis: 'Third-party reported residential all-in rate per kWh, rounded to PHP 0.01', components
    }
  };
}

async function publishStructuredThirdPartyRate(source, month, candidate, checkedAt) {
  const customerClass = await getRow("SELECT id FROM customer_classes WHERE name = 'Residential'");
  const before = await getRow(`SELECT * FROM rates WHERE du_id = ? AND effective_month = ? AND customer_class_id = ?`,
    source.du_id, month, customerClass.id);
  const oldComponents = before
    ? await getRows('SELECT * FROM rate_components WHERE rate_id = ? ORDER BY sort_order, original_label', before.id)
    : [];
  const nextComponents = candidate.parsed.components || [];

  // Keep an existing official or manually reviewed source authoritative.
  if (before && (before.source_type !== 'third_party_lead' || before.review_status !== 'approved')) {
    return { needs_review: true };
  }
  const sameComponents = oldComponents.length === nextComponents.length && oldComponents.every((old, index) =>
    old.normalized_category === nextComponents[index].normalized_category
      && old.original_label === nextComponents[index].original_label
      && String(old.value ?? '') === String(nextComponents[index].value ?? '')
      && old.value_state === nextComponents[index].value_state);
  if (before && String(before.published_total) === String(candidate.published_total) && sameComponents) {
    return { unchanged: true, rate_id: before.id };
  }

  const rateId = before?.id || id();
  const sourceUrl = source.url;
  const reviewNote = 'Auto-published from a structured SmartEnergyPH residential rate table. This is a third-party lead rounded to PHP 0.01/kWh, not an official DU announcement; the linked profile lists original-source references. Confirm with the DU.';
  await transaction(async (tx) => {
  await tx.run(`INSERT INTO rates
    (id, du_id, effective_month, customer_class_id, currency, unit, published_total, published_total_original,
     source_id, source_url, source_type, publication_date, retrieved_at, extraction_status, review_status,
     review_note, basis, updated_at)
    VALUES (?, ?, ?, ?, 'PHP', 'kWh', ?, ?, ?, ?, 'third_party_lead', NULL, ?, 'auto_parsed_high_confidence', 'approved', ?, ?, ?)
    ON CONFLICT(du_id, effective_month, customer_class_id) DO UPDATE SET
      currency=excluded.currency, unit=excluded.unit, published_total=excluded.published_total,
      published_total_original=excluded.published_total_original, source_id=excluded.source_id,
      source_url=excluded.source_url, source_type=excluded.source_type, publication_date=excluded.publication_date,
      retrieved_at=excluded.retrieved_at, extraction_status=excluded.extraction_status,
      review_status=excluded.review_status, review_note=excluded.review_note, basis=excluded.basis, updated_at=excluded.updated_at`,
  rateId, source.du_id, month, customerClass.id, candidate.published_total, candidate.published_total,
  source.id, sourceUrl, checkedAt, reviewNote, candidate.parsed.basis || 'Residential rate per kWh', checkedAt);

  await tx.run('DELETE FROM rate_components WHERE rate_id = ?', rateId);
  for (const [index, component] of nextComponents.entries()) {
    await tx.run(`INSERT INTO rate_components
      (id, rate_id, normalized_category, original_label, original_value, value, value_state, currency, unit, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'PHP', 'kWh', ?)`, id(), rateId, component.normalized_category, component.original_label,
      component.original_value ?? component.value ?? null, component.value ?? null,
      component.value_state || (Number(component.value) === 0 ? 'zero' : 'value'), (index + 1) * 10);
  }
  const after = {
    ...await tx.row('SELECT * FROM rates WHERE id = ?', rateId),
    components: await tx.rows('SELECT * FROM rate_components WHERE rate_id = ? ORDER BY sort_order, original_label', rateId)
  };
  await tx.run(`INSERT INTO audit_log (id, entity_type, entity_id, action, before_json, after_json, changed_by, changed_at)
    VALUES (?, 'rate', ?, ?, ?, ?, 'scheduler', ?)`, id(), rateId, before ? 'correction' : 'create',
  before ? JSON.stringify({ ...before, components: oldComponents }) : null, JSON.stringify(after), nowIso());
  });
  return { published: true, corrected: Boolean(before), rate_id: rateId };
}

function extractCandidate(text, source, month) {
  if (source.source_type === 'third_party_lead') {
    try {
      const sourceUrl = new URL(source.url);
      if (sourceUrl.hostname === 'smartenergyph.com' && sourceUrl.pathname.startsWith('/electricity/rates/')) {
        return extractSmartEnergyCandidate(text, month);
      }
    } catch { /* invalid URLs are recorded by fetchSource */ }
  }
  const monthMatch = findMonthEvidence(text, month);
  if (!monthMatch) return null;
  const inMonthText = text.slice(Math.max(0, monthMatch.index - 500), Math.min(text.length, monthMatch.index + 1800));
  const residentialIndex = inMonthText.search(/residential(?:\s+(?:rate|class|customer))?/i);
  if (residentialIndex < 0) return null;
  const money = parseMoneyNear(inMonthText, residentialIndex);
  if (!money) return null;
  const absoluteAmountIndex = Math.max(0, monthMatch.index - 500) + money.index;
  const excerpt = text.slice(Math.max(0, absoluteAmountIndex - 220), Math.min(text.length, absoluteAmountIndex + 270)).replace(/\s+/g, ' ').trim();
  const pubDate = /\b([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})\b/.exec(inMonthText)?.[1] || null;
  const components = parseComponents(inMonthText);
  return {
    published_total: money.amount,
    published_total_original: money.original,
    publication_date: pubDate,
    confidence: 0.72,
    raw_excerpt: excerpt,
    parsed: { customer_class: 'Residential', currency: 'PHP', unit: 'kWh', basis: 'Published residential rate per kWh', components }
  };
}

async function writeCheck(source, status, httpStatus, message, month, duId, candidateCount = 0) {
  const checkedAt = nowIso();
  await run(`INSERT INTO source_checks
    (id, source_id, du_id, effective_month, checked_at, status, http_status, message, candidate_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id(), source.id, duId, month, checkedAt, status, httpStatus, message || '', candidateCount);
  await run(`UPDATE sources SET last_checked_at = ?, last_check_status = ?, last_check_message = ?, updated_at = ? WHERE id = ?`,
    checkedAt, status, message || '', checkedAt, source.id);
  return checkedAt;
}

async function checkOne(source, month) {
  const checkedAt = nowIso();
  try {
    if (!source.url) {
      await writeCheck(source, 'fetch_failed', null, 'No URL is registered for this source.', month, source.du_id);
      return { source_id: source.id, du_id: source.du_id, status: 'fetch_failed' };
    }
    const result = await fetchSource(source.url, month);
    if (result.error) {
      const failure = result.httpStatus && result.httpStatus < 400 ? 'parse_failed' : 'fetch_failed';
      await writeCheck(source, failure, result.httpStatus, result.error, month, source.du_id);
      return { source_id: source.id, du_id: source.du_id, status: failure, message: result.error };
    }
    let parsed = extractCandidate(result.text, source, month);
    let candidateUrl = source.url;
    let linkedParseError = null;
    if (!parsed) {
      for (const link of result.links || []) {
        const document = await fetchSource(link.url, month);
        if (document.error) { linkedParseError = document.error; continue; }
        parsed = extractCandidate(document.text, source, month);
        if (parsed) { candidateUrl = link.url; break; }
      }
    }
    if (!parsed) {
      if (linkedParseError) {
        await writeCheck(source, 'parse_failed', result.httpStatus, `Linked monthly document could not be parsed: ${linkedParseError}`, month, source.du_id);
        return { source_id: source.id, du_id: source.du_id, status: 'parse_failed', message: linkedParseError };
      }
      await writeCheck(source, 'not_found', result.httpStatus, `Page checked; no clearly labeled residential ${month} rate was found.`, month, source.du_id);
      return { source_id: source.id, du_id: source.du_id, status: 'not_found' };
    }
    if (autoPublishThirdParty && parsed.automatic_publish === true && parsed.confidence >= autoPublishConfidence) {
      const publication = await publishStructuredThirdPartyRate(source, month, parsed, checkedAt);
      if (!publication.needs_review) {
        const message = publication.unchanged
          ? 'A matching third-party rate is already recorded.'
          : 'High-confidence structured third-party rate published with a third-party label.';
        await writeCheck(source, 'checked', result.httpStatus, message, month, source.du_id, 0);
        return { source_id: source.id, du_id: source.du_id, status: 'checked', auto_published: publication.published || false, corrected: publication.corrected || false, unchanged: publication.unchanged || false };
      }
    }
    const residential = await getRow(`SELECT id FROM customer_classes WHERE name = 'Residential'`);
    const keyFingerprint = createHash('sha256').update(JSON.stringify({ total: parsed.published_total, excerpt: parsed.raw_excerpt, parsed: parsed.parsed })).digest('hex');
    const key = `${source.id}:${month}:${residential.id}:${keyFingerprint}`;
    const candidateId = id();
    const reviewNote = source.source_type === 'third_party_lead'
      ? 'Third-party compiled rate candidate. Inspect the profile and its linked original DU announcement, then confirm the customer class and total before approval.'
      : 'Automated extraction is a candidate only; compare with the original DU announcement before publication.';
    const inserted = await run(`INSERT OR IGNORE INTO ingest_candidates
      (id, du_id, source_id, effective_month, customer_class_id, published_total, published_total_original, source_url, source_type,
       publication_date, retrieved_at, confidence, raw_excerpt, parsed_json, status, review_note, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_review', ?, ?)`,
      candidateId, source.du_id, source.id, month, residential.id, parsed.published_total, parsed.published_total_original,
      candidateUrl, source.source_type, parsed.publication_date, checkedAt, parsed.confidence,
      parsed.raw_excerpt, JSON.stringify(parsed.parsed), reviewNote, key);
    const staged = Number(inserted.changes) > 0;
    await writeCheck(source, 'checked', result.httpStatus, staged ? 'A possible residential rate was staged for review.' : 'A matching announcement was found; this extraction already exists in the review history.', month, source.du_id, staged ? 1 : 0);
    return { source_id: source.id, du_id: source.du_id, status: 'checked', candidate: staged, match: true };
  } catch (error) {
    await writeCheck(source, 'fetch_failed', null, error.message || 'Unexpected fetch failure.', month, source.du_id);
    return { source_id: source.id, du_id: source.du_id, status: 'fetch_failed', message: error.message };
  }
}

export async function runIngestionForMonth(month = currentManilaMonth()) {
  await ensureMonth(month);
  const sources = await getRows(`SELECT * FROM sources WHERE enabled = 1 AND ingest_enabled = 1 AND url IS NOT NULL ORDER BY id`);
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < sources.length) {
      const source = sources[cursor++];
      results.push(await checkOne(source, month));
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, sources.length) }, worker));
  const summary = {
    month,
    checked: results.length,
    candidates: results.filter((item) => item.candidate).length,
    auto_published: results.filter((item) => item.auto_published).length,
    failures: results.filter((item) => ['fetch_failed', 'parse_failed'].includes(item.status)).length,
    results
  };
  await run(`INSERT INTO audit_log (id, entity_type, entity_id, action, after_json, changed_by, changed_at)
    VALUES (?, 'ingestion', ?, 'refresh', ?, 'scheduler', ?)`, id(), month, JSON.stringify({ ...summary, results: undefined }), nowIso());
  return summary;
}

export function monthForCurrentManilaDate() {
  const p = manilaDateParts();
  return `${p.year}-${p.month}`;
}
