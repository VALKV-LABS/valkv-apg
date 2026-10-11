/**
 * Keys the schemas define that nodes do not enforce yet (`schemas/unbuilt.yaml`).
 *
 * The node's file loader reads the same list. Both refuse a document that sets
 * one of these to anything but its default, so nothing the control plane
 * accepts is silently ignored by the data plane.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import yaml from "js-yaml";
import { defaultSchemasDir } from "./schemas.js";

export interface UnbuiltKey {
  /** Dotted path inside the resource. */
  path: string;
  /** The schema default; a document may carry this value. */
  default?: unknown;
}

export interface Unbuilt {
  service: UnbuiltKey[];
  route: UnbuiltKey[];
  settings: UnbuiltKey[];
  /** Refused by the admin only. */
  service_database_mode: UnbuiltKey[];
}

export function loadUnbuilt(dir: string = defaultSchemasDir()): Unbuilt {
  const doc = (yaml.load(readFileSync(join(dir, "unbuilt.yaml"), "utf8")) ?? {}) as Partial<Unbuilt>;
  return {
    service: doc.service ?? [],
    route: doc.route ?? [],
    settings: doc.settings ?? [],
    service_database_mode: doc.service_database_mode ?? [],
  };
}

export const UNBUILT_MESSAGE = "is not enforced by this build yet, so it is refused rather than silently ignored";

/** The listed keys `doc` sets to something other than their default. */
export function unbuiltFaults(doc: Record<string, unknown>, keys: UnbuiltKey[]): Array<{ pointer: string; message: string }> {
  const faults: Array<{ pointer: string; message: string }> = [];
  for (const key of keys) {
    let value: unknown = doc;
    for (const part of key.path.split(".")) {
      value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
    }
    if (value === undefined) continue;
    if ("default" in key && isDeepStrictEqual(value, key.default)) continue;
    faults.push({ pointer: `/${key.path.replaceAll(".", "/")}`, message: `'${key.path}' ${UNBUILT_MESSAGE}` });
  }
  return faults;
}
