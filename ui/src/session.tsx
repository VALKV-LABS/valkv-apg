/**
 * Who is signed in, which workspace is selected, and what the caller may do.
 *
 * Standalone, the console signs in with an admin token and then holds only an
 * HttpOnly cookie and a CSRF token (spec API-5). Embedded (`?embed=1`), the
 * host page hands over a delegated token by postMessage and it stays in
 * memory; nothing is read from the address bar (spec UI-7).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, type Json, api, listAll, setCredentials, setUnauthenticatedHandler } from "./api";
import { applyBrand } from "./theme";

export interface Actor {
  kind: string;
  id: string;
  name: string;
  role: "admin" | "editor" | "viewer" | "node";
  workspaces: "*" | string[];
  fleet_admin: boolean;
}

export interface Brand {
  brand_name: string;
  logo_url: string | null;
  primary_color: string | null;
  version: string;
  embed_origins: string[];
  /** True when the control plane offers sign-in through an identity provider. */
  single_sign_on: boolean;
}

export interface Session {
  status: "loading" | "signed-out" | "signed-in" | "waiting-for-host";
  actor: Actor | null;
  brand: Brand;
  embed: boolean;
  workspaces: Json[];
  /** Name of the selected workspace. */
  workspace: string;
  setWorkspace: (name: string) => void;
  reloadWorkspaces: () => Promise<void>;
  /** May the caller change resources? A viewer sees no mutating control (spec UI-5). */
  canWrite: boolean;
  /** May the caller use fleet-wide pages? */
  fleetAdmin: boolean;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const DEFAULT_BRAND: Brand = { brand_name: "valkv-apg", logo_url: null, primary_color: null, version: "", embed_origins: [], single_sign_on: false };
const Ctx = createContext<Session | null>(null);

export function useSession(): Session {
  const value = useContext(Ctx);
  if (!value) throw new Error("useSession needs a SessionProvider");
  return value;
}

const remembered = (): string | null => {
  try {
    return localStorage.getItem("apg-workspace");
  } catch {
    return null;
  }
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const embed = useMemo(() => new URLSearchParams(window.location.search).get("embed") === "1", []);
  const [status, setStatus] = useState<Session["status"]>("loading");
  const [actor, setActor] = useState<Actor | null>(null);
  const [brand, setBrand] = useState<Brand>(DEFAULT_BRAND);
  const [workspaces, setWorkspaces] = useState<Json[]>([]);
  const [workspace, setWorkspaceState] = useState("default");

  const reloadWorkspaces = useCallback(async () => {
    const list = await listAll("/v1/workspaces");
    list.sort((a, b) => Number(b["system"]) - Number(a["system"]) || String(a["name"]).localeCompare(b["name"]));
    setWorkspaces(list);
    setWorkspaceState((current) => {
      const wanted = remembered() ?? current;
      return list.some((w) => w["name"] === wanted) ? wanted : (list[0]?.["name"] ?? "default");
    });
  }, []);

  const enter = useCallback(async (who: Actor) => {
    setActor(who);
    await reloadWorkspaces();
    setStatus("signed-in");
  }, [reloadWorkspaces]);

  useEffect(() => {
    let cancelled = false;
    let hostOrigins: string[] = [];
    setUnauthenticatedHandler(() => {
      setCredentials({});
      setActor(null);
      setStatus(embed ? "waiting-for-host" : "signed-out");
      // The host's token ran out: ask it for a fresh one.
      if (embed) for (const origin of hostOrigins) window.parent?.postMessage({ type: "apg:ready" }, origin);
    });

    (async () => {
      let loaded = DEFAULT_BRAND;
      try {
        const res = await fetch("/ui/config.json");
        if (res.ok) loaded = { ...DEFAULT_BRAND, ...((await res.json()) as Partial<Brand>) };
      } catch {
        // the defaults will do
      }
      if (cancelled) return;
      setBrand(loaded);
      applyBrand(loaded);

      if (embed) {
        hostOrigins = loaded.embed_origins;
        setStatus("waiting-for-host");
        const onMessage = (event: MessageEvent) => {
          // Only a listed origin may hand over a token.
          if (!loaded.embed_origins.includes(event.origin)) return;
          const data = event.data as { type?: string; token?: string } | null;
          if (data?.type !== "apg:token" || typeof data.token !== "string") return;
          setCredentials({ bearer: data.token });
          api<{ actor: Actor }>("GET", "/v1/session").then((s) => enter(s.actor)).catch(() => setStatus("waiting-for-host"));
        };
        window.addEventListener("message", onMessage);
        for (const origin of loaded.embed_origins) window.parent?.postMessage({ type: "apg:ready" }, origin);
        return;
      }

      try {
        const s = await api<{ actor: Actor; csrf_token?: string }>("GET", "/v1/session");
        if (cancelled) return;
        setCredentials(s.csrf_token ? { csrf: s.csrf_token } : {});
        await enter(s.actor);
      } catch {
        if (!cancelled) setStatus("signed-out");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [embed, enter]);

  const value = useMemo<Session>(() => ({
    status, actor, brand, embed, workspaces, workspace,
    setWorkspace: (name) => {
      try {
        localStorage.setItem("apg-workspace", name);
      } catch {
        // not remembered, still selected
      }
      setWorkspaceState(name);
    },
    reloadWorkspaces,
    canWrite: actor?.role === "admin" || actor?.role === "editor",
    fleetAdmin: actor?.fleet_admin === true,
    signIn: async (token) => {
      // The token is used for exactly this one call; afterwards the browser holds only the cookie.
      const s = await api<{ actor: Actor; csrf_token: string }>("POST", "/v1/session", { bearer: token.trim() });
      if (s.actor.role === "node") throw new ApiError(403, "FORBIDDEN", "A node token cannot sign in to the console.");
      setCredentials({ csrf: s.csrf_token });
      await enter(s.actor);
    },
    signOut: async () => {
      try {
        await api("DELETE", "/v1/session");
      } catch {
        // signing out locally is what matters
      }
      setCredentials({});
      setActor(null);
      setStatus("signed-out");
    },
  }), [status, actor, brand, embed, workspaces, workspace, reloadWorkspaces, enter]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
