ALTER TABLE sessions ADD COLUMN import_key TEXT;
CREATE UNIQUE INDEX sessions_import_key ON sessions(import_key)
WHERE deleted = 0 AND import_key IS NOT NULL;
