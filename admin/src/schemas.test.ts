import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import yaml from "js-yaml";
import { beforeAll, describe, expect, it } from "vitest";
import { SchemaRegistry } from "./schemas.js";

const fixtures = fileURLToPath(new URL("../../tests/fixtures/", import.meta.url));
const schemasDir = fileURLToPath(new URL("../../schemas/", import.meta.url));

let registry: SchemaRegistry;
beforeAll(() => {
  registry = new SchemaRegistry(schemasDir);
});

describe("schema registry", () => {
  it("compiles every schema, including cross-file references", () => {
    expect(registry.list()).toEqual(
      expect.arrayContaining([
        "apg-config.json",
        "changelog-event.json",
        "common.json",
        "resources/route.json",
        "resources/service.json",
        "plugins/rate_limit.json",
      ]),
    );
  });

  it("refuses an unknown schema path", () => {
    expect(() => registry.validator("resources/nope.json")).toThrow(/unknown schema/);
  });
});

describe("apg.yaml fixtures", () => {
  const validDir = join(fixtures, "config/valid");
  for (const file of readdirSync(validDir)) {
    it(`accepts ${file}`, () => {
      const doc = yaml.load(readFileSync(join(validDir, file), "utf8"));
      expect(registry.validate("apg-config.json", doc)).toEqual([]);
    });
  }

  const cases = yaml.load(readFileSync(join(fixtures, "config/invalid/cases.yaml"), "utf8")) as Array<{
    name: string;
    pointer: string;
    doc: unknown;
  }>;
  for (const c of cases) {
    it(`rejects: ${c.name}`, () => {
      const faults = registry.validate("apg-config.json", c.doc);
      expect(faults.length).toBeGreaterThan(0);
      // The fault must be reported at, or beneath, the expected location.
      expect(faults.map((f) => f.pointer).some((p) => p === c.pointer || p.startsWith(c.pointer === "/" ? "/" : c.pointer + "/"))).toBe(true);
    });
  }
});

describe("changelog event fixtures", () => {
  const cases = yaml.load(readFileSync(join(fixtures, "events/cases.yaml"), "utf8")) as Array<{
    name: string;
    valid: boolean;
    event: unknown;
  }>;
  for (const c of cases) {
    it(`${c.valid ? "accepts" : "rejects"}: ${c.name}`, () => {
      const faults = registry.validate("changelog-event.json", c.event);
      expect(faults.length === 0).toBe(c.valid);
    });
  }
});

describe("plugin config schemas", () => {
  it("fills nothing in silently: an unknown key is a fault (PL-2)", () => {
    const faults = registry.validate("plugins/rate_limit.json", { per_sec: 5 });
    expect(faults).toHaveLength(1);
    expect(faults[0]?.message).toContain("per_sec");
  });

  it("accepts the documented keys", () => {
    expect(registry.validate("plugins/rate_limit.json", { per_second: 0.5, burst: 10, scope: "header:x-team", store: "redis" })).toEqual([]);
    expect(registry.validate("plugins/bandwidth_limit.json", { bytes_per_second: 1000, burst_bytes: 2000, scope: "ip" })).toEqual([]);
  });

  it("rejects an out-of-range value", () => {
    expect(registry.validate("plugins/rate_limit.json", { per_second: 0 })).not.toEqual([]);
    expect(registry.validate("plugins/rate_limit.json", { scope: "tenant" })).not.toEqual([]);
  });
});
