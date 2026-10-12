-- Usage metering (spec §11).
--
-- Identifiers are stored as text without foreign keys on purpose: usage must
-- outlive the workspace, route or consumer it was counted for.

-- One row per node, window and dimension set, exactly as nodes report it.
-- A retried report overwrites its own row, so nothing is counted twice (USG-4).
CREATE TABLE apg_usage_raw (
    node_id                 TEXT        NOT NULL,
    window_start            TIMESTAMPTZ NOT NULL,
    interval_secs           INTEGER     NOT NULL,
    workspace_id            TEXT        NOT NULL,
    service_id              TEXT        NOT NULL,
    route_id                TEXT        NOT NULL,
    consumer_id             TEXT        NOT NULL DEFAULT '',
    region                  TEXT        NOT NULL DEFAULT '',
    requests                BIGINT      NOT NULL DEFAULT 0,
    bytes_in                BIGINT      NOT NULL DEFAULT 0,
    bytes_out               BIGINT      NOT NULL DEFAULT 0,
    status_2xx              BIGINT      NOT NULL DEFAULT 0,
    status_3xx              BIGINT      NOT NULL DEFAULT 0,
    status_4xx              BIGINT      NOT NULL DEFAULT 0,
    status_5xx              BIGINT      NOT NULL DEFAULT 0,
    latency_ms_sum          BIGINT      NOT NULL DEFAULT 0,
    upstream_latency_ms_sum BIGINT      NOT NULL DEFAULT 0,
    received_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (node_id, window_start, workspace_id, route_id, service_id, consumer_id)
);
CREATE INDEX apg_usage_raw_window ON apg_usage_raw (window_start, workspace_id);
CREATE INDEX apg_usage_raw_received ON apg_usage_raw (received_at);

-- Rollups, rebuilt by overwrite from the raw rows (USG-6).
CREATE TABLE apg_usage_hourly (
    bucket                  TIMESTAMPTZ NOT NULL,
    workspace_id            TEXT        NOT NULL,
    service_id              TEXT        NOT NULL,
    route_id                TEXT        NOT NULL,
    consumer_id             TEXT        NOT NULL DEFAULT '',
    region                  TEXT        NOT NULL DEFAULT '',
    requests                BIGINT      NOT NULL DEFAULT 0,
    bytes_in                BIGINT      NOT NULL DEFAULT 0,
    bytes_out               BIGINT      NOT NULL DEFAULT 0,
    status_2xx              BIGINT      NOT NULL DEFAULT 0,
    status_3xx              BIGINT      NOT NULL DEFAULT 0,
    status_4xx              BIGINT      NOT NULL DEFAULT 0,
    status_5xx              BIGINT      NOT NULL DEFAULT 0,
    latency_ms_sum          BIGINT      NOT NULL DEFAULT 0,
    upstream_latency_ms_sum BIGINT      NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, workspace_id, route_id, service_id, consumer_id, region)
);
CREATE INDEX apg_usage_hourly_workspace ON apg_usage_hourly (workspace_id, bucket);

CREATE TABLE apg_usage_daily (LIKE apg_usage_hourly INCLUDING ALL);
