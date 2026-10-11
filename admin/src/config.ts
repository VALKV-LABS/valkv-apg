/**
 * Process configuration of the admin (spec Appendix B).
 *
 * Read once at start. A missing required variable, or one that is set but
 * empty, fails startup with a message naming it. `schemas/process-config.yaml`
 * lists every variable; a test keeps this module and that file in step.
 */

import { readFileSync } from "node:fs";
import type { BlockList } from "node:net";
import { fileURLToPath } from "node:url";
import { parseSecretKey } from "./crypto.js";
import { parseCidrList } from "./egress.js";

/** Variables this module reads. Checked against schemas/process-config.yaml by a test. */
export const READ_VARIABLES = [
  "APG_DATABASE_URL", "APG_ADMIN_LISTEN", "APG_DP_LISTEN", "APG_ADMIN_TLS_CERT", "APG_ADMIN_TLS_KEY",
  "APG_SECRET_KEY", "APG_SECRET_KEY_FILE", "APG_SECRET_KEY_PREVIOUS",
  "APG_BOOTSTRAP_ADMIN_TOKEN", "APG_BOOTSTRAP_NODE_TOKEN", "APG_MIGRATE_ON_BOOT",
  "APG_ADMIN_JWT_JWKS_URL", "APG_ADMIN_JWT_PUBLIC_KEY", "APG_ADMIN_JWT_ISSUER", "APG_ADMIN_JWT_AUDIENCE",
  "APG_ADMIN_JWT_WORKSPACE_CLAIM", "APG_ADMIN_JWT_ROLE_CLAIM",
  "APG_DOMAIN_VERIFICATION", "APG_CHANGELOG_RETENTION_HOURS", "APG_NODE_SLOT_TTL_HOURS", "APG_AUDIT_RETENTION_DAYS",
  "APG_EGRESS_ALLOW_CIDRS", "APG_BACKEND_ALLOW_CIDRS", "APG_LOG_LEVEL", "APG_LOG_FORMAT",
  "APG_USAGE_ROLLUP_INTERVAL_SECS", "APG_USAGE_RAW_RETENTION_DAYS", "APG_USAGE_HOURLY_RETENTION_DAYS", "APG_USAGE_WEBHOOK_URL",
  "APG_UI_ENABLED", "APG_UI_DIR", "APG_UI_BRAND_NAME", "APG_UI_LOGO_URL", "APG_UI_PRIMARY_COLOR", "APG_UI_EMBED_ORIGINS",
  "APG_DEBUG_NODE_URL", "APG_OIDC_ISSUER",
] as const;

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
const LOG_FORMATS = ["json", "text"] as const;

/** A listen address. */
export interface Address {
  host: string;
  port: number;
}

/** Delegated JWT authentication (spec API-4). */
export interface JwtConfig {
  jwksUrl: string | null;
  publicKeyPem: string | null;
  issuer: string | null;
  audience: string | null;
  workspaceClaim: string;
  roleClaim: string | null;
}

/** The admin UI (spec §15). */
export interface UiConfig {
  enabled: boolean;
  /** Directory holding the built UI. */
  dir: string;
  brandName: string;
  logoUrl: string | null;
  /** `#rrggbb`, or null for the built-in colour. */
  primaryColor: string | null;
  /** Origins allowed to frame the UI (spec UI-7). Empty: nobody may. */
  embedOrigins: string[];
}

/** Parsed admin configuration. */
export interface Config {
  ui: UiConfig;
  /** Management address of a node that answers the route tester (spec RT-6), or null. */
  debugNodeUrl: string | null;
  databaseUrl: string;
  listen: Address;
  /** Separate listener for `/dp/*`; null serves it on `listen`. */
  dpListen: Address | null;
  tls: { cert: string; key: string } | null;
  secretKey: Buffer;
  secretKeyPrevious: Buffer | null;
  bootstrapAdminToken: string | null;
  bootstrapNodeToken: string | null;
  migrateOnBoot: boolean;
  jwt: JwtConfig | null;
  domainVerification: "none" | "dns_txt";
  changelogRetentionHours: number;
  nodeSlotTtlHours: number;
  auditRetentionDays: number;
  usageRollupSecs: number;
  usageRawRetentionDays: number;
  usageHourlyRetentionDays: number;
  egressAllow: BlockList;
  backendAllow: BlockList;
  logLevel: (typeof LOG_LEVELS)[number];
  logFormat: (typeof LOG_FORMATS)[number];
}

/** Thrown when the environment does not describe a valid configuration. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

/** Builds a {@link Config} from an environment. Throws {@link ConfigError}. */
export function loadConfig(env: Env = process.env): Config {
  const wrap = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      throw new ConfigError((err as Error).message);
    }
  };

  const tlsCert = get(env, "APG_ADMIN_TLS_CERT");
  const tlsKey = get(env, "APG_ADMIN_TLS_KEY");
  if ((tlsCert === null) !== (tlsKey === null)) {
    throw new ConfigError("APG_ADMIN_TLS_CERT and APG_ADMIN_TLS_KEY must be set together");
  }

  const dp = get(env, "APG_DP_LISTEN");
  const previous = get(env, "APG_SECRET_KEY_PREVIOUS");

  if (get(env, "APG_USAGE_WEBHOOK_URL") !== null) {
    throw new ConfigError("APG_USAGE_WEBHOOK_URL is not available in this build yet; read usage through GET /v1/usage");
  }
  if (get(env, "APG_OIDC_ISSUER") !== null) {
    throw new ConfigError("APG_OIDC_ISSUER: single sign-on is not available in this build yet; sign in to the UI with an admin token");
  }
  const primaryColor = get(env, "APG_UI_PRIMARY_COLOR");
  if (primaryColor !== null && !/^#[0-9a-fA-F]{6}$/.test(primaryColor)) {
    throw new ConfigError(`APG_UI_PRIMARY_COLOR must look like #2563eb; got '${primaryColor}'`);
  }
  const logoUrl = get(env, "APG_UI_LOGO_URL");
  if (logoUrl !== null && !/^(https:\/\/|\/)/.test(logoUrl)) {
    throw new ConfigError("APG_UI_LOGO_URL must be an https URL or a path on this server");
  }
  const debugNodeUrl = get(env, "APG_DEBUG_NODE_URL");
  if (debugNodeUrl !== null && !/^https?:\/\/[^/]+\/?$/.test(debugNodeUrl)) {
    throw new ConfigError(`APG_DEBUG_NODE_URL must be a node's management address such as http://node:9100; got '${debugNodeUrl}'`);
  }
  return {
    ui: {
      enabled: bool("APG_UI_ENABLED", get(env, "APG_UI_ENABLED") ?? "true"),
      dir: get(env, "APG_UI_DIR") ?? fileURLToPath(new URL("../ui/", import.meta.url)),
      brandName: get(env, "APG_UI_BRAND_NAME") ?? "valkv-apg",
      logoUrl,
      primaryColor,
      embedOrigins: (get(env, "APG_UI_EMBED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((origin) => {
        let parsed: URL;
        try {
          parsed = new URL(origin);
        } catch {
          throw new ConfigError(`APG_UI_EMBED_ORIGINS: '${origin}' is not an origin such as https://portal.example.com`);
        }
        if (parsed.origin !== origin.replace(/\/$/, "")) throw new ConfigError(`APG_UI_EMBED_ORIGINS: '${origin}' must be an origin only, without a path`);
        return parsed.origin;
      }),
    },
    debugNodeUrl: debugNodeUrl?.replace(/\/$/, "") ?? null,
    databaseUrl: required(env, "APG_DATABASE_URL"),
    listen: parseAddress("APG_ADMIN_LISTEN", get(env, "APG_ADMIN_LISTEN") ?? "0.0.0.0:9000"),
    dpListen: dp === null ? null : parseAddress("APG_DP_LISTEN", dp),
    tls: tlsCert && tlsKey ? { cert: tlsCert, key: tlsKey } : null,
    secretKey: wrap(() => parseSecretKey(secretKeySource(env))),
    secretKeyPrevious: previous === null ? null : wrap(() => parseSecretKey(previous, "APG_SECRET_KEY_PREVIOUS")),
    bootstrapAdminToken: get(env, "APG_BOOTSTRAP_ADMIN_TOKEN"),
    bootstrapNodeToken: get(env, "APG_BOOTSTRAP_NODE_TOKEN"),
    migrateOnBoot: bool("APG_MIGRATE_ON_BOOT", get(env, "APG_MIGRATE_ON_BOOT") ?? "true"),
    jwt: jwtConfig(env),
    domainVerification: oneOf("APG_DOMAIN_VERIFICATION", get(env, "APG_DOMAIN_VERIFICATION") ?? "none", ["none", "dns_txt"] as const),
    changelogRetentionHours: positiveInt("APG_CHANGELOG_RETENTION_HOURS", get(env, "APG_CHANGELOG_RETENTION_HOURS") ?? "168"),
    nodeSlotTtlHours: positiveInt("APG_NODE_SLOT_TTL_HOURS", get(env, "APG_NODE_SLOT_TTL_HOURS") ?? "24"),
    auditRetentionDays: positiveInt("APG_AUDIT_RETENTION_DAYS", get(env, "APG_AUDIT_RETENTION_DAYS") ?? "400"),
    usageRollupSecs: positiveInt("APG_USAGE_ROLLUP_INTERVAL_SECS", get(env, "APG_USAGE_ROLLUP_INTERVAL_SECS") ?? "60"),
    usageRawRetentionDays: positiveInt("APG_USAGE_RAW_RETENTION_DAYS", get(env, "APG_USAGE_RAW_RETENTION_DAYS") ?? "7"),
    usageHourlyRetentionDays: positiveInt("APG_USAGE_HOURLY_RETENTION_DAYS", get(env, "APG_USAGE_HOURLY_RETENTION_DAYS") ?? "400"),
    egressAllow: wrap(() => parseCidrList(get(env, "APG_EGRESS_ALLOW_CIDRS") ?? "", "APG_EGRESS_ALLOW_CIDRS")),
    backendAllow: wrap(() => parseCidrList(get(env, "APG_BACKEND_ALLOW_CIDRS") ?? "", "APG_BACKEND_ALLOW_CIDRS")),
    logLevel: oneOf("APG_LOG_LEVEL", get(env, "APG_LOG_LEVEL") ?? "info", LOG_LEVELS),
    logFormat: oneOf("APG_LOG_FORMAT", get(env, "APG_LOG_FORMAT") ?? "json", LOG_FORMATS),
  };
}

function secretKeySource(env: Env): string {
  const inline = get(env, "APG_SECRET_KEY");
  const file = get(env, "APG_SECRET_KEY_FILE");
  if (inline !== null && file !== null) throw new ConfigError("set only one of APG_SECRET_KEY and APG_SECRET_KEY_FILE");
  if (inline !== null) return inline;
  if (file !== null) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      throw new ConfigError(`APG_SECRET_KEY_FILE: cannot read '${file}'`);
    }
  }
  throw new ConfigError("required environment variable APG_SECRET_KEY (or APG_SECRET_KEY_FILE) is not set");
}

function jwtConfig(env: Env): JwtConfig | null {
  const jwksUrl = get(env, "APG_ADMIN_JWT_JWKS_URL");
  const publicKeyPem = get(env, "APG_ADMIN_JWT_PUBLIC_KEY")?.replace(/\\n/g, "\n") ?? null;
  if (jwksUrl === null && publicKeyPem === null) return null;
  if (jwksUrl !== null && publicKeyPem !== null) {
    throw new ConfigError("set only one of APG_ADMIN_JWT_JWKS_URL and APG_ADMIN_JWT_PUBLIC_KEY");
  }
  const workspaceClaim = get(env, "APG_ADMIN_JWT_WORKSPACE_CLAIM");
  if (workspaceClaim === null) {
    // Without it a token would have no scope, and "no scope" must never mean "everything".
    throw new ConfigError("APG_ADMIN_JWT_WORKSPACE_CLAIM is required when delegated JWT authentication is enabled");
  }
  return {
    jwksUrl,
    publicKeyPem,
    issuer: get(env, "APG_ADMIN_JWT_ISSUER"),
    audience: get(env, "APG_ADMIN_JWT_AUDIENCE"),
    workspaceClaim,
    roleClaim: get(env, "APG_ADMIN_JWT_ROLE_CLAIM"),
  };
}

// A variable that is set but empty is treated as absent: container tooling
// passes "" for an unset interpolation, and "" is never a usable value here.
function get(env: Env, key: string): string | null {
  const v = env[key]?.trim();
  return v ? v : null;
}

function required(env: Env, key: string): string {
  const v = get(env, key);
  if (v === null) throw new ConfigError(`required environment variable ${key} is not set`);
  return v;
}

function oneOf<T extends string>(key: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new ConfigError(`${key} must be one of ${allowed.join(", ")}; got '${value}'`);
}

function bool(key: string, value: string): boolean {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new ConfigError(`${key} must be true or false; got '${value}'`);
}

function positiveInt(key: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new ConfigError(`${key} must be a positive integer; got '${value}'`);
  return n;
}

function parseAddress(key: string, value: string): Address {
  const i = value.lastIndexOf(":");
  const host = i > 0 ? value.slice(0, i) : "";
  const port = Number(i >= 0 ? value.slice(i + 1) : NaN);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`${key} must be host:port; got '${value}'`);
  }
  return { host, port };
}
