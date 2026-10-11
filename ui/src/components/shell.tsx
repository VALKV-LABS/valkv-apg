/** The frame around every page: sidebar, top bar, content (the portal's layout, spec UI-6a). */

import {
  Activity, Boxes, ChevronRight, FileCode2, Globe, KeyRound, LayoutDashboard, LogOut, Menu, Moon, Puzzle,
  ScrollText, Server, Settings, Signpost, Sun, Users, Waypoints,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useSession } from "../session";
import { useTheme } from "../theme";

interface Item {
  to: string;
  label: string;
  icon: ReactNode;
  /** Fleet-wide pages are for a fleet admin only (spec UI-5). */
  fleet?: boolean;
}

export const NAV: Array<{ label?: string; items: Item[] }> = [
  { items: [{ to: "/", label: "Overview", icon: <LayoutDashboard size={15} /> }] },
  {
    label: "Gateway",
    items: [
      { to: "/routes", label: "Routes", icon: <Signpost size={15} /> },
      { to: "/services", label: "Services", icon: <Server size={15} /> },
      { to: "/domains", label: "Domains & certificates", icon: <Globe size={15} /> },
      { to: "/plugins", label: "Plugins", icon: <Puzzle size={15} /> },
      { to: "/consumers", label: "Consumers", icon: <Users size={15} /> },
    ],
  },
  {
    label: "Operate",
    items: [
      { to: "/usage", label: "Usage", icon: <Activity size={15} /> },
      { to: "/config", label: "Config", icon: <FileCode2 size={15} /> },
      { to: "/audit", label: "Audit log", icon: <ScrollText size={15} /> },
    ],
  },
  {
    label: "Fleet",
    items: [
      { to: "/workspaces", label: "Workspaces", icon: <Boxes size={15} />, fleet: true },
      { to: "/nodes", label: "Nodes", icon: <Waypoints size={15} />, fleet: true },
      { to: "/settings", label: "Settings", icon: <Settings size={15} />, fleet: true },
    ],
  },
];

/** Pages that make sense inside another product's portal (spec UI-7). */
export const EMBEDDABLE = ["/routes", "/services", "/domains", "/plugins", "/consumers", "/usage"];

export function Shell({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();
  const [theme, toggleTheme] = useTheme();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [location.pathname]);

  if (session.embed) {
    return (
      <div className="shell embed">
        <main className="main" id="main">{children}</main>
      </div>
    );
  }

  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.fleet || session.fleetAdmin) })).filter((g) => g.items.length > 0);
  const current = NAV.flatMap((g) => g.items).find((i) => (i.to === "/" ? location.pathname === "/" : location.pathname.startsWith(i.to)));

  return (
    <div className="shell">
      <a href="#main" className="skip-link">Skip to content</a>
      {open && <button type="button" className="scrim" aria-label="Close menu" onClick={() => setOpen(false)} />}
      <aside className={`sidebar${open ? " open" : ""}`} id="sidebar">
        <div className="brand">
          {session.brand.logo_url ? <img src={session.brand.logo_url} alt="" /> : <div className="brand-mark" aria-hidden="true">{session.brand.brand_name.charAt(0).toUpperCase()}</div>}
          <span>{session.brand.brand_name}</span>
        </div>

        <div className="org-switch">
          <div className="org-avatar" aria-hidden="true" />
          <label className="sr-only" htmlFor="workspace-switch">Workspace</label>
          <select id="workspace-switch" value={session.workspace} onChange={(e) => session.setWorkspace(e.target.value)}>
            {session.workspaces.map((w) => <option key={w["id"]} value={w["name"]}>{w["name"]}{w["system"] ? " (system)" : ""}</option>)}
          </select>
        </div>

        <nav className="sidebar-nav" aria-label="Main">
          {groups.map((group, i) => (
            <div key={i}>
              {group.label && <div className="nav-label">{group.label}</div>}
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.to === "/"} className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
                  <span className="nav-icon" aria-hidden="true">{item.icon}</span>
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="user-avatar" aria-hidden="true"><KeyRound size={13} style={{ margin: 7.5, color: "var(--accent-ink)" }} /></div>
          <div className="user-lines">
            <span style={{ fontSize: 12, fontWeight: 500 }}>{session.actor?.name}</span>
            <span className="mono muted" style={{ fontSize: 10 }}>{session.actor?.role}{session.fleetAdmin ? "" : " · scoped"}</span>
          </div>
          <button type="button" className="icon-btn" style={{ marginLeft: "auto" }} aria-label="Sign out" title="Sign out" onClick={() => void session.signOut()}>
            <LogOut size={13} aria-hidden="true" />
          </button>
        </div>
      </aside>

      <header className="topbar">
        <button type="button" className="icon-btn menu-btn" aria-label="Open menu" aria-controls="sidebar" aria-expanded={open} onClick={() => setOpen(true)}>
          <Menu size={16} aria-hidden="true" />
        </button>
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <Link to="/" className="breadcrumb-link">{session.workspace}</Link>
          <ChevronRight size={11} className="breadcrumb-sep" aria-hidden="true" />
          <span className="breadcrumb-current" aria-current="page">{current?.label ?? "Not found"}</span>
        </nav>
        <button type="button" className="icon-btn" style={{ marginLeft: "auto" }} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} title={theme === "dark" ? "Light theme" : "Dark theme"} onClick={toggleTheme}>
          {theme === "dark" ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
        </button>
      </header>

      <main className="main" id="main" tabIndex={-1}>{children}</main>
    </div>
  );
}
