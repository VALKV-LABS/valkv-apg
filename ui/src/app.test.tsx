import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { setCredentials } from "./api";
import { App } from "./app";
import { ADMIN, VIEWER, serve } from "./test-server";

function open(path = "/") {
  setCredentials({});
  window.history.pushState({}, "", `/ui${path}`);
  return render(<App />);
}

const SERVICE = {
  id: "s1", workspace_id: "ws-default", name: "orders", scheme: "http", http_version: "1.1", shared: false,
  backends: [{ id: "b1", target: "10.0.0.1:8080", weight: 1, status: "active" }], load_balancing: { strategy: "round_robin" },
  labels: {}, metadata: {}, revision: 3, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};

describe("signing in", () => {
  it("asks for a token, exchanges it for a session, and shows the console", async () => {
    let signedIn = false;
    const server = serve({
      "GET /v1/session": () => signedIn ? { body: { actor: ADMIN, csrf_token: "csrf-1" } } : { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "missing or invalid credentials" } } },
      "POST /v1/session": (call) => {
        if (call.headers["authorization"] !== "Bearer apg_at_good") return { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "missing or invalid credentials" } } };
        signedIn = true;
        return { status: 201, body: { actor: ADMIN, csrf_token: "csrf-1" } };
      },
    }, { brand: { brand_name: "Acme Gateway" } });
    const user = userEvent.setup();
    open();

    expect(await screen.findByRole("heading", { name: "Acme Gateway" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Admin token"), "apg_at_wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("missing or invalid credentials");

    await user.clear(screen.getByLabelText("Admin token"));
    await user.type(screen.getByLabelText("Admin token"), "apg_at_good");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(document.title).toBe("Acme Gateway");
    // The token went to the server once and is nowhere in the browser's storage.
    expect(server.find("POST", "/v1/session")).toHaveLength(2);
    expect(JSON.stringify({ ...localStorage })).not.toContain("apg_at_good");
  });

  it("offers single sign-on when the control plane has it, next to the token", async () => {
    serve({}, { actor: null, brand: { single_sign_on: true } });
    open();
    const link = await screen.findByRole("link", { name: "Sign in with single sign-on" });
    expect(link).toHaveAttribute("href", "/v1/session/oidc/login");
    expect(screen.getByRole("button", { name: "Sign in with a token" })).toBeDisabled();
  });

  it("shows who is signed in through single sign-on, with their role", async () => {
    serve({}, { actor: { kind: "oidc", id: "u1", name: "ada@example.com", role: "editor", workspaces: ["ws-acme"], fleet_admin: false } });
    open();
    expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByText(/editor · scoped/)).toBeInTheDocument();
  });

  it("signs out, and returns to sign-in when the session ends on its own", async () => {
    let alive = true;
    const server = serve({
      "DELETE /v1/session": () => { alive = false; return { status: 204 }; },
      "GET /v1/workspaces/default/services": () => alive ? { body: { data: [], next_cursor: null } } : { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "missing or invalid credentials" } } },
    });
    const user = userEvent.setup();
    open("/services");
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByLabelText("Admin token")).toBeInTheDocument();
    expect(server.find("DELETE", "/v1/session")[0]!.headers["x-apg-csrf"]).toBe("csrf-1");
  });
});

describe("what a role sees", () => {
  it("a fleet admin sees every page and the controls that change things", async () => {
    serve({ "GET /v1/workspaces/default/services": { body: { data: [SERVICE], next_cursor: null } } });
    open("/services");
    expect(await screen.findByText("orders")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New service/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit orders" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Main" });
    for (const page of ["Workspaces", "Nodes", "Settings", "Routes", "Audit log"]) expect(within(nav).getByRole("link", { name: page })).toBeInTheDocument();
  });

  it("a viewer scoped to one workspace sees no control that changes anything, and no fleet page", async () => {
    const server = serve({ "GET /v1/workspaces/acme/services": { body: { data: [{ ...SERVICE, workspace_id: "ws-acme" }], next_cursor: null } } }, { actor: VIEWER });
    open("/services");
    expect(await screen.findByText("orders")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New service/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit|Delete/ })).not.toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Main" });
    for (const page of ["Workspaces", "Nodes", "Settings"]) expect(within(nav).queryByRole("link", { name: page })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Workspace")).getAllByRole("option").map((o) => o.textContent)).toEqual(["acme"]);
    // It asked only for its own workspace.
    expect(server.calls.some((c) => c.path.includes("/workspaces/default/"))).toBe(false);
  });

  it("opening a fleet page by its address explains instead of failing", async () => {
    const server = serve({}, { actor: VIEWER });
    open("/settings");
    expect(await screen.findByText("This page is for fleet administrators")).toBeInTheDocument();
    expect(server.find("GET", "/v1/tokens")).toEqual([]);
  });
});

describe("loading, empty and error states", () => {
  it("shows the server's message and tries again on request", async () => {
    let fail = true;
    serve({
      "GET /v1/workspaces/default/routes": () => fail
        ? { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "internal error", request_id: "r-1" } } }
        : { body: { data: [], next_cursor: null } },
    });
    const user = userEvent.setup();
    open("/routes");
    expect(await screen.findByText("internal error", {}, { timeout: 8000 })).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No routes yet")).toBeInTheDocument();
  }, 15_000);
});

describe("forms from the server's schemas", () => {
  it("creates a service, and puts the server's faults on the fields they belong to", async () => {
    let attempt = 0;
    const server = serve({
      "POST /v1/workspaces/default/services": () => ++attempt === 1
        ? { status: 422, body: { error: { code: "EGRESS_NOT_ALLOWED", message: "the backend address is private", details: [{ pointer: "/backends/0/target", message: "10.0.0.5 is a private address" }] } } }
        : { status: 201, body: { ...SERVICE, name: "billing" } },
    });
    const user = userEvent.setup();
    open("/services");
    await user.click(await screen.findByRole("button", { name: /New service/ }));
    const dialog = await screen.findByRole("dialog", { name: "New service" });
    await user.type(await within(dialog).findByLabelText(/^Name/), "billing");
    await user.type(within(dialog).getByLabelText(/^Target/), "10.0.0.5:8080");
    await user.selectOptions(within(dialog).getByLabelText(/^Scheme/), "https");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(dialog).findByText("10.0.0.5 is a private address")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Target/)).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("the backend address is private");

    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const sent = server.find("POST", "/v1/workspaces/default/services");
    // A service made here checks its backends unless the operator takes the check out.
    expect(sent[1]!.body).toEqual({ name: "billing", scheme: "https", backends: [{ target: "10.0.0.5:8080" }], health_check: { active: { type: "tcp" } } });
    expect(sent[1]!.headers["x-apg-csrf"]).toBe("csrf-1");
  });

  it("edits with the revision it loaded, so a concurrent change is not overwritten", async () => {
    const server = serve({
      "GET /v1/workspaces/default/services": { body: { data: [SERVICE], next_cursor: null } },
      "PUT /v1/workspaces/default/services/s1": { status: 412, body: { error: { code: "REVISION_CONFLICT", message: "the resource is at revision 4, not 3" } } },
    });
    const user = userEvent.setup();
    open("/services");
    await user.click(await screen.findByRole("button", { name: "Edit orders" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit orders" });
    await user.click(await within(dialog).findByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("revision 4, not 3");
    expect(server.find("PUT", "/v1/workspaces/default/services/s1")[0]!.headers["if-match"]).toBe('"3"');
  });

  it("shows a generated API key once, in the response that created it", async () => {
    const consumer = { id: "c1", name: "mobile-app", groups: [], labels: {}, metadata: {}, revision: 1, created_at: "2026-01-01T00:00:00Z" };
    let created = false;
    serve({
      "GET /v1/workspaces/default/consumers": { body: { data: [consumer], next_cursor: null } },
      "GET /v1/workspaces/default/consumers/c1/credentials": () => ({ body: { data: created ? [{ id: "k1", name: "key-1", type: "key", key_prefix: "apg_k_ab", enabled: true }] : [], next_cursor: null } }),
      "POST /v1/workspaces/default/consumers/c1/credentials": () => { created = true; return { status: 201, body: { id: "k1", name: "key-1", type: "key", key_prefix: "apg_k_ab", enabled: true, key: "apg_k_abcdefgh-generated" } }; },
    });
    const user = userEvent.setup();
    open("/consumers");
    await user.click(await screen.findByRole("button", { name: "Credentials of mobile-app" }));
    await user.click(await screen.findByRole("button", { name: /Add credential/ }));
    const editor = await screen.findByRole("dialog", { name: "New credential for mobile-app" });
    // The form follows the type: a key has no user name, basic authentication does.
    expect(await within(editor).findByLabelText(/^Key/)).toBeInTheDocument();
    expect(within(editor).queryByLabelText(/^Username/)).not.toBeInTheDocument();
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    expect(await screen.findByTestId("secret-once")).toHaveTextContent("apg_k_abcdefgh-generated");
    // The list shows only what identifies the key.
    expect(await screen.findByText("apg_k_ab…")).toBeInTheDocument();
  });
});

describe("themes", () => {
  it("follows the system until switched, and remembers the switch", async () => {
    serve({});
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: "Switch to light theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem("apg-theme")).toBe("light");
    await user.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("apg-theme")).toBe("dark");
  });

  it("uses the operator's accent colour with readable text on it", async () => {
    serve({}, { brand: { primary_color: "#0f766e" } });
    open();
    await screen.findByRole("navigation", { name: "Main" });
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#0f766e");
    expect(document.documentElement.style.getPropertyValue("--accent-ink")).toBe("#ffffff");
  });
});

describe("embedded in another product", () => {
  it("waits for the host, takes a token only from a listed origin, and hides the global navigation", async () => {
    const server = serve({
      "GET /v1/session": (call) => call.headers["authorization"] === "Bearer delegated.jwt.token"
        ? { body: { actor: { ...VIEWER, kind: "jwt", role: "editor" } } }
        : { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "missing or invalid credentials" } } },
    }, { actor: VIEWER, brand: { embed_origins: ["https://portal.example.com"] } });
    open("/routes?embed=1");
    expect(await screen.findByText("Waiting for the host page")).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { origin: "https://evil.example.com", data: { type: "apg:token", token: "delegated.jwt.token" } }));
    });
    expect(screen.getByText("Waiting for the host page")).toBeInTheDocument();
    expect(server.calls.some((c) => c.headers["authorization"])).toBe(false);

    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { origin: "https://portal.example.com", data: { type: "apg:token", token: "delegated.jwt.token" } }));
    });
    expect(await screen.findByRole("heading", { name: "Routes", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
    // Every later call carries the token as a bearer; nothing was stored.
    await waitFor(() => expect(server.find("GET", "/v1/workspaces/acme/routes")[0]?.headers["authorization"]).toBe("Bearer delegated.jwt.token"));
    expect(JSON.stringify({ ...localStorage })).not.toContain("delegated");
  });
});

describe("config", () => {
  it("shows what a document would change before applying it, and asks before deleting", async () => {
    const changes = [
      { op: "update", workspace: "default", kind: "route", name: "orders-api", fields: [{ pointer: "/priority", before: 0, after: 5 }] },
      { op: "delete", workspace: "default", kind: "service", name: "old", fields: [] },
    ];
    const result = { changes, summary: { create: 0, update: 1, delete: 1, unchanged: 2 }, generated: [], revisions: [{ id: "r", workspace: "default", number: 4 }] };
    const server = serve({ "POST /v1/config/diff": { body: { ...result, revisions: [] } }, "POST /v1/config/sync": { body: result } });
    const user = userEvent.setup();
    open("/config");
    await user.click(await screen.findByRole("tab", { name: "Apply a document" }));
    fireEvent.change(screen.getByLabelText("Document"), { target: { value: "version: 1\nroutes: []\n" } });
    await user.selectOptions(screen.getByLabelText(/leaves out/), "sync");
    await user.click(screen.getByRole("button", { name: "Show changes" }));

    const list = await screen.findByRole("list", { name: "Changes" });
    expect(within(list).getByText(/route orders-api/)).toBeInTheDocument();
    expect(within(list).getByText("/priority: 0 → 5")).toBeInTheDocument();
    expect(server.find("POST", "/v1/config/diff")[0]!.query.get("prune")).toBe("true");
    expect(server.find("POST", "/v1/config/sync")).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Sync 2 changes" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete 1 resource?" });
    await user.click(within(confirm).getByRole("button", { name: "Sync" }));
    expect(await screen.findByText(/Recorded revision 4 of default/)).toBeInTheDocument();
    expect(server.find("POST", "/v1/config/sync")[0]!.body.document).toEqual({ version: 1, routes: [] });
  });

  it("refuses text that is not YAML without calling the server", async () => {
    const server = serve({});
    const user = userEvent.setup();
    open("/config");
    await user.click(await screen.findByRole("tab", { name: "Apply a document" }));
    fireEvent.change(screen.getByLabelText("Document"), { target: { value: "routes: [" } });
    await user.click(screen.getByRole("button", { name: "Show changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not valid YAML");
    expect(server.find("POST", "/v1/config/diff")).toEqual([]);
  });
});

describe("backend health", () => {
  const failing = { target: "10.0.0.1:8080", status: "active", state: "unhealthy", reason: "connection refused", nodes: [{ node_id: "n1", state: "unhealthy", reason: "connection refused", in_rotation: false }, { node_id: "n2", state: "unknown", in_rotation: true }] };
  const report = (over: object) => ({ service_id: "s1", name: "orders", health_check: false, healthy: 0, unhealthy: 0, unknown: 0, nodes_reporting: 2, backends: [], ...over });

  it("the overview names each failing backend, why, and on how many nodes", async () => {
    serve({ "GET /v1/workspaces/default/health": { body: { live_nodes: 2, data: [report({ state: "unhealthy", unhealthy: 1, backends: [failing] })] } } });
    open("/");
    expect(await screen.findByText("connection refused")).toBeInTheDocument();
    const row = screen.getByText("connection refused").closest("tr")!;
    expect(within(row).getByText("orders")).toBeInTheDocument();
    expect(within(row).getByText("10.0.0.1:8080")).toBeInTheDocument();
    expect(within(row).getByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByText("Backends failing").parentElement).toHaveTextContent("1");
  });

  it("the overview says so when nothing is failing, and when no node reports", async () => {
    serve({ "GET /v1/workspaces/default/health": { body: { live_nodes: 1, data: [report({ state: "unknown", healthy: 2, unknown: 1 })] } } });
    const first = open("/");
    expect(await screen.findByText("No backend is failing")).toBeInTheDocument();
    expect(screen.getByText("2 answering, 1 not checked yet.")).toBeInTheDocument();
    first.unmount();
    serve({ "GET /v1/workspaces/default/health": { body: { live_nodes: 0, data: [] } } });
    open("/");
    expect(await screen.findByText("No node is reporting")).toBeInTheDocument();
  });

  it("a backend nobody has checked is not called healthy, and the breakdown shows what each node saw", async () => {
    let health: object = { live_nodes: 2, data: [report({ state: "unknown", unknown: 1, backends: [{ target: "10.0.0.1:8080", status: "active", state: "unknown", nodes: [] }] })] };
    serve({
      "GET /v1/workspaces/default/services": { body: { data: [SERVICE], next_cursor: null } },
      "GET /v1/workspaces/default/health": () => ({ body: health }),
    });
    const user = userEvent.setup();
    const page = open("/services");
    expect(await screen.findByText("not checked")).toBeInTheDocument();
    expect(screen.queryByText("healthy")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Health of orders" }));
    let dialog = await screen.findByRole("dialog", { name: "Health of orders" });
    expect(within(dialog).getByText("No node has reported on it")).toBeInTheDocument();
    expect(within(dialog).getByText(/has no health check/)).toBeInTheDocument();
    page.unmount();

    health = { live_nodes: 2, data: [report({ state: "unhealthy", unhealthy: 1, health_check: true, backends: [failing] })] };
    open("/services");
    expect(await screen.findByText("1 of 1 failing")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Health of orders" }));
    dialog = await screen.findByRole("dialog", { name: "Health of orders" });
    expect(within(dialog).getByText(/failing, connection refused/)).toHaveTextContent("n1: failing, connection refused; not sending it traffic");
    expect(within(dialog).getByText(/nothing sent yet/)).toHaveTextContent("n2: nothing sent yet");
    expect(within(dialog).queryByText(/has no health check/)).not.toBeInTheDocument();
  });
});

describe("the fleet, and one node of it", () => {
  const node = (id: string, over: object = {}) => ({ node_id: id, version: "0.1.0", source: "api_poll", applied_seq: 9, stale: false, region: null, live: true, lag: 0, started_at: "2026-01-01T00:00:00Z", last_seen: new Date().toISOString(), info: { counts: { routes: 2, services: 1, workspaces: 1 }, backends: [] }, ...over });
  const seen = (state: string, extra: object = {}) => [{ service_id: "s1", workspace_id: "ws-default", name: "orders", healthy: state === "healthy" ? 1 : 0, unhealthy: state === "unhealthy" ? 1 : 0, unknown: 0, backends: [{ target: "10.0.0.1:8080", status: "active", state, in_rotation: state === "healthy", ...extra }] }];

  it("sums the fleet up, and opens a node to show what that node holds and sees", async () => {
    serve({ "GET /v1/nodes": { body: { last_seq: 12, data: [
      node("n1", { info: { counts: { routes: 2, services: 1, workspaces: 1 }, backends: seen("healthy") } }),
      node("n2", { lag: 3, applied_seq: 9, info: { counts: { routes: 2, services: 1, workspaces: 1 }, backends: seen("unhealthy", { reason: "connection refused" }) } }),
      node("n3", { live: false }),
    ] } } });
    const user = userEvent.setup();
    open("/nodes");
    expect(await screen.findByText("n2")).toBeInTheDocument();
    const stat = (label: string) => screen.getByText(label, { selector: ".stat-label" }).parentElement!;
    expect(stat("Live")).toHaveTextContent("2");
    expect(stat("Live")).toHaveTextContent("of 3 known");
    expect(stat("Not reporting")).toHaveTextContent("1");
    expect(stat("Behind")).toHaveTextContent("1");
    expect(stat("With failing backends")).toHaveTextContent("1");
    expect(stat("Serving stale config")).toHaveTextContent("None");
    expect(within(screen.getByText("n2").closest("tr")!).getByText("1 failing")).toBeInTheDocument();
    expect(within(screen.getByText("n1").closest("tr")!).getByText("none failing")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Details of node n2" }));
    const dialog = await screen.findByRole("dialog", { name: "Node n2" });
    expect(within(dialog).getByText("2 routes, 1 services, 1 workspaces")).toBeInTheDocument();
    const row = within(dialog).getByText("10.0.0.1:8080").closest("tr")!;
    expect(row).toHaveTextContent("default");
    expect(row).toHaveTextContent("orders");
    expect(row).toHaveTextContent("failing");
    expect(row).toHaveTextContent("connection refused; not sending it traffic");
  });

  it("says so when every node is fine", async () => {
    serve({ "GET /v1/nodes": { body: { last_seq: 9, data: [node("n1")] } } });
    open("/nodes");
    expect(await screen.findByText("All up to date and reaching every backend")).toBeInTheDocument();
  });
});
