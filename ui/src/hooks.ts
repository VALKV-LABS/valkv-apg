/** Data hooks shared by pages. */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { type Json, type Query, api, listAll, ws } from "./api";
import { Schemas } from "./components/schema-form";
import { useSession } from "./session";

/** Every schema the server publishes, loaded once. */
export function useSchemas() {
  return useQuery({
    queryKey: ["schemas"],
    staleTime: Infinity,
    queryFn: async () => {
      const [resources, plugins] = await Promise.all([
        api<{ data: Array<{ path: string; schema: Json }> }>("GET", "/v1/schemas/resources"),
        api<{ data: Json[] }>("GET", "/v1/schemas/plugins"),
      ]);
      const entries = [...resources.data, ...plugins.data.filter((p) => p["schema"]).map((p) => ({ path: `plugins/${p["name"]}.json`, schema: p["schema"] as Json }))];
      return { schemas: new Schemas(entries), pluginTypes: plugins.data };
    },
  });
}

/** All items of a collection in the selected workspace. */
export function useCollection(segment: string, enabled = true) {
  const { workspace } = useSession();
  return useQuery({ queryKey: ["ws", workspace, segment], queryFn: () => listAll(ws(workspace, segment)), enabled });
}

/** A map from id to name for a collection, for showing references readably. */
export function useNames(segment: string): Map<string, string> {
  const { data } = useCollection(segment);
  return useMemo(() => new Map((data ?? []).map((r) => [r["id"] as string, r["name"] as string])), [data]);
}

export function useUsage(query: Query, enabled = true) {
  return useQuery({
    queryKey: ["usage", query],
    queryFn: () => api<{ data: Json[]; group_by: string[]; truncated: boolean; granularity: string }>("GET", "/v1/usage", { query }),
    enabled,
    refetchInterval: 60_000,
  });
}
