-- Hold sends to new recipients: the addresses an account has sent to (or Google confirmed it
-- knows), and the owner's allow list of addresses and domains. New tables only; nothing is rebuilt.
CREATE TABLE known_recipients (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  source TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (account_id, address)
);

CREATE TABLE send_allow (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('address', 'domain')),
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, kind, value)
);
