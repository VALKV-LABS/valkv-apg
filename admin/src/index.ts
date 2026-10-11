/**
 * Entry point of the admin service.
 *
 *   valkv-apg-admin                       run the service
 *   valkv-apg-admin migrate up            apply pending migrations
 *   valkv-apg-admin migrate down [n]      revert the last n migrations (default 1)
 *   valkv-apg-admin migrate status        list migrations
 *   valkv-apg-admin openapi               print the OpenAPI document
 */

import Fastify from "fastify";
import { Authenticator, bootstrapTokens } from "./auth.js";
import { ConfigError, loadConfig } from "./config.js";
import { SecretBox } from "./crypto.js";
import { connect, migrateDown, migrateStatus, migrateUp } from "./db.js";
import { JobRunner, buildJobs } from "./jobs.js";
import { buildOpenApi } from "./openapi.js";
import { ENDPOINTS, registerApi } from "./routes/api.js";
import { registerConfig } from "./routes/config.js";
import { ChangeNotifier } from "./routes/dp.js";
import { SchemaRegistry } from "./schemas.js";
import { buildServer } from "./server.js";
import { Store } from "./store.js";

const VERSION = "0.1.0";

async function main(argv: string[]): Promise<void> {
  const [command, sub, arg] = argv;

  if (command === "openapi") {
    // Needs no database: register the routes on a throwaway server to collect their descriptions.
    const schemas = new SchemaRegistry();
    registerApi(Fastify(), { deps: { sql: undefined } } as never, schemas);
    registerConfig(Fastify(), { deps: { sql: undefined } } as never, undefined as never, { debugNodeUrl: null, secureCookies: false });
    process.stdout.write(JSON.stringify(buildOpenApi(ENDPOINTS, schemas, VERSION), null, 2) + "\n");
    return;
  }

  const config = loadConfig();
  const sql = connect(config.databaseUrl);

  if (command === "migrate") {
    try {
      if (sub === "up") console.log(`applied: ${JSON.stringify(await migrateUp(sql))}`);
      else if (sub === "down") console.log(`reverted: ${JSON.stringify(await migrateDown(sql, arg ? Number(arg) : 1))}`);
      else if (sub === "status") console.table(await migrateStatus(sql));
      else throw new ConfigError("usage: migrate up | down [n] | status");
    } finally {
      await sql.end({ timeout: 5 });
    }
    return;
  }
  if (command !== undefined) throw new ConfigError(`unknown command '${command}'`);

  // Fail at start, not on first request, if the shipped schemas are broken.
  const schemas = new SchemaRegistry();
  if (config.migrateOnBoot) await migrateUp(sql);

  const store = new Store({
    sql,
    schemas,
    box: new SecretBox(config.secretKey, config.secretKeyPrevious ?? undefined),
    domainVerification: config.domainVerification,
    egressAllow: config.egressAllow,
    backendAllow: config.backendAllow,
  });
  const auth = new Authenticator(sql, config.jwt);
  const notifier = new ChangeNotifier();
  await notifier.start(sql);

  const pingDatabase = async () => {
    await sql`SELECT 1`;
  };
  const base = { pingDatabase, store, schemas, auth, notifier, version: VERSION, ui: config.ui, debugNodeUrl: config.debugNodeUrl };
  const app = buildServer(config, { ...base, serve: { api: true, dp: config.dpListen === null } });
  const jobs = new JobRunner(sql, buildJobs(store, config), app.log);
  // The data-plane API can have its own listener, so the network that reaches
  // nodes need not reach the Admin API (spec API-8).
  const dpApp = config.dpListen ? buildServer(config, { ...base, serve: { api: false, dp: true } }) : null;

  const generated = await bootstrapTokens(sql, { adminToken: config.bootstrapAdminToken, nodeToken: config.bootstrapNodeToken });
  // Shown once, here, and never again: only the hash is stored.
  if (generated.generatedAdmin) app.log.warn(`generated bootstrap admin token (store it now): ${generated.generatedAdmin}`);
  if (generated.generatedNode) app.log.warn(`generated bootstrap node token (store it now): ${generated.generatedNode}`);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "shutting down");
    jobs.stop();
    await notifier.close();
    await app.close();
    await dpApp?.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.listen.host, port: config.listen.port });
  if (dpApp && config.dpListen) await dpApp.listen({ host: config.dpListen.host, port: config.dpListen.port });
  jobs.start();
}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`configuration error: ${err.message}`);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
