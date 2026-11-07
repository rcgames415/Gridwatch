import postgres from 'postgres';
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

let client;
let localSqlite;
let localQueue = Promise.resolve();
let initialization;

function enqueueLocal(work) {
  const task = localQueue.then(work, work);
  localQueue = task.catch(() => {});
  return task;
}

function getClient() {
  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (connectionString?.startsWith('postgres://') || connectionString?.startsWith('postgresql://')) {
    if (!client) {
    client = postgres(connectionString, {
      max: 1,
      prepare: false,
      ssl: 'require',
      connect_timeout: 15,
      idle_timeout: 20,
      fetch_types: false
    });
    }
    return client;
  }
  if (process.env.VERCEL === '1') throw new Error('Missing POSTGRES_URL. Copy the Supabase Transaction Pooler connection string into the Vercel environment settings.');
  if (!localSqlite) {
    const path = resolve(process.env.DATABASE_PATH || resolve(root, 'data/gridwatch.sqlite'));
    mkdirSync(dirname(path), { recursive: true });
    localSqlite = new DatabaseSync(path);
    localSqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  }
  return localSqlite;
}

function prepareSql(source) {
  let index = 0;
  let sql = source.replace(/\?/g, () => `$${++index}`);
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql)) {
    sql = sql.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO');
    if (!/\bON\s+CONFLICT\b/i.test(sql)) sql = `${sql.trim().replace(/;$/, '')} ON CONFLICT DO NOTHING`;
  }
  return sql;
}

function executor(connection) {
  const sqlite = connection instanceof DatabaseSync;
  return {
    async rows(source, ...params) {
      return sqlite ? connection.prepare(source).all(...params) : connection.unsafe(prepareSql(source), params);
    },
    async row(source, ...params) {
      return sqlite ? connection.prepare(source).get(...params) : (await connection.unsafe(prepareSql(source), params))[0];
    },
    async run(source, ...params) {
      const result = sqlite ? connection.prepare(source).run(...params) : await connection.unsafe(prepareSql(source), params);
      return { changes: Number(result.changes ?? result.count ?? 0), rows: result };
    }
  };
}

export async function getRows(sql, ...params) {
  const connection = getClient();
  return connection instanceof DatabaseSync
    ? enqueueLocal(() => executor(connection).rows(sql, ...params))
    : executor(connection).rows(sql, ...params);
}

export async function getRow(sql, ...params) {
  const connection = getClient();
  return connection instanceof DatabaseSync
    ? enqueueLocal(() => executor(connection).row(sql, ...params))
    : executor(connection).row(sql, ...params);
}

export async function run(sql, ...params) {
  const connection = getClient();
  return connection instanceof DatabaseSync
    ? enqueueLocal(() => executor(connection).run(sql, ...params))
    : executor(connection).run(sql, ...params);
}

export async function transaction(callback) {
  const connection = getClient();
  if (connection instanceof DatabaseSync) {
    return enqueueLocal(async () => {
      connection.exec('BEGIN');
      try {
        const result = await callback(executor(connection));
        connection.exec('COMMIT');
        return result;
      } catch (error) {
        connection.exec('ROLLBACK');
        throw error;
      }
    });
  }
  return connection.begin(async (tx) => callback(executor(tx)));
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

export async function ensureMonth(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Month must use YYYY-MM format.');
  const [year, monthNumber] = month.split('-').map(Number);
  await run('INSERT INTO effective_months (month, year, month_number) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', month, year, monthNumber);
}

async function insertMany(table, columns, records, { conflict = 'DO NOTHING', chunkSize = 400 } = {}) {
  for (let start = 0; start < records.length; start += chunkSize) {
    const batch = records.slice(start, start + chunkSize);
    if (!batch.length) continue;
    const values = [];
    const rows = batch.map((record) => `(${record.map((value) => {
      values.push(value);
      return '?';
    }).join(', ')})`);
    await run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${rows.join(', ')} ON CONFLICT ${conflict}`, ...values);
  }
}

async function seedInitialData() {
  const seed = JSON.parse(readFileSync(resolve(root, 'seed/region-iii.json'), 'utf8'));
  await insertMany('regions', ['id', 'name', 'region_code'], [[seed.region.id, seed.region.name, seed.region.region_code]]);
  await insertMany('customer_classes', ['id', 'name', 'comparison_default', 'sort_order'],
    seed.customer_classes.map((item) => [item.id, item.name, item.comparison_default, item.sort_order]));

  const utilities = seed.utilities.map((item) => [item.id, seed.region.id, item.full_name, item.acronym,
    item.du_type, item.service_area_notes, seed.references.doe_ddp]);
  await insertMany('distribution_utilities',
    ['id', 'region_id', 'full_name', 'acronym', 'du_type', 'service_area_notes', 'identity_source_url'], utilities);

  const sources = [];
  const addSource = (sourceId, duId, label, sourceType, url, notes, ingestEnabled = 0) =>
    sources.push([sourceId, duId, label, sourceType, url, notes, 1, ingestEnabled ? 1 : 0]);
  for (const item of seed.utilities) {
    addSource(`official-${item.id}`, item.id, `${item.acronym} official public website`, 'official_website', item.website,
      item.source_note || 'Seeded from a public DU website or an official agency profile.', item.ingest_enabled ?? 1);
    addSource(`doe-${item.id}`, item.id, 'DOE 2023–2032 DDP identity profile', 'regulatory_reference', seed.references.doe_ddp,
      'DOE distribution development plan. Identity reference, not a monthly DU rate announcement.');
    addSource(`doe-rates-${item.id}`, item.id, 'DOE electricity rates data reference', 'regulatory_reference', seed.references.doe_electricity_rates,
      'DOE monthly DU rate dataset reference. Government cross-check, not a DU announcement; not used by the announcement ingestor.');
    const isPrivate = item.du_type === 'Private utility' || item.du_type === 'Ecozone utility';
    addSource(`erc-${item.id}`, item.id, `ERC ${isPrivate ? 'approved rate schedule' : 'Region III DU profile'}`,
      'regulatory_reference', isPrivate ? seed.references.erc_private_schedules : seed.references.erc_cooperatives,
      'Identity/regulatory reference. This is not treated as a monthly rate announcement.');
  }
  for (const source of seed.social_sources || []) addSource(source.id, source.du_id, source.label, source.source_type,
    source.url, source.notes || '');
  for (const source of seed.third_party_sources || []) addSource(source.id, source.du_id, source.label, source.source_type,
    source.url, source.notes || '', source.ingest_enabled || (seed.third_party_ingest_enabled && source.url?.startsWith('https://smartenergyph.com/electricity/rates/')));
  addSource('third-party-tipidkuryente-presyo', null, 'TipidKuryente monthly dataset / PRESYO-PH', 'third_party_lead',
    'https://tipidkuryente.ph/electricity-rate-trends',
    'Historical residential rate series downloaded from TipidKuryente’s public CSV and credited to PRESYO-PH. The CSV links to its tracker source for each row. Standardized third-party data, not direct DU announcements; attribution is required.');
  await insertMany('sources', ['id', 'du_id', 'label', 'source_type', 'url', 'notes', 'enabled', 'ingest_enabled'], sources);
}

async function seedHistoricalRates() {
  const history = JSON.parse(readFileSync(resolve(root, 'seed/region-iii-historical-rates.json'), 'utf8'));
  const note = `${history.source_note} Each record is a value present in the source CSV; months without a value remain blank.`;
  const basis = 'Standardized residential rate per kWh (PRESYO-PH via TipidKuryente)';
  const records = history.rates.map((item) => [
    `seed-presyo-${item.du_id}-${item.effective_month}`, item.du_id, item.effective_month, 'residential', 'PHP', 'kWh',
    item.published_total, item.published_total, history.source_registry_id, item.source_url, 'third_party_lead', null,
    history.retrieved_at, 'third_party_dataset_csv', 'approved', note, basis, history.retrieved_at
  ]);
  const months = [...new Set(records.map((record) => record[2]))];
  for (const month of months) await ensureMonth(month);
  await insertMany('rates', ['id', 'du_id', 'effective_month', 'customer_class_id', 'currency', 'unit', 'published_total',
    'published_total_original', 'source_id', 'source_url', 'source_type', 'publication_date', 'retrieved_at', 'extraction_status',
    'review_status', 'review_note', 'basis', 'updated_at'], records);
}

async function seedRateSnapshot() {
  const snapshot = JSON.parse(readFileSync(resolve(root, 'seed/region-iii-rate-snapshot.json'), 'utf8'));
  for (const item of snapshot.rates) {
    await ensureMonth(item.effective_month);
    const rateId = `seed-smartenergy-${item.du_id}-${item.effective_month}`;
    const existing = await getRow('SELECT id FROM rates WHERE du_id = ? AND effective_month = ? AND customer_class_id = ?',
      item.du_id, item.effective_month, 'residential');
    if (existing) continue;
    const sourceId = `third-party-smartenergyph-${item.du_id}`;
    const note = `${snapshot.source_note} This entry was reviewed against the linked SmartEnergyPH profile on 2026-11-07; its underlying DU announcement was not independently rechecked by Gridwatch.`;
    await run(`INSERT INTO rates
      (id, du_id, effective_month, customer_class_id, currency, unit, published_total, published_total_original,
       source_id, source_url, source_type, publication_date, retrieved_at, extraction_status, review_status,
       review_note, basis, updated_at)
      VALUES (?, ?, ?, 'residential', 'PHP', 'kWh', ?, ?, ?, ?, 'third_party_lead', NULL, ?,
       'third_party_compiled', 'approved', ?, 'Residential all-in rate per kWh, reported by SmartEnergyPH', ?)
      ON CONFLICT DO NOTHING`, rateId, item.du_id, item.effective_month, item.published_total, item.published_total,
    sourceId, item.source_url, snapshot.retrieved_at, note, snapshot.retrieved_at);
    await run(`INSERT INTO rate_components
      (id, rate_id, normalized_category, original_label, original_value, value, value_state, currency, unit, sort_order)
      VALUES (?, ?, 'generation', 'Generation charge', ?, ?, 'value', 'PHP', 'kWh', 10) ON CONFLICT DO NOTHING`,
    `${rateId}-generation`, rateId, item.generation, item.generation);
  }
}

async function seedOfficialRateUpdates() {
  const marker = 'seed:region-iii-official-october-2026:v1';
  if (await getSetting(marker) === 'done') return;
  const updateSet = JSON.parse(readFileSync(resolve(root, 'seed/region-iii-official-rate-updates.json'), 'utf8'));
  await transaction(async (tx) => {
    for (const item of updateSet.rates) {
      const [year, monthNumber] = item.effective_month.split('-').map(Number);
      await tx.run('INSERT INTO effective_months (month, year, month_number) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', item.effective_month, year, monthNumber);
      const sourceId = `official-${item.du_id}`;
      const sourceExists = await tx.row('SELECT id FROM sources WHERE id = ?', sourceId);
      const duExists = await tx.row('SELECT id FROM distribution_utilities WHERE id = ?', item.du_id);
      if (!sourceExists || !duExists) continue;
      const existing = await tx.row(`SELECT * FROM rates WHERE du_id = ? AND effective_month = ? AND customer_class_id = 'residential'`, item.du_id, item.effective_month);
      const seedId = `seed-official-${item.du_id}-${item.effective_month}`;
      const reviewNote = `${updateSet.source_note} Published rate total is retained separately from its listed components.`;
      let rateId = seedId;
      const seeded = existing && (existing.id.startsWith('seed-smartenergy-') || existing.id.startsWith('seed-presyo-') || existing.id.startsWith('seed-official-'));
      if (existing && !seeded) continue;
      if (existing) {
        rateId = existing.id;
        const beforeComponents = await tx.rows('SELECT * FROM rate_components WHERE rate_id = ? ORDER BY sort_order, id', rateId);
        const expected = item.components || [];
        const sameComponents = JSON.stringify(beforeComponents.map((component) => ({
          normalized_category: component.normalized_category,
          original_label: component.original_label,
          original_value: component.original_value,
          value: component.value,
          unit: component.unit
        }))) === JSON.stringify(expected.map((component) => ({
          normalized_category: component.normalized_category, original_label: component.original_label,
          original_value: component.value, value: component.value, unit: component.unit || 'kWh'
        })));
        const matches = existing.published_total === item.published_total && existing.source_url === item.source_url
          && existing.source_type === 'official_website' && existing.basis === item.basis && sameComponents;
        if (matches) continue;
        await tx.run(`UPDATE rates SET published_total=?, published_total_original=?, source_id=?, source_url=?, source_type='official_website',
          publication_date=?, retrieved_at=?, extraction_status='manual_official_seed', review_status='approved', review_note=?, basis=?, updated_at=? WHERE id=?`,
        item.published_total, item.published_total, sourceId, item.source_url, item.publication_date || null,
        updateSet.retrieved_at, reviewNote, item.basis, updateSet.retrieved_at, rateId);
        await tx.run('DELETE FROM rate_components WHERE rate_id = ?', rateId);
        await auditWith(tx, 'rate', rateId, 'official_rate_seed', existing, {
          du_id: item.du_id, effective_month: item.effective_month, customer_class_id: 'residential',
          published_total: item.published_total, source_id: sourceId, source_url: item.source_url,
          source_type: 'official_website', publication_date: item.publication_date || null,
          retrieved_at: updateSet.retrieved_at, review_status: 'approved', review_note: reviewNote,
          basis: item.basis, components: expected
        }, 'seed');
      } else {
        await tx.run(`INSERT INTO rates
          (id, du_id, effective_month, customer_class_id, currency, unit, published_total, published_total_original,
           source_id, source_url, source_type, publication_date, retrieved_at, extraction_status, review_status,
           review_note, basis, updated_at)
          VALUES (?, ?, ?, 'residential', 'PHP', 'kWh', ?, ?, ?, ?, 'official_website', ?, ?,
          'manual_official_seed', 'approved', ?, ?, ?) ON CONFLICT DO NOTHING`,
        rateId, item.du_id, item.effective_month, item.published_total, item.published_total, sourceId, item.source_url,
        item.publication_date || null, updateSet.retrieved_at, reviewNote, item.basis, updateSet.retrieved_at);
        await auditWith(tx, 'rate', rateId, 'official_rate_seed', null, {
          du_id: item.du_id, effective_month: item.effective_month, customer_class_id: 'residential',
          published_total: item.published_total, source_id: sourceId, source_url: item.source_url,
          source_type: 'official_website', publication_date: item.publication_date || null,
          retrieved_at: updateSet.retrieved_at, review_status: 'approved', review_note: reviewNote,
          basis: item.basis, components: item.components || []
        }, 'seed');
      }
      const componentRows = (item.components || []).map((component, index) => [
        `${rateId}-official-component-${index + 1}`, rateId, component.normalized_category, component.original_label,
        component.value, component.value, 'value', 'PHP', component.unit || 'kWh', (index + 1) * 10
      ]);
      await insertManyUsing(tx, 'rate_components', ['id', 'rate_id', 'normalized_category', 'original_label', 'original_value', 'value', 'value_state', 'currency', 'unit', 'sort_order'], componentRows);
    }
    await tx.run(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at`, marker, 'done', nowIso());
  });
}

async function insertManyUsing(tx, table, columns, records) {
  for (const record of records) {
    const placeholders = record.map(() => '?').join(', ');
    await tx.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, ...record);
  }
}

async function auditWith(tx, entityType, entityId, action, before, after, changedBy = 'admin') {
  await tx.run(`INSERT INTO audit_log (id, entity_type, entity_id, action, before_json, after_json, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id(), entityType, entityId, action,
  before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), changedBy, nowIso());
}

export async function audit(entityType, entityId, action, before, after, changedBy = 'admin') {
  const connection = getClient();
  const write = () => auditWith(executor(connection), entityType, entityId, action, before, after, changedBy);
  return connection instanceof DatabaseSync ? enqueueLocal(write) : write();
}

export async function setSetting(key, value) {
  await run(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at`, key, String(value), nowIso());
}

export async function getSetting(key) {
  return (await getRow('SELECT value FROM settings WHERE key = ?', key))?.value ?? null;
}

async function applyMigrations() {
  await run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  for (const filename of readdirSync(resolve(root, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    if (await getRow('SELECT filename FROM schema_migrations WHERE filename = ?', filename)) continue;
    const source = readFileSync(resolve(root, 'migrations', filename), 'utf8').replace(/^\s*PRAGMA[^;]*;\s*/i, '');
    await transaction(async (tx) => {
      for (const statement of source.split(';').map((item) => item.trim()).filter(Boolean)) await tx.run(statement);
      await tx.run('INSERT INTO schema_migrations (filename) VALUES (?) ON CONFLICT DO NOTHING', filename);
    });
  }
}

async function initialize() {
  await applyMigrations();
  await seedInitialData();
  await seedHistoricalRates();
  await seedRateSnapshot();
  await seedOfficialRateUpdates();
  await ensureMonth(currentManilaMonth());
}

export function initializeDatabase() {
  initialization ||= initialize().catch((error) => {
    initialization = null;
    throw error;
  });
  return initialization;
}

export async function closeDatabase() {
  if (client) await client.end({ timeout: 5 });
  if (localSqlite) localSqlite.close();
}
