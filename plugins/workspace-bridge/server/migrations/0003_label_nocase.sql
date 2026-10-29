-- Free-form labels: two labels of one owner may not differ only by case. The existing
-- UNIQUE (owner_id, label) is case-sensitive and cannot change without rebuilding the table
-- (which would cascade-delete sealed tokens), so add an expression index instead.
CREATE UNIQUE INDEX accounts_owner_label_nocase ON accounts (owner_id, lower(label));
