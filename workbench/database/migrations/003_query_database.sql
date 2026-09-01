ALTER TABLE query_run ADD COLUMN database_name text NOT NULL DEFAULT '';

UPDATE query_run q
SET database_name = t.database_name
FROM database_target t
WHERE t.id = q.target_id;

ALTER TABLE query_run ALTER COLUMN database_name DROP DEFAULT;
