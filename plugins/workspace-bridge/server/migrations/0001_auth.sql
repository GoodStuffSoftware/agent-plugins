-- M4: owners, owner identities and sign-in flow state (ARCHITECTURE s.4). Times are Unix seconds.

CREATE TABLE owners (
  id TEXT PRIMARY KEY CHECK (
    length(id) = 18 AND id GLOB 'o_*' AND substr(id, 3) NOT GLOB '*[^a-z2-7]*'
  ),
  default_account_id TEXT,
  send_kill_switch INTEGER NOT NULL DEFAULT 0 CHECK (send_kill_switch IN (0, 1)),
  next_short_id INTEGER NOT NULL DEFAULT 1 CHECK (next_short_id >= 1),
  created_at INTEGER NOT NULL
) STRICT;

-- `sub` is written only while SETUP_MODE=true (UPDATE ... WHERE sub IS NULL).
CREATE TABLE owner_identities (
  email TEXT PRIMARY KEY CHECK (email = lower(email) AND instr(email, '@') > 1),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  sub TEXT UNIQUE,
  pinned_at INTEGER,
  last_login_at INTEGER
) STRICT;

CREATE INDEX owner_identities_owner_id ON owner_identities(owner_id);

-- id is the hex SHA-256 of `state`; rows are consumed with DELETE ... RETURNING, 10 min expiry.
CREATE TABLE flow_states (
  id TEXT PRIMARY KEY CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK (kind IN ('signin', 'link')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  binding TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX flow_states_expires_at ON flow_states(expires_at);
