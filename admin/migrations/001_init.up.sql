-- valkv-apg control-plane schema, version 1 (spec §16).
--
-- Every resource table has the common columns of spec §4.1 plus `spec`, the
-- kind-specific body as JSONB. Columns that carry a rule the database can
-- enforce (uniqueness, a foreign key, an enumeration) are real columns.

CREATE TABLE apg_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- Identity of this control plane. Nodes store it beside their checkpoint and
-- resync when it changes (spec CFG-10).
INSERT INTO apg_meta (key, value) VALUES ('cluster_id', gen_random_uuid()::text);
-- Sequence number of the newest committed changelog row. Updated in the same
-- transaction as every append; the row lock also makes changelog writers
-- commit in sequence order, so a reader can never skip a late-committing row.
INSERT INTO apg_meta (key, value) VALUES ('last_seq', '0');

-- ── Workspaces ───────────────────────────────────────────────────────────────

CREATE TABLE apg_workspaces (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT        NOT NULL UNIQUE,
    slug       TEXT        NOT NULL UNIQUE,
    system     BOOLEAN     NOT NULL DEFAULT false,
    status     TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    limits     JSONB       NOT NULL DEFAULT '{}',
    labels     JSONB       NOT NULL DEFAULT '{}',
    metadata   JSONB       NOT NULL DEFAULT '{}',
    revision   INTEGER     NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Exactly one system workspace.
CREATE UNIQUE INDEX apg_workspaces_one_system ON apg_workspaces (system) WHERE system;
INSERT INTO apg_workspaces (name, slug, system) VALUES ('default', 'default', true);

-- ── Certificates ─────────────────────────────────────────────────────────────

CREATE TABLE apg_certificates (
    id                 UUID        PRIMARY KEY,
    workspace_id       UUID        NOT NULL REFERENCES apg_workspaces(id) ON DELETE CASCADE,
    name               TEXT        NOT NULL,
    cert_pem           TEXT        NOT NULL,
    key_ciphertext     TEXT        NOT NULL,   -- AES-256-GCM, never clear (spec SEC-1)
    hosts              TEXT[]      NOT NULL DEFAULT '{}',
    not_before         TIMESTAMPTZ NOT NULL,
    not_after          TIMESTAMPTZ NOT NULL,
    issuer             TEXT        NOT NULL DEFAULT '',
    fingerprint_sha256 TEXT        NOT NULL,
    source             TEXT        NOT NULL DEFAULT 'manual' CHECK (source IN ('acme', 'manual')),
    labels             JSONB       NOT NULL DEFAULT '{}',
    metadata           JSONB       NOT NULL DEFAULT '{}',
    revision           INTEGER     NOT NULL DEFAULT 1,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, name)
);
CREATE INDEX apg_certificates_not_after ON apg_certificates (not_after);

CREATE TABLE apg_ca_certificates (
    id           UUID        PRIMARY KEY,
    workspace_id UUID        NOT NULL REFERENCES apg_workspaces(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    cert_pem     TEXT        NOT NULL,
    labels       JSONB       NOT NULL DEFAULT '{}',
    metadata     JSONB       NOT NULL DEFAULT '{}',
    revision     INTEGER     NOT NULL DEFAULT 1,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, name)
);

-- ── Domains ──────────────────────────────────────────────────────────────────

CREATE TABLE apg_domains (
    id             UUID        PRIMARY KEY,
    workspace_id   UUID        NOT NULL REFERENCES apg_workspaces(id) ON DELETE CASCADE,
    name           TEXT        NOT NULL,
    hostname       TEXT        NOT NULL UNIQUE,   -- one owner across all workspaces (spec DOM-1)
    tls_mode       TEXT        NOT NULL DEFAULT 'acme' CHECK (tls_mode IN ('acme', 'manual', 'none')),
    tls_challenge  TEXT        NOT NULL DEFAULT 'http01' CHECK (tls_challenge IN ('http01', 'dns01')),
    certificate_id UUID        REFERENCES apg_certificates(id) ON DELETE RESTRICT,
    status         TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed')),
    status_reason  TEXT,
    verification   JSONB       NOT NULL DEFAULT '{"method":"none"}',
    labels         JSONB       NOT NULL DEFAULT '{}',
    metadata       JSONB       NOT NULL DEFAULT '{}',
    revision       INTEGER     NOT NULL DEFAULT 1,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, name),
    CHECK (tls_mode <> 'manual' OR certificate_id IS NOT NULL),
    CHECK (NOT (hostname LIKE '*.%' AND tls_mode = 'acme' AND tls_challenge = 'http01'))
);
CREATE INDEX apg_domains_workspace ON apg_domains (workspace_id);

-- ── Services ─────────────────────────────────────────────────────────────────
-- Backends live inside `spec` so a service and its backends change atomically
-- and reach nodes as one event.

CREATE TABLE apg_services (
    id           UUID        PRIMARY KEY,
    workspace_id UUID        NOT NULL REFERENCES apg_workspaces(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    shared       BOOLEAN     NOT NULL DEFAULT false,
    spec         JSONB       NOT NULL,
    labels       JSONB       NOT NULL DEFAULT '{}',
    metadata     JSONB       NOT NULL DEFAULT '{}',
    revision     INTEGER     NOT NULL DEFAULT 1,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, name),
    CHECK (jsonb_typeof(spec->'backends') = 'array' AND jsonb_array_length(spec->'backends') >= 1)
);

-- ── Routes ───────────────────────────────────────────────────────────────────

CREATE TABLE apg_routes (
    id           UUID        PRIMARY KEY,
    workspace_id UUID        NOT NULL REFERENCES apg_workspaces(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    priority     INTEGER     NOT NULL DEFAULT 0,
    enabled      BOOLEAN     NOT NULL DEFAULT true,
    cache_epoch  INTEGER     NOT NULL DEFAULT 0,
    spec         JSONB       NOT NULL,
    labels       JSONB       NOT NULL DEFAULT '{}',
    metadata     JSONB       NOT NULL DEFAULT '{}',
    revision     INTEGER     NOT NULL DEFAULT 1,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, name)
);

-- Which services a route sends traffic to: one row for `service`, several for
-- `split`. The foreign key is what makes deleting a referenced service fail.
CREATE TABLE apg_route_services (
    route_id   UUID    NOT NULL REFERENCES apg_routes(id)   ON DELETE CASCADE,
    service_id UUID    NOT NULL REFERENCES apg_services(id) ON DELETE RESTRICT,
    weight     INTEGER NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 1000),
    PRIMARY KEY (route_id, service_id)
);
CREATE INDEX apg_route_services_service ON apg_route_services (service_id);

-- ── Consumers and credentials ────────────────────────────────────────────────

CREATE TABLE apg_consumers (
    id           UUID        PRIMARY KEY,
    workspace_id UUID        NOT NULL REFERENCES apg_workspaces(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    custom_id    TEXT,
    groups       TEXT[]      NOT NULL DEFAULT '{}',
    labels       JSONB       NOT NULL DEFAULT '{}',
    metadata     JSONB       NOT NULL DEFAULT '{}',
    revision     INTEGER     NOT NULL DEFAULT 1,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, name),
    UNIQUE (workspace_id, custom_id)
);

CREATE TABLE apg_credentials (
    id            UUID        PRIMARY KEY,
    workspace_id  UUID        NOT NULL REFERENCES apg_workspaces(id) ON DELETE CASCADE,
    consumer_id   UUID        NOT NULL REFERENCES apg_consumers(id) ON DELETE CASCADE,
    name          TEXT        NOT NULL,
    type          TEXT        NOT NULL CHECK (type IN ('key', 'basic', 'mtls')),
    key_hash      TEXT        UNIQUE,        -- SHA-256 of an API key
    key_prefix    TEXT,
    username      TEXT,
    password_hash TEXT,                      -- argon2id
    identity      TEXT,
    enabled       BOOLEAN     NOT NULL DEFAULT true,
    expires_at    TIMESTAMPTZ,
    labels        JSONB       NOT NULL DEFAULT '{}',
    revision      INTEGER     NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (consumer_id, name),
    CHECK ((type = 'key'   AND key_hash IS NOT NULL)
        OR (type = 'basic' AND username IS NOT NULL AND password_hash IS NOT NULL)
        OR (type = 'mtls'  AND identity IS NOT NULL))
);
CREATE UNIQUE INDEX apg_credentials_basic_username ON apg_credentials (workspace_id, username) WHERE type = 'basic';
CREATE UNIQUE INDEX apg_credentials_mtls_identity  ON apg_credentials (workspace_id, identity) WHERE type = 'mtls';

-- ── Plugins ──────────────────────────────────────────────────────────────────

CREATE TABLE apg_plugins (
    id               UUID        PRIMARY KEY,
    workspace_id     UUID        NOT NULL REFERENCES apg_workspaces(id) ON DELETE CASCADE,
    name             TEXT        NOT NULL,
    type             TEXT        NOT NULL,
    scope            TEXT        NOT NULL CHECK (scope IN ('global', 'workspace', 'service', 'route')),
    service_id       UUID        REFERENCES apg_services(id)   ON DELETE CASCADE,
    route_id         UUID        REFERENCES apg_routes(id)     ON DELETE CASCADE,
    consumer_id      UUID        REFERENCES apg_consumers(id)  ON DELETE CASCADE,
    target_workspace UUID        REFERENCES apg_workspaces(id) ON DELETE CASCADE,
    enabled          BOOLEAN     NOT NULL DEFAULT true,
    priority         INTEGER,
    config           JSONB       NOT NULL DEFAULT '{}',
    labels           JSONB       NOT NULL DEFAULT '{}',
    metadata         JSONB       NOT NULL DEFAULT '{}',
    revision         INTEGER     NOT NULL DEFAULT 1,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, name),
    CHECK ((scope = 'service') = (service_id IS NOT NULL)),
    CHECK ((scope = 'route')   = (route_id   IS NOT NULL))
);
-- One instance per type at each exact attachment point (spec PL-1).
CREATE UNIQUE INDEX apg_plugins_attachment ON apg_plugins (
    workspace_id, type, scope,
    COALESCE(service_id,       '00000000-0000-0000-0000-000000000000'),
    COALESCE(route_id,         '00000000-0000-0000-0000-000000000000'),
    COALESCE(consumer_id,      '00000000-0000-0000-0000-000000000000'),
    COALESCE(target_workspace, '00000000-0000-0000-0000-000000000000')
);

-- ── Flags and settings ───────────────────────────────────────────────────────

CREATE TABLE apg_flags (
    name       TEXT        PRIMARY KEY,
    enabled    BOOLEAN     NOT NULL,
    revision   INTEGER     NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE apg_settings (
    name       TEXT        PRIMARY KEY,
    value      JSONB       NOT NULL,
    revision   INTEGER     NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Distribution ─────────────────────────────────────────────────────────────

-- The changelog (spec §5.1). Append-only; rows older than the retention window
-- are deleted by a job. Written only inside the transaction that changes the
-- resource it describes (spec CFG-1).
CREATE TABLE apg_changes (
    seq        BIGSERIAL   PRIMARY KEY,
    data       JSONB       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE apg_changes REPLICA IDENTITY DEFAULT;
CREATE INDEX apg_changes_created_at ON apg_changes (created_at);

CREATE TABLE apg_nodes (
    node_id     TEXT        PRIMARY KEY,
    version     TEXT        NOT NULL DEFAULT '',
    source      TEXT        NOT NULL DEFAULT '',
    applied_seq BIGINT      NOT NULL DEFAULT 0,
    stale       BOOLEAN     NOT NULL DEFAULT false,
    region      TEXT,
    info        JSONB       NOT NULL DEFAULT '{}',
    started_at  TIMESTAMPTZ,
    first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE apg_cert_leases (
    hostname   TEXT        PRIMARY KEY,
    lease_id   UUID        NOT NULL,
    node_id    TEXT        NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE apg_acme_challenges (
    token             TEXT        PRIMARY KEY,
    key_authorization TEXT        NOT NULL,
    expires_at        TIMESTAMPTZ NOT NULL
);

CREATE TABLE apg_acme_accounts (
    directory_url          TEXT        PRIMARY KEY,
    credentials_ciphertext TEXT        NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Control ──────────────────────────────────────────────────────────────────

CREATE TABLE apg_admin_tokens (
    id           UUID        PRIMARY KEY,
    name         TEXT        NOT NULL UNIQUE,
    token_hash   TEXT        NOT NULL UNIQUE,   -- SHA-256
    token_prefix TEXT        NOT NULL,
    role         TEXT        NOT NULL CHECK (role IN ('admin', 'editor', 'viewer', 'node')),
    workspaces   TEXT[]      NOT NULL DEFAULT '{*}',
    expires_at   TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE apg_audit_log (
    id            BIGSERIAL   PRIMARY KEY,
    ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_kind    TEXT        NOT NULL,
    actor_id      TEXT        NOT NULL,
    actor_name    TEXT        NOT NULL,
    action        TEXT        NOT NULL,
    kind          TEXT        NOT NULL,
    resource_id   TEXT,
    resource_name TEXT,
    workspace_id  UUID,
    request_id    TEXT,
    source_ip     TEXT,
    outcome       TEXT        NOT NULL CHECK (outcome IN ('ok', 'refused')),
    before        JSONB,
    after         JSONB
);
CREATE INDEX apg_audit_log_ts        ON apg_audit_log (ts);
CREATE INDEX apg_audit_log_workspace ON apg_audit_log (workspace_id, ts);

CREATE TABLE apg_idempotency_keys (
    actor_id   TEXT        NOT NULL,
    key        TEXT        NOT NULL,
    method     TEXT        NOT NULL,
    path       TEXT        NOT NULL,
    status     INTEGER     NOT NULL,
    body       JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (actor_id, key)
);

-- Publication for db_tail nodes. Harmless when wal_level is not logical.
DO $$ BEGIN
    CREATE PUBLICATION apg_pub FOR TABLE apg_changes;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
