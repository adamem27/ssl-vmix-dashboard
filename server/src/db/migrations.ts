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
  {
    version: 2,
    name: 'fleet_placeholders',
    sql: `
-- Labels shown in empty fleet places, e.g. "R1 C1" or "DRAW 3" (JSON array of 4 strings).
ALTER TABLE fleets ADD COLUMN placeholders TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    version: 3,
    name: 'captains_people_schedule',
    sql: `
ALTER TABLE sailors ADD COLUMN is_captain INTEGER NOT NULL DEFAULT 0;

-- Rebuild assets so people (lowerthirds) can own a photo too.
CREATE TABLE assets_v3 (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('team','sailor','person')),
  owner_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  storage_kind TEXT NOT NULL CHECK (storage_kind IN ('upload','path')),
  stored_rel_path TEXT,
  entered_path TEXT,
  original_filename TEXT NOT NULL DEFAULT '',
  mime TEXT,
  width INTEGER,
  height INTEGER,
  size_bytes INTEGER,
  checked_at TEXT,
  check_status TEXT NOT NULL DEFAULT 'unverified',
  check_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_type, owner_id, slot)
);
INSERT INTO assets_v3 SELECT * FROM assets;
DROP TABLE assets;
ALTER TABLE assets_v3 RENAME TO assets;

-- People shown in lowerthirds: commentators per language and anyone else.
CREATE TABLE people (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Day schedule: one row per race or slot.
CREATE TABLE schedule_items (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  time TEXT NOT NULL DEFAULT '',
  race TEXT NOT NULL DEFAULT '',
  fleet TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX schedule_items_date_idx ON schedule_items(event_id, date, time);
`,
  },
  {
    version: 4,
    name: 'team_nickname',
    sql: `ALTER TABLE teams ADD COLUMN nickname TEXT NOT NULL DEFAULT '';`,
  },
  {
    version: 5,
    name: 'png_generator',
    sql: `
-- Up to three gradient versions per team for generated PNG elements (spec: JSON {angle, stops}).
CREATE TABLE gen_gradients (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  variant INTEGER NOT NULL CHECK (variant BETWEEN 1 AND 3),
  spec TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, variant)
);

-- PNG elements rendered for every team (spec: JSON size, radius, opacity, stroke, pattern...).
CREATE TABLE gen_templates (
  id TEXT PRIMARY KEY,
  sort INTEGER NOT NULL DEFAULT 0,
  spec TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Files written to assets/generated, with a hash of what produced them.
CREATE TABLE gen_outputs (
  rel_path TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 6,
    name: 'fleet_size_pb3_ranking_weights',
    sql: `
-- Teams per fleet, set per fleet (was always 4). Slots are rebuilt so positions can go past 4.
ALTER TABLE fleets ADD COLUMN size INTEGER NOT NULL DEFAULT 4;
CREATE TABLE fleet_slots_v6 (
  fleet_id TEXT NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  fleet_set_id TEXT NOT NULL REFERENCES fleet_sets(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 16),
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (fleet_id, position),
  UNIQUE (fleet_set_id, team_id)
);
INSERT INTO fleet_slots_v6 (fleet_id, fleet_set_id, position, team_id) SELECT fleet_id, fleet_set_id, position, team_id FROM fleet_slots;
DROP TABLE fleet_slots;
ALTER TABLE fleet_slots_v6 RENAME TO fleet_slots;

ALTER TABLE sailors ADD COLUMN best_result_3 TEXT NOT NULL DEFAULT '';

-- Nation ranking: source values from worldofsailors.com, ranking_ovr typed by the operator (NULL = use source).
ALTER TABLE teams ADD COLUMN ranking_src TEXT;
ALTER TABLE teams ADD COLUMN ranking_points_src TEXT;
ALTER TABLE teams ADD COLUMN ranking_ovr TEXT;
ALTER TABLE teams ADD COLUMN ranking_fetched_at TEXT;

-- Declared weights in kg, same src/ovr rule as position and number.
ALTER TABLE declaration_members ADD COLUMN src_weight TEXT;
ALTER TABLE declaration_members ADD COLUMN ovr_weight TEXT;
ALTER TABLE declarations ADD COLUMN src_total_weight TEXT;
`,
  },
  {
    version: 7,
    name: 'graphic sets, line-ups, results',
    sql: `
-- General graphics with several versions (welcome, follow us, tickers, race officials, announcements): one row per version.
CREATE TABLE graphic_sets (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX graphic_sets_kind ON graphic_sets (event_id, kind, sort);

-- Line-up graphic of a team: slots (Helm, Tactician, ...) as JSON; filled by hand or by the sync-from-declaration command.
CREATE TABLE lineups (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{}',
  synced_at TEXT,
  synced_date TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, team_id)
);

-- Overall results of a group (fleet): race scores per team, points and order as JSON.
CREATE TABLE results (
  fleet_id TEXT PRIMARY KEY REFERENCES fleets(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 8,
    name: 'race results with times at marks',
    sql: `
-- One race of a group: mark names and each team's times at the marks, in finish order, as JSON.
CREATE TABLE race_runs (
  fleet_id TEXT NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  race INTEGER NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (fleet_id, race)
);
`,
  },
  {
    version: 9,
    name: 'people: name and surname',
    sql: `
-- People: the surname of its own (lt_comm_photo shows Name, then SURNAME); "Jan Kowalski" → Jan / Kowalski.
ALTER TABLE people ADD COLUMN surname TEXT NOT NULL DEFAULT '';
UPDATE people SET surname = trim(substr(name, instr(name, ' ') + 1)), name = substr(name, 1, instr(name, ' ') - 1) WHERE instr(name, ' ') > 0;
`,
  },
  {
    version: 10,
    name: 'a team in its group and in the last chance race',
    sql: `
-- A team once per group (was once per stage): the Last Chance Race of a stage takes teams of its other groups.
CREATE TABLE fleet_slots_v10 (
  fleet_id TEXT NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  fleet_set_id TEXT NOT NULL REFERENCES fleet_sets(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 16),
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (fleet_id, position),
  UNIQUE (fleet_id, team_id)
);
INSERT INTO fleet_slots_v10 (fleet_id, fleet_set_id, position, team_id) SELECT fleet_id, fleet_set_id, position, team_id FROM fleet_slots;
DROP TABLE fleet_slots;
ALTER TABLE fleet_slots_v10 RENAME TO fleet_slots;
`,
  },
];
