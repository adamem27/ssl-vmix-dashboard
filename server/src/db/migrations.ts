/**
 * Ordered schema migrations. Never edit a migration that has shipped:
 * add a new entry at the end instead. Applied versions are tracked in `schema_migrations`.
 */
export const migrations: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Europe/Warsaw',
  -- Year used to complete source dates that have no year (e.g. "11-06").
  year INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  notes TEXT NOT NULL DEFAULT '',
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX teams_code_uq ON teams(code COLLATE NOCASE);

CREATE TABLE sailors (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  name_key TEXT NOT NULL DEFAULT '',     -- normalized "first last" used for matching
  default_position TEXT NOT NULL DEFAULT '',
  default_number TEXT NOT NULL DEFAULT '',
  best_result_1 TEXT NOT NULL DEFAULT '',
  best_result_2 TEXT NOT NULL DEFAULT '',
  source_ref TEXT,                       -- identifier from an external source, if any
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX sailors_team_idx ON sailors(team_id);
CREATE INDEX sailors_name_key_idx ON sailors(team_id, name_key);

-- Spellings seen in a source that an operator confirmed belong to a sailor.
CREATE TABLE sailor_source_aliases (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name_key TEXT NOT NULL,
  sailor_id TEXT NOT NULL REFERENCES sailors(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, name_key)
);

-- One row per filled graphic slot. owner_type: 'team' | 'sailor'.
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('team','sailor')),
  owner_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  storage_kind TEXT NOT NULL CHECK (storage_kind IN ('upload','path')),
  stored_rel_path TEXT,                  -- relative to the assets dir (uploads only)
  entered_path TEXT,                     -- path typed by the operator (path assets only)
  original_filename TEXT NOT NULL DEFAULT '',
  mime TEXT,
  width INTEGER,
  height INTEGER,
  size_bytes INTEGER,
  checked_at TEXT,
  check_status TEXT NOT NULL DEFAULT 'unverified', -- stored | reachable | unverified | invalid
  check_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_type, owner_id, slot)
);

CREATE TABLE fleet_sets (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE fleets (
  id TEXT PRIMARY KEY,
  fleet_set_id TEXT NOT NULL REFERENCES fleet_sets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- position 1..4. A team appears at most once per fleet set (and so once per fleet).
CREATE TABLE fleet_slots (
  fleet_id TEXT NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  fleet_set_id TEXT NOT NULL REFERENCES fleet_sets(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 4),
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (fleet_id, position),
  UNIQUE (fleet_set_id, team_id)
);

CREATE TABLE declarations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  declaration_date TEXT NOT NULL,        -- YYYY-MM-DD, the sailing day (not the fetch date)
  origin TEXT NOT NULL CHECK (origin IN ('manual','import')),
  source_ref TEXT,                       -- e.g. detail page URL
  source_posted_raw TEXT,                -- "Posted" value as published (no year)
  source_fetched_at TEXT,                -- last time the source confirmed this declaration
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (event_id, team_id, declaration_date)
);

-- Source values (src_*) are owned by the importer; manual overrides (ovr_*) by the operator.
-- The effective value is COALESCE(ovr, src). Import never writes ovr_* columns.
CREATE TABLE declaration_members (
  id TEXT PRIMARY KEY,
  declaration_id TEXT NOT NULL REFERENCES declarations(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK (origin IN ('manual','import')),
  sort INTEGER NOT NULL DEFAULT 0,
  source_name TEXT,                      -- name exactly as published
  source_key TEXT,                       -- normalized name (identity of an imported row)
  src_position TEXT,
  src_number TEXT,
  in_source INTEGER NOT NULL DEFAULT 1,  -- 0 when the last import no longer lists this row
  sailor_id TEXT REFERENCES sailors(id) ON DELETE SET NULL,
  sailor_locked INTEGER NOT NULL DEFAULT 0, -- 1 = operator chose the sailor; import keeps it
  match_status TEXT NOT NULL DEFAULT 'manual', -- matched | unmatched | ambiguous | manual
  ovr_position TEXT,
  ovr_number TEXT,
  ovr_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX decl_members_decl_idx ON declaration_members(declaration_id);
CREATE UNIQUE INDEX decl_members_source_uq ON declaration_members(declaration_id, source_key) WHERE source_key IS NOT NULL;

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,                 -- auto | manual
  importer TEXT NOT NULL,
  source_url TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,                  -- running | success | error
  error_message TEXT,
  summary TEXT                           -- JSON ImportSummary
);
CREATE INDEX sync_runs_started_idx ON sync_runs(started_at);
`,
  },
];
