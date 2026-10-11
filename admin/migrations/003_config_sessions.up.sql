-- Declarative configuration revisions (spec §14.3) and UI sessions (spec API-5).

-- One row per `apply`, `sync` or `rollback` of a workspace. `document` is the
-- workspace's part of what was submitted, with every secret sealed under
-- APG_SECRET_KEY; `state_hash` is the hash of the workspace's exported state
-- right after the change, which is what drift is measured against (DEC-9).
CREATE TABLE apg_config_revisions (
    id           UUID        PRIMARY KEY,
    workspace_id UUID        NOT NULL REFERENCES apg_workspaces(id) ON DELETE CASCADE,
    number       INTEGER     NOT NULL,
    action       TEXT        NOT NULL CHECK (action IN ('apply', 'sync', 'rollback')),
    prune        BOOLEAN     NOT NULL DEFAULT false,
    select_label JSONB,
    document     JSONB       NOT NULL,
    hash         TEXT        NOT NULL,
    state_hash   TEXT        NOT NULL,
    summary      JSONB       NOT NULL,
    message      TEXT,
    actor_kind   TEXT        NOT NULL,
    actor_id     TEXT        NOT NULL,
    actor_name   TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, number)
);

-- A browser session stands for the admin token it was opened with: revoking
-- the token ends its sessions. Only the hash of the cookie value is stored.
CREATE TABLE apg_sessions (
    id_hash    TEXT        PRIMARY KEY,
    token_id   UUID        NOT NULL REFERENCES apg_admin_tokens(id) ON DELETE CASCADE,
    csrf       TEXT        NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX apg_sessions_expires ON apg_sessions (expires_at);
