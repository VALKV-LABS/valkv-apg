-- Sessions opened through single sign-on (spec API-5) stand for a person, not
-- for an admin token: they hold who the person is and what they were granted
-- at sign-in, and no token.
ALTER TABLE apg_sessions ALTER COLUMN token_id DROP NOT NULL;
ALTER TABLE apg_sessions ADD COLUMN actor JSONB;
ALTER TABLE apg_sessions ADD CONSTRAINT apg_sessions_subject CHECK ((token_id IS NULL) <> (actor IS NULL));
