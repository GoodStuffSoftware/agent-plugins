-- M6: linked accounts, sealed Google tokens, sendAs cache, audit log, rate counters and pending
-- actions (ARCHITECTURE s.4). Times are Unix seconds.

-- One row per linked mailbox. No token columns: tokens live sealed in account_tokens.
-- `id` is `ac_` plus 16 base32 characters, so it never contains the AAD separator `|`.
-- `short_id` comes from owners.next_short_id and is never reused after unlink (s.3.4).
CREATE TABLE accounts (
  id TEXT PRIMARY KEY CHECK (
    length(id) = 19 AND id GLOB 'ac_*' AND substr(id, 4) NOT GLOB '*[^a-z2-7]*'
  ),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  short_id INTEGER NOT NULL CHECK (short_id BETWEEN 1 AND 999999999),
  label TEXT NOT NULL CHECK (label <> ''),
  address TEXT NOT NULL CHECK (address = lower(address) AND instr(address, '@') > 1),
  provider TEXT NOT NULL CHECK (provider IN ('google', 'msgraph', 'imap')),
  provider_sub TEXT,
  components TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(components)),
  granted_scopes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'needs_relink')),
  send_as_fetched_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_id, short_id),
  UNIQUE (owner_id, label),
  UNIQUE (owner_id, address)
) STRICT;

-- AES-256-GCM, AAD `ownerId|accountId|kind`, a fresh 12-byte IV per seal (src/core/crypto.ts).
-- key_version 1 is TOKEN_KEK, version N is TOKEN_KEK_vN.
CREATE TABLE account_tokens (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('refresh', 'access')),
  ciphertext BLOB NOT NULL CHECK (length(ciphertext) >= 16),
  iv BLOB NOT NULL CHECK (length(iv) = 12),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, kind)
) STRICT;

-- Gmail sendAs entries, refreshed on link and after 24 h. `email` is lowercase.
CREATE TABLE send_as (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL CHECK (email = lower(email) AND instr(email, '@') > 1),
  display_name TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  verification_status TEXT,
  reply_to TEXT,
  PRIMARY KEY (account_id, email)
) STRICT;

-- No bodies. owner_id is NULL for a refused sign-in. No foreign keys: rows outlive an unlink.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  owner_id TEXT,
  account_id TEXT,
  tool TEXT NOT NULL,
  client_id TEXT,
  grant_id TEXT,
  from_addr TEXT,
  to_addrs TEXT,
  cc_addrs TEXT,
  bcc_addrs TEXT,
  subject TEXT,
  provider_ref TEXT,
  result TEXT NOT NULL,
  detail TEXT
) STRICT;

CREATE INDEX audit_log_owner_id_at ON audit_log(owner_id, at);

-- Fixed windows, one atomic upsert per hit:
-- INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count.
CREATE TABLE rate_counters (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 1),
  PRIMARY KEY (bucket, window_start)
) STRICT;

-- Decided only on /approvals/:id with an owner session and CSRF token.
CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY CHECK (length(id) > 3 AND id GLOB 'pa_*'),
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  params TEXT NOT NULL CHECK (json_valid(params)),
  preview TEXT NOT NULL CHECK (json_valid(preview)),
  client_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed')
  ),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  result TEXT CHECK (result IS NULL OR json_valid(result))
) STRICT;

-- Cover the foreign keys so an unlink or owner delete does not scan the table.
CREATE INDEX pending_actions_owner_id ON pending_actions(owner_id, created_at);
CREATE INDEX pending_actions_account_id ON pending_actions(account_id);
