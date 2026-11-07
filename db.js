import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(resolve(root, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const databasePath = resolve(process.env.DATABASE_PATH || './data/gridwatch.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);

for (const filename of readdirSync(resolve(root, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
  const applied = db.prepare('SELECT filename FROM schema_migrations WHERE filename = ?').get(filename);
  if (!applied) {
    db.exec(readFileSync(resolve(root, 'migrations', filename), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(filename);
  }
}

export function id() {
  return randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

export function manilaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function currentManilaMonth() {
  const { year, month } = manilaDateParts();
  return `${year}-${month}`;
}

export function ensureMonth(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Month must use YYYY-MM format.');
  const [year, monthNumber] = month.split('-').map(Number);
  db.prepare('INSERT OR IGNORE INTO effective_months (month, year, month_number) VALUES (?, ?, ?)').run(month, year, monthNumber);
}

function seedInitialData() {
  const seed = JSON.parse(readFileSync(resolve(root, 'seed/region-iii.json'), 'utf8'));
  db.prepare(`INSERT OR IGNORE INTO regions (id, name, region_code)
    VALUES (?, ?, ?)`).run(seed.region.id, seed.region.name, seed.region.region_code);

  const addClass = db.prepare(`INSERT OR IGNORE INTO customer_classes (id, name, comparison_default, sort_order)
    VALUES (?, ?, ?, ?)`);
  for (const item of seed.customer_classes) addClass.run(item.id, item.name, item.comparison_default, item.sort_order);

  const addDu = db.prepare(`INSERT OR IGNORE INTO distribution_utilities
    (id, region_id, full_name, acronym, du_type, service_area_notes, identity_source_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const addSource = db.prepare(`INSERT OR IGNORE INTO sources
    (id, du_id, label, source_type, url, notes, enabled, ingest_enabled)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)`);

  for (const item of seed.utilities) {
    addDu.run(item.id, seed.region.id, item.full_name, item.acronym, item.du_type,
      item.service_area_notes, seed.references.doe_ddp);
    addSource.run(`official-${item.id}`, item.id, `${item.acronym} official public website`,
      'official_website', item.website, item.source_note || 'Seeded from a public DU website or an official agency profile.', item.ingest_enabled ?? 1);
    addSource.run(`doe-${item.id}`, item.id, 'DOE 2023–2032 DDP identity profile',
      'regulatory_reference', seed.references.doe_ddp,
      'DOE distribution development plan. Identity reference, not a monthly DU rate announcement.', 0);
    addSource.run(`doe-rates-${item.id}`, item.id, 'DOE electricity rates data reference',
      'regulatory_reference', seed.references.doe_electricity_rates,
      'DOE monthly DU rate dataset reference. Government cross-check, not a DU announcement; not used by the announcement ingestor.', 0);
    const isPrivate = item.du_type === 'Private utility' || item.du_type === 'Ecozone utility';
    const regUrl = isPrivate ? seed.references.erc_private_schedules : seed.references.erc_cooperatives;
    addSource.run(`erc-${item.id}`, item.id, `ERC ${isPrivate ? 'approved rate schedule' : 'Region III DU profile'}`,
      'regulatory_reference', regUrl,
      'Identity/regulatory reference. This is not treated as a monthly rate announcement.', 0);
  }

  // Facebook links are stored as references for human review only. Automated
  // fetching stays disabled unless an authorized Meta API integration exists.
  for (const source of seed.social_sources || []) {
    addSource.run(source.id, source.du_id, source.label, source.source_type,
      source.url, source.notes || '', 0);
  }
  // Third-party rate histories are checked separately and stay clearly labeled.
  for (const source of seed.third_party_sources || []) {
    addSource.run(source.id, source.du_id, source.label, source.source_type,
      source.url, source.notes || '',
      source.ingest_enabled || (seed.third_party_ingest_enabled && source.url?.startsWith('https://smartenergyph.com/electricity/rates/')) ? 1 : 0);
  }
  addSource.run('third-party-tipidkuryente-presyo', null, 'TipidKuryente monthly dataset / PRESYO-PH',
    'third_party_lead', 'https://tipidkuryente.ph/electricity-rate-trends',
    'Historical residential rate series downloaded from TipidKuryente’s public CSV and credited to PRESYO-PH. The CSV links to its tracker source for each row. Standardized third-party data, not direct DU announcements; attribution is required.', 0);
  ensureMonth(currentManilaMonth());
}

seedInitialData();

function seedInitialHistoricalRates() {
  const history = JSON.parse(readFileSync(resolve(root, 'seed/region-iii-historical-rates.json'), 'utf8'));
  const sourceId = history.source_registry_id;
  const sourceExists = getRow('SELECT id FROM sources WHERE id = ?', sourceId);
  if (!sourceExists) return;
  const statement = db.prepare(`INSERT OR IGNORE INTO rates
    (id, du_id, effective_month, customer_class_id, currency, unit, published_total, published_total_original,
     source_id, source_url, source_type, publication_date, retrieved_at, extraction_status, review_status,
     review_note, basis, updated_at)
    VALUES (?, ?, ?, 'residential', 'PHP', 'kWh', ?, ?, ?, ?, 'third_party_lead', NULL, ?,
      'third_party_dataset_csv', 'approved', ?, 'Standardized residential rate per kWh (PRESYO-PH via TipidKuryente)', ?)`);
  const note = `${history.source_note} Each record is a value present in the source CSV; months without a value remain blank.`;
  for (const item of history.rates) {
    ensureMonth(item.effective_month);
    const duExists = getRow('SELECT id FROM distribution_utilities WHERE id = ?', item.du_id);
    if (!duExists) continue;
    const rateId = `seed-presyo-${item.du_id}-${item.effective_month}`;
    const inserted = statement.run(rateId, item.du_id, item.effective_month, item.published_total,
      item.published_total, sourceId, item.source_url, history.retrieved_at, note, history.retrieved_at);
    if (!inserted.changes) continue;
    audit('rate', rateId, 'historical_import', null, {
      du_id: item.du_id, effective_month: item.effective_month, customer_class_id: 'residential',
      published_total: item.published_total, source_id: sourceId, source_url: item.source_url,
      source_type: 'third_party_lead', retrieved_at: history.retrieved_at,
      extraction_status: 'third_party_dataset_csv', review_status: 'approved', basis: 'Standardized residential rate per kWh (PRESYO-PH via TipidKuryente)'
    }, 'seed');
  }
}

seedInitialHistoricalRates();

function seedInitialRateSnapshot() {
  const snapshot = JSON.parse(readFileSync(resolve(root, 'seed/region-iii-rate-snapshot.json'), 'utf8'));
  const insertRate = db.prepare(`INSERT OR IGNORE INTO rates
    (id, du_id, effective_month, customer_class_id, currency, unit, published_total, published_total_original,
     source_id, source_url, source_type, publication_date, retrieved_at, extraction_status, review_status,
     review_note, basis, updated_at)
    VALUES (?, ?, ?, 'residential', 'PHP', 'kWh', ?, ?, ?, ?, 'third_party_lead', NULL, ?,
     'third_party_compiled', 'approved', ?, 'Residential all-in rate per kWh, reported by SmartEnergyPH', ?)`);
  const insertComponent = db.prepare(`INSERT OR IGNORE INTO rate_components
    (id, rate_id, normalized_category, original_label, original_value, value, value_state, currency, unit, sort_order)
    VALUES (?, ?, 'generation', 'Generation charge', ?, ?, 'value', 'PHP', 'kWh', 10)`);

  for (const item of snapshot.rates) {
    ensureMonth(item.effective_month);
    const sourceId = `third-party-smartenergyph-${item.du_id}`;
    if (getRow('SELECT id FROM sources WHERE id = ?', sourceId) == null) continue;
    const existing = getRow(`SELECT id FROM rates WHERE du_id = ? AND effective_month = ? AND customer_class_id = 'residential'`, item.du_id, item.effective_month);
    if (existing) continue;
    const rateId = `seed-smartenergy-${item.du_id}-${item.effective_month}`;
    const note = `${snapshot.source_note} This entry was reviewed against the linked SmartEnergyPH profile on 2026-11-07; its underlying DU announcement was not independently rechecked by Gridwatch.`;
    const result = insertRate.run(rateId, item.du_id, item.effective_month, item.published_total, item.published_total,
      sourceId, item.source_url, snapshot.retrieved_at, note, snapshot.retrieved_at);
    if (!result.changes) continue;
    insertComponent.run(`${rateId}-generation`, rateId, item.generation, item.generation);
    audit('rate', rateId, 'seed', null, {
      du_id: item.du_id, effective_month: item.effective_month, customer_class_id: 'residential',
      published_total: item.published_total, source_url: item.source_url, source_type: 'third_party_lead',
      retrieved_at: snapshot.retrieved_at, review_note: note,
      components: [{ normalized_category: 'generation', original_label: 'Generation charge', value: item.generation }]
    }, 'seed');
  }
}

seedInitialRateSnapshot();

function seedInitialOfficialRateUpdates() {
  const marker = 'seed:region-iii-official-october-2026:v1';
  if (getSetting(marker) === 'done') return;

  const updateSet = JSON.parse(readFileSync(resolve(root, 'seed/region-iii-official-rate-updates.json'), 'utf8'));
  const findExisting = db.prepare(`SELECT * FROM rates
    WHERE du_id = ? AND effective_month = ? AND customer_class_id = 'residential'`);
  const addRate = db.prepare(`INSERT INTO rates
    (id, du_id, effective_month, customer_class_id, currency, unit, published_total, published_total_original,
     source_id, source_url, source_type, publication_date, retrieved_at, extraction_status, review_status,
     review_note, basis, updated_at)
    VALUES (?, ?, ?, 'residential', 'PHP', 'kWh', ?, ?, ?, ?, 'official_website', ?, ?,
      'manual_official_seed', 'approved', ?, ?, ?)`);
  const updateRate = db.prepare(`UPDATE rates SET published_total = ?, published_total_original = ?,
    source_id = ?, source_url = ?, source_type = 'official_website', publication_date = ?, retrieved_at = ?,
    extraction_status = 'manual_official_seed', review_status = 'approved', review_note = ?, basis = ?, updated_at = ?
    WHERE id = ?`);
  const addComponent = db.prepare(`INSERT INTO rate_components
    (id, rate_id, normalized_category, original_label, original_value, value, value_state, currency, unit, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, 'value', 'PHP', ?, ?)`);

  db.exec('BEGIN');
  try {
    for (const item of updateSet.rates) {
      ensureMonth(item.effective_month);
      if (!getRow('SELECT id FROM distribution_utilities WHERE id = ?', item.du_id)) continue;
      const sourceId = `official-${item.du_id}`;
      if (!getRow('SELECT id FROM sources WHERE id = ?', sourceId)) continue;

      const existing = findExisting.get(item.du_id, item.effective_month);
      const seedId = `seed-official-${item.du_id}-${item.effective_month}`;
      const reviewNote = `${updateSet.source_note} Published rate total is retained separately from its listed components.`;
      let rateId = seedId;

      if (existing) {
        const isSeededRecord = existing.id.startsWith('seed-smartenergy-')
          || existing.id.startsWith('seed-presyo-')
          || existing.id.startsWith('seed-official-');
        if (!isSeededRecord) continue;
        rateId = existing.id;
        const oldComponents = getRows('SELECT normalized_category, original_label, original_value, value, unit FROM rate_components WHERE rate_id = ? ORDER BY sort_order, id', rateId);
        const expectedComponents = item.components || [];
        const componentsMatch = JSON.stringify(oldComponents) === JSON.stringify(expectedComponents.map((component) => ({
          normalized_category: component.normalized_category,
          original_label: component.original_label,
          original_value: component.value,
          value: component.value,
          unit: component.unit || 'kWh'
        })));
        const rateMatches = existing.published_total === item.published_total
          && existing.source_url === item.source_url
          && existing.source_type === 'official_website'
          && existing.basis === item.basis
          && componentsMatch;
        if (rateMatches) continue;
        updateRate.run(item.published_total, item.published_total, sourceId, item.source_url,
          item.publication_date || null, updateSet.retrieved_at, reviewNote, item.basis,
          updateSet.retrieved_at, rateId);
        db.prepare('DELETE FROM rate_components WHERE rate_id = ?').run(rateId);
        audit('rate', rateId, 'official_rate_seed', existing, {
          du_id: item.du_id, effective_month: item.effective_month, customer_class_id: 'residential',
          published_total: item.published_total, source_id: sourceId, source_url: item.source_url,
          source_type: 'official_website', publication_date: item.publication_date || null,
          retrieved_at: updateSet.retrieved_at, review_status: 'approved', review_note: reviewNote,
          basis: item.basis, components: expectedComponents
        }, 'seed');
      } else {
        addRate.run(rateId, item.du_id, item.effective_month, item.published_total,
          item.published_total, sourceId, item.source_url, item.publication_date || null,
          updateSet.retrieved_at, reviewNote, item.basis, updateSet.retrieved_at);
        audit('rate', rateId, 'official_rate_seed', null, {
          du_id: item.du_id, effective_month: item.effective_month, customer_class_id: 'residential',
          published_total: item.published_total, source_id: sourceId, source_url: item.source_url,
          source_type: 'official_website', publication_date: item.publication_date || null,
          retrieved_at: updateSet.retrieved_at, review_status: 'approved', review_note: reviewNote,
          basis: item.basis, components: item.components || []
        }, 'seed');
      }

      (item.components || []).forEach((component, index) => {
        addComponent.run(`${rateId}-official-component-${index + 1}`, rateId,
          component.normalized_category, component.original_label, component.value,
          component.value, component.unit || 'kWh', (index + 1) * 10);
      });
    }
    setSetting(marker, 'done');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

seedInitialOfficialRateUpdates();

export function audit(entityType, entityId, action, before, after, changedBy = 'admin') {
  db.prepare(`INSERT INTO audit_log (id, entity_type, entity_id, action, before_json, after_json, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id(), entityType, entityId, action,
    before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after),
    changedBy, nowIso()
  );
}

export function getRow(sql, ...params) {
  return db.prepare(sql).get(...params);
}

export function getRows(sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, String(value), nowIso());
}

export function getSetting(key) {
  return getRow('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
}
