// The built CLI against a running admin and node (`make integ`). Everything
// it creates carries the label suite=cli and is removed at the end.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../../dist/apgctl.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "apgctl-integ-"));

function apgctl(args: string[], env: Record<string, string> = {}): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("node", [bin, ...args], { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out, err: "" };
  } catch (e) {
    const failure = e as { status: number; stdout: string; stderr: string };
    return { code: failure.status, out: failure.stdout, err: failure.stderr };
  }
}

const file = (name: string, text: string): string => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

const document = (priority: number, extra = "") => `
version: 1
services:
  - name: cli-echo
    labels: { suite: cli }
    backends:
      - target: "\${CLI_BACKEND}"
routes:
  - name: cli-route
    labels: { suite: cli }
    service: cli-echo
    hosts: [cli.example.test]
    paths: [/cli]
    priority: ${priority}
    plugins:
      - type: key_auth
        labels: { suite: cli }
consumers:
  - name: cli-app
    labels: { suite: cli }
    credentials:
      - name: main
        type: key
        key: "\${CLI_KEY:-cli-key-0123456789abcdef}"
        labels: { suite: cli }
${extra}`;

const env = { CLI_BACKEND: "echo:8080" };
const empty = () => file("empty.yaml", "version: 1\n");
const clean = () => apgctl(["sync", "-f", empty(), "--select-label", "suite=cli", "--yes"]);

beforeAll(() => {
  clean();
});
afterAll(() => {
  clean();
});

describe("apgctl against a running control plane", () => {
  it("validates offline and online; an unset variable stops it before anything is sent", () => {
    const path = file("apg.yaml", document(0));
    expect(apgctl(["validate", "-f", path], env)).toMatchObject({ code: 0, out: "valid\n" });
    expect(apgctl(["validate", "--online", "-f", path], env).out).toContain("checked against the workspace");
    const unset = apgctl(["apply", "-f", path]);
    expect(unset.code).toBe(1);
    expect(unset.err).toContain("environment variable CLI_BACKEND is not set");
  });

  it("apply creates, a second apply changes nothing, and diff's exit code says which", () => {
    const path = file("apg.yaml", document(0));
    expect(apgctl(["diff", "-f", path], env).code).toBe(2);
    const first = apgctl(["apply", "-f", path, "-m", "from the cli test"], env);
    expect(first.code).toBe(0);
    expect(first.out).toContain("+ service cli-echo");
    expect(first.out).toContain("+ plugin key_auth.route.cli-route");
    expect(first.out).toMatch(/recorded revision \d+ of default/);
    expect(apgctl(["diff", "-f", path], env)).toMatchObject({ code: 0 });
    expect(apgctl(["apply", "-f", path], env).out).toContain("0 to create, 0 to update, 0 to delete");
  });

  it("shows a change field by field, and the server's fault with its place in the document", () => {
    const changed = apgctl(["diff", "-f", file("apg.yaml", document(7))], env);
    expect(changed.code).toBe(2);
    expect(changed.out).toContain("~ route cli-route");
    expect(changed.out).toContain("/priority: 0 -> 7");
    const broken = apgctl(["apply", "-f", file("broken.yaml", "version: 1\nroutes:\n  - name: cli-broken\n    service: cli-missing\n")], env);
    expect(broken.code).toBe(1);
    expect(broken.err).toContain("VALIDATION_FAILED");
    expect(broken.err).toContain("/routes/0/service");
  });

  it("get, tokens and nodes read the live state", () => {
    expect(apgctl(["get", "routes"]).out).toMatch(/cli-route\s+cli\.example\.test\s+\/cli/);
    expect(JSON.parse(apgctl(["get", "service", "cli-echo", "-o", "json"]).out).backends[0].target).toBe("echo:8080");
    expect(apgctl(["get", "credentials", "--consumer", "cli-app"]).out).toMatch(/main\s+key\s+cli-key-/);
    expect(apgctl(["nodes"]).out).toMatch(/NODE\s+VERSION/);
    const made = apgctl(["tokens", "create", "--name", `cli-${Date.now()}`, "--role", "viewer", "-o", "json"]);
    const token = JSON.parse(made.out);
    expect(token.token).toMatch(/^apg_at_/);
    // the new token reads, and cannot write
    expect(apgctl(["get", "services", "--token", token.token]).code).toBe(0);
    expect(apgctl(["apply", "-f", file("apg.yaml", document(0)), "--token", token.token], env).err).toContain("FORBIDDEN");
    expect(apgctl(["delete", "token", token.name]).out).toBe(`deleted token ${token.name}\n`);
  });

  it("route match asks a real node which route a request would hit", async () => {
    let result = { code: 1, out: "", err: "" };
    for (let i = 0; i < 50 && result.code !== 0; i++) {
      result = apgctl(["route", "match", "--host", "cli.example.test", "--path", "/cli/items"]);
      if (result.code !== 0) await new Promise((r) => setTimeout(r, 200));
    }
    expect(result.out).toContain("GET cli.example.test/cli/items -> route cli-route (system tier, prefix /cli)");
    const miss = apgctl(["route", "match", "--host", "cli.example.test", "--path", "/elsewhere"]);
    expect(miss.code).toBe(1);
    expect(miss.out).toContain("no route matches");
    expect(miss.out).toMatch(/cli-route\s+system\s+prefix \/cli\s+the path does not match prefix \/cli/);
  });

  it("dump holds no secret and is what sync accepts unchanged", () => {
    const out = join(dir, "dump.yaml");
    expect(apgctl(["dump", "--file", out]).code).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("cli-route");
    expect(text).not.toContain("cli-key-0123456789abcdef");
    // Other suites share this workspace, so compare within the label.
    const scoped = apgctl(["diff", "-f", file("apg.yaml", document(0)), "--prune", "--select-label", "suite=cli"], env);
    expect(scoped).toMatchObject({ code: 0 });
  });

  it("sync refuses to delete unattended without --yes, then deletes what the document dropped", () => {
    const without = document(0).replace(/consumers:[\s\S]*$/, "");
    const path = file("apg.yaml", without);
    const refused = apgctl(["sync", "-f", path, "--select-label", "suite=cli"], env);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("- consumer cli-app");
    expect(refused.err).toContain("pass --yes");
    expect(apgctl(["get", "consumer", "cli-app"]).code).toBe(0);

    const done = apgctl(["sync", "-f", path, "--select-label", "suite=cli", "--yes", "-m", "drop the consumer"], env);
    expect(done.code).toBe(0);
    expect(done.out).toContain("- consumer cli-app");
    expect(apgctl(["get", "consumer", "cli-app"]).err).toContain("NOT_FOUND");
  });

  it("revisions are listed, and a rollback brings the consumer and its key back", () => {
    const list = JSON.parse(apgctl(["revisions", "list", "-o", "json"]).out);
    const first = list.data.find((r: { message: string | null }) => r.message === "from the cli test");
    expect(first).toBeDefined();
    expect(list.data[0].message).toBe("drop the consumer");
    expect(apgctl(["revisions", "show", first.id]).out).toContain("$secret: '***'");

    expect(apgctl(["revisions", "rollback", first.id]).err).toContain("pass --yes");
    const back = apgctl(["revisions", "rollback", first.id, "--yes"]);
    expect(back.code).toBe(0);
    expect(back.out).toContain("+ consumer cli-app");
    expect(apgctl(["get", "credentials", "--consumer", "cli-app"]).out).toMatch(/main\s+key\s+cli-key-/);
  });
});
