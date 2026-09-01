ALTER TABLE database_target ADD COLUMN deleted_at timestamptz;
ALTER TABLE database_target DROP CONSTRAINT database_target_name_key;
CREATE UNIQUE INDEX database_target_active_name_idx ON database_target(lower(name)) WHERE deleted_at IS NULL;

