/** Routes of the console, and who may see which (spec UI-5, UI-7). */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes as RouterRoutes, useLocation } from "react-router-dom";
import { ApiError } from "./api";
import { EMBEDDABLE, Shell } from "./components/shell";
import { Empty, Loading } from "./components/ui";
import { Audit } from "./pages/audit";
import { Config } from "./pages/config";
import { Domains } from "./pages/domains";
import { Nodes, SettingsPage, Workspaces } from "./pages/fleet";
import { Consumers, Routes, Services } from "./pages/gateway";
import { Login, WaitingForHost } from "./pages/login";
import { Overview } from "./pages/overview";
import { Plugins } from "./pages/plugins";
import { Usage } from "./pages/usage";
import { SessionProvider, useSession } from "./session";

function NotFound() {
  return <Empty title="There is no such page" action={<Link to="/" className="btn btn-ghost">Go to the overview</Link>} />;
}

/** A page only a fleet admin may open. Others are told so rather than shown a broken page. */
function Fleet({ children }: { children: ReactNode }) {
  const { fleetAdmin } = useSession();
  if (!fleetAdmin) return <Empty title="This page is for fleet administrators">Your token is limited to its own workspaces.</Empty>;
  return <>{children}</>;
}

function Pages() {
  const session = useSession();
  const location = useLocation();
  if (session.status === "loading") return <Loading />;
  if (session.status === "waiting-for-host") return <WaitingForHost />;
  if (session.status === "signed-out") return <Login />;
  if (session.workspaces.length === 0) return <Empty title="No workspace is open to you">Ask an administrator for a token scoped to a workspace.</Empty>;

  // Inside a frame only workspace pages exist; the rest of the console stays out of reach.
  if (session.embed && !EMBEDDABLE.some((p) => location.pathname.startsWith(p))) return <Navigate to={`/routes${location.search}`} replace />;

  return (
    <Shell>
      {/* Remount on a workspace switch so no page keeps another workspace's form state. */}
      <RouterRoutes key={session.workspace}>
        <Route path="/" element={<Overview />} />
        <Route path="/routes" element={<Routes />} />
        <Route path="/services" element={<Services />} />
        <Route path="/domains" element={<Domains />} />
        <Route path="/plugins" element={<Plugins />} />
        <Route path="/consumers" element={<Consumers />} />
        <Route path="/usage" element={<Usage />} />
        <Route path="/config" element={<Config />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="/workspaces" element={<Fleet><Workspaces /></Fleet>} />
        <Route path="/nodes" element={<Fleet><Nodes /></Fleet>} />
        <Route path="/settings" element={<Fleet><SettingsPage /></Fleet>} />
        <Route path="*" element={<NotFound />} />
      </RouterRoutes>
    </Shell>
  );
}

export function App({ basename = "/ui" }: { basename?: string }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: false,
        // A refusal will be refused again; only a lost connection or a server fault is worth another try.
        retry: (count, error) => count < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      },
    },
  }));
  return (
    <QueryClientProvider client={client}>
      <SessionProvider>
        <BrowserRouter basename={basename} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Pages />
        </BrowserRouter>
      </SessionProvider>
    </QueryClientProvider>
  );
}
