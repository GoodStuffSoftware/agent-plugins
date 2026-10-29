-- Per-account "Add my Gmail signature": 1 (the default) adds the account's Gmail signature to
-- send_message, reply and forward when the caller does not pass includeSignature; 0 does not.
-- One added column; existing accounts get the default (on). Nothing is rebuilt.
ALTER TABLE accounts ADD COLUMN signature_default INTEGER NOT NULL DEFAULT 1
  CHECK (signature_default IN (0, 1));
