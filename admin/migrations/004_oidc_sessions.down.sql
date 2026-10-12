DELETE FROM apg_sessions WHERE token_id IS NULL;
ALTER TABLE apg_sessions DROP CONSTRAINT apg_sessions_subject;
ALTER TABLE apg_sessions DROP COLUMN actor;
ALTER TABLE apg_sessions ALTER COLUMN token_id SET NOT NULL;
