"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { ArchMark, Chip, Icon } from "./components";
import { fmtDate, initials, ROLE } from "./format";
import { useSession, type Persona } from "./session";

// Application frame: slim sidebar, top bar with page title, period selector (where relevant),
// Demo/Live indicator and the user menu.

const NAV = [
  { href: "/overview", label: "Overview", icon: "home" },
  { href: "/enquiries", label: "Enquiries", icon: "phone" },
  { href: "/consultations", label: "Consultations", icon: "calendar" },
  { href: "/activity", label: "Activity & Costs", icon: "chart" },
  { href: "/settings", label: "Settings", icon: "settings" },
] as const;

export type PeriodKey = "7d" | "30d" | "month" | "90d";
export const PERIODS: Array<{ value: PeriodKey; label: string }> = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "month", label: "This month" },
  { value: "90d", label: "Last 90 days" },
];

/** Period boundaries; "This month" starts at IST midnight on the 1st. */
export function periodRange(key: PeriodKey): { from: string; to: string } {
  const to = new Date();
  if (key === "month") {
    const ist = new Date(to.getTime() + 5.5 * 3600000);
    const start = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 5.5 * 3600000;
    return { from: new Date(start).toISOString(), to: to.toISOString() };
  }
  const days = key === "7d" ? 7 : key === "30d" ? 30 : 90;
  return { from: new Date(to.getTime() - days * 86400000).toISOString(), to: to.toISOString() };
}

export type DataScope = "all" | "live" | "simulated";
interface WorkspaceValue {
  period: PeriodKey;
  setPeriod(p: PeriodKey): void;
  scope: DataScope;
  setScope(s: DataScope): void;
}
const WorkspaceCtx = createContext<WorkspaceValue | null>(null);
export function useWorkspace(): WorkspaceValue {
  const v = useContext(WorkspaceCtx);
  if (!v) throw new Error("useWorkspace outside the workspace shell");
  return v;
}

const PERIOD_PAGES = ["/overview", "/activity"];

export const DEMO_PERSONAS: Array<{ id: Persona; label: string; name?: string }> = [
  { id: "admin", label: "Founder (administrator)" },
  { id: "front_desk", label: "Front desk" },
  { id: "designer", label: "Designer Asha", name: "Asha" },
  { id: "designer_b", label: "Designer Vikram", name: "Vikram" },
  { id: "designer_c", label: "Designer Neha", name: "Neha" },
];

export function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const { status, me, persona, notice, retry, switchPersona } = useSession();
  const router = useRouter();
  const pathname = usePathname() ?? "/overview";
  const [navOpen, setNavOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [period, setPeriod] = useState<PeriodKey>("30d");
  const [scope, setScope] = useState<DataScope>("all");
  const value = useMemo(() => ({ period, setPeriod, scope, setScope }), [period, scope]);

  useEffect(() => {
    setNavOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  if (status === "error") {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
        <div className="error-box" role="alert" style={{ maxWidth: 440 }}>
          <strong>The demo could not start</strong>
          <p>{notice ?? "Try again in a moment."}</p>
          <button type="button" className="btn sm" onClick={retry}>Try again</button>
        </div>
      </div>
    );
  }
  if (status !== "ready" || !me) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }} aria-busy="true">
        <div className="stack" style={{ alignItems: "center" }}>
          <ArchMark size={44} />
          <span className="muted small">Opening your workspace…</span>
        </div>
      </div>
    );
  }

  const current = NAV.find((n) => pathname.startsWith(n.href));
  const title = pathname.startsWith("/enquiries/") ? "Enquiry" : current?.label ?? "Workspace";
  const sandbox = me.sandbox;
  const switchTo = async (p: Persona) => {
    setMenuOpen(false);
    await switchPersona(p);
    router.refresh();
  };

  return (
    <WorkspaceCtx.Provider value={value}>
      <a href="#main" className="skip-link">Skip to content</a>
      <div className="shell">
        {navOpen ? <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden="true" /> : null}
        <aside className={`sidebar${navOpen ? " open" : ""}`} aria-label="Main navigation">
          <Link href="/overview" className="brand">
            <ArchMark size={46} />
            <span className="brand-name">Aangan Studio</span>
            <span className="brand-sub">Every enquiry, thoughtfully handled.</span>
          </Link>
          <nav className="nav">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="nav-link" aria-current={pathname.startsWith(n.href) ? "page" : undefined}>
                <Icon name={n.icon} />
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="sidebar-foot">
            <span className="avatar" aria-hidden="true">{initials(me.display_name)}</span>
            <div className="grow">
              <div className="small" style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{me.display_name}</div>
              <div className="tiny muted">{ROLE[me.role]}{sandbox ? " · demo sandbox" : ""}</div>
            </div>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <button type="button" className="btn ghost sm menu-btn" onClick={() => setNavOpen(true)} aria-label="Open navigation">
              <Icon name="menu" />
            </button>
            <div className="crumbs">
              Workspace <span aria-hidden="true">/</span> <strong>{title}</strong>
            </div>
            <div className="topbar-actions">
              {me.app_mode === "demo" ? (
                <Chip tone="warn" dot title={sandbox ? "Demo sandbox: simulated records only" : "Demo mode: sample business rules"}>
                  {sandbox ? "Demo sandbox" : "Demo mode"}
                </Chip>
              ) : (
                <Chip tone="ok" dot title="Live mode">Live</Chip>
              )}
              {PERIOD_PAGES.some((p) => pathname.startsWith(p)) ? (
                <label className="hide-mobile">
                  <span className="sr-only">Period</span>
                  <select className="select" value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)} style={{ minHeight: 36 }}>
                    {PERIODS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div style={{ position: "relative" }}>
                <button type="button" className="btn ghost sm" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
                  <span className="avatar" style={{ width: 30, height: 30, fontSize: 12 }} aria-hidden="true">{initials(me.display_name)}</span>
                  <span className="sr-only">Account menu for {me.display_name}</span>
                  <Icon name="chevron" size={16} />
                </button>
                {menuOpen ? (
                  <div role="menu" className="card" style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", width: 270, padding: 8, zIndex: 40 }}>
                    <div style={{ padding: "8px 10px" }}>
                      <div style={{ fontWeight: 500 }}>{me.display_name}</div>
                      <div className="tiny muted">{ROLE[me.role]} · demo sandbox</div>
                    </div>
                    {me.sandbox ? (
                      <>
                        <hr className="divider" style={{ margin: "6px 0" }} />
                        <div className="tiny muted" style={{ padding: "2px 10px" }}>View the demo as</div>
                        {DEMO_PERSONAS.map((p) => (
                          <button key={p.id} role="menuitem" type="button" className="btn ghost sm" style={{ width: "100%", justifyContent: "flex-start" }} disabled={p.id === persona} onClick={() => switchTo(p.id)}>
                            {p.label}
                            {p.id === persona ? " · current" : ""}
                          </button>
                        ))}
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </header>
          <main id="main" className="content" tabIndex={-1} key={me.id}>
            {children}
          </main>
        </div>
      </div>
    </WorkspaceCtx.Provider>
  );
}

export function PeriodNote({ from, to, extra }: { from: string; to: string; extra?: React.ReactNode }) {
  return (
    <span className="small muted">
      {fmtDate(from)} – {fmtDate(to)} · IST{extra ? <> · {extra}</> : null}
    </span>
  );
}

/** Period selector for small screens, where the top-bar control is hidden. */
export function MobilePeriod() {
  const { period, setPeriod } = useWorkspace();
  return (
    <label className="field" style={{ maxWidth: 220 }}>
      <span className="sr-only">Period</span>
      <select className="select" value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)}>
        {PERIODS.map((p) => (
          <option key={p.value} value={p.value}>{p.label}</option>
        ))}
      </select>
    </label>
  );
}
