CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region_code TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL DEFAULT 'Philippines',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS distribution_utilities (
  id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL REFERENCES regions(id) ON UPDATE CASCADE,
  full_name TEXT NOT NULL,
  acronym TEXT NOT NULL,
  du_type TEXT NOT NULL,
  service_area_notes TEXT NOT NULL DEFAULT '',
  identity_source_url TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(region_id, acronym)
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  du_id TEXT REFERENCES distribution_utilities(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  source_type TEXT NOT NULL,
  url TEXT,
  notes TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  ingest_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ingest_enabled IN (0, 1)),
  last_checked_at TEXT,
  last_check_status TEXT,
  last_check_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customer_classes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  comparison_default INTEGER NOT NULL DEFAULT 0 CHECK (comparison_default IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS effective_months (
  month TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  month_number INTEGER NOT NULL CHECK (month_number BETWEEN 1 AND 12),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rates (
  id TEXT PRIMARY KEY,
  du_id TEXT NOT NULL REFERENCES distribution_utilities(id) ON DELETE CASCADE,
  effective_month TEXT NOT NULL REFERENCES effective_months(month),
  customer_class_id TEXT NOT NULL REFERENCES customer_classes(id),
  currency TEXT NOT NULL DEFAULT 'PHP',
  unit TEXT NOT NULL DEFAULT 'kWh',
  published_total TEXT,
  published_total_original TEXT,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  source_url TEXT,
  source_type TEXT NOT NULL,
  publication_date TEXT,
  retrieved_at TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'manual',
  review_status TEXT NOT NULL DEFAULT 'needs_review',
  review_note TEXT NOT NULL DEFAULT '',
  basis TEXT NOT NULL DEFAULT 'Published total rate per kWh',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(du_id, effective_month, customer_class_id),
  CHECK (review_status IN ('draft', 'needs_review', 'approved', 'rejected'))
);

CREATE TABLE IF NOT EXISTS rate_components (
  id TEXT PRIMARY KEY,
  rate_id TEXT NOT NULL REFERENCES rates(id) ON DELETE CASCADE,
  normalized_category TEXT NOT NULL,
  original_label TEXT NOT NULL,
  original_value TEXT,
  value TEXT,
  value_state TEXT NOT NULL DEFAULT 'value',
  currency TEXT NOT NULL DEFAULT 'PHP',
  unit TEXT NOT NULL DEFAULT 'kWh',
  sort_order INTEGER NOT NULL DEFAULT 100,
  CHECK (value_state IN ('value', 'zero', 'missing', 'not_published'))
);

CREATE TABLE IF NOT EXISTS source_checks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  du_id TEXT REFERENCES distribution_utilities(id) ON DELETE SET NULL,
  effective_month TEXT REFERENCES effective_months(month),
  checked_at TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  message TEXT NOT NULL DEFAULT '',
  candidate_count INTEGER NOT NULL DEFAULT 0,
  CHECK (status IN ('checked', 'not_found', 'fetch_failed', 'parse_failed'))
);

CREATE TABLE IF NOT EXISTS ingest_candidates (
  id TEXT PRIMARY KEY,
  du_id TEXT NOT NULL REFERENCES distribution_utilities(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  effective_month TEXT NOT NULL REFERENCES effective_months(month),
  customer_class_id TEXT NOT NULL REFERENCES customer_classes(id),
  published_total TEXT,
  published_total_original TEXT,
  source_url TEXT NOT NULL,
  source_type TEXT NOT NULL,
  publication_date TEXT,
  retrieved_at TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  raw_excerpt TEXT NOT NULL DEFAULT '',
  parsed_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'needs_review',
  review_note TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (status IN ('needs_review', 'approved', 'rejected'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  changed_by TEXT NOT NULL DEFAULT 'system',
  changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rates_month_class ON rates(effective_month, customer_class_id, review_status);
CREATE INDEX IF NOT EXISTS idx_rates_du_month ON rates(du_id, effective_month);
CREATE INDEX IF NOT EXISTS idx_sources_du ON sources(du_id, enabled);
CREATE INDEX IF NOT EXISTS idx_checks_du_month ON source_checks(du_id, effective_month, checked_at);
CREATE INDEX IF NOT EXISTS idx_candidates_status_month ON ingest_candidates(status, effective_month);
