"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { describeError } from "./api";
import type { Tone } from "./format";

// ---------- Icons (inline, stroke-based) ----------
const P: Record<string, React.ReactNode> = {
  home: <path d="M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" />,
  phone: <path d="M6.6 3.8h2.6l1.4 4-1.9 1.3a12 12 0 0 0 6.2 6.2l1.3-1.9 4 1.4v2.6a1.9 1.9 0 0 1-2 1.9A16.4 16.4 0 0 1 4.7 5.8a1.9 1.9 0 0 1 1.9-2z" />,
  calendar: <><rect x="4" y="5.5" width="16" height="14.5" rx="2" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>,
  chart: <path d="M5 20V10M10 20V4M15 20v-7M20 20v-4" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2 1.2M17.8 15.3l2 1.2M4.2 16.5l2-1.2M17.8 8.7l2-1.2" /><circle cx="12" cy="12" r="7" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  users: <><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" /><circle cx="16.8" cy="9.5" r="2.5" /><path d="M16.5 14.6c2.2.2 3.6 1.7 4 4.4" /></>,
  user: <><circle cx="12" cy="8.5" r="3.6" /><path d="M5 20c.8-3.7 3.7-5.7 7-5.7s6.2 2 7 5.7" /></>,
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4 7 8 6 8-6" /></>,
  alert: <><path d="M12 4 21 19.5H3z" /><path d="M12 10v4.2M12 17.2v.1" /></>,
  check: <path d="m5 12.5 4.3 4.3L19 7" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  back: <path d="M19 12H5M11 6l-6 6 6 6" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>,
  refresh: <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />,
  sparkle: <path d="M12 3.5 13.8 10 20.5 12l-6.7 2-1.8 6.5-1.8-6.5L3.5 12l6.7-2z" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  rupee: <path d="M7 5h10M7 9h10M7 5h3.5a4 4 0 0 1 0 8H7l7.5 6" />,
  shield: <path d="M12 3.5 19 6v5.5c0 4.4-3 7.7-7 9-4-1.3-7-4.6-7-9V6z" />,
  logout: <path d="M14 4.5h4a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-4M10 16l4-4-4-4M14 12H4" />,
  chevron: <path d="m7 10 5 5 5-5" />,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8v.1" /></>,
};

export function Icon({ name, size = 20, label }: { name: keyof typeof P | string; size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? "img" : undefined} aria-label={label}>
      {P[name] ?? null}
    </svg>
  );
}

/** Architectural arch motif used for the studio identity. */
export function ArchMark({ size = 56 }: { size?: number }) {
  return (
    <svg width={size} height={size * 1.15} viewBox="0 0 56 64" fill="none" stroke="var(--text)" strokeWidth={1.4} aria-hidden="true">
      <path d="M6 62V26a22 22 0 0 1 44 0v36z" />
      <path d="M12 62V27a16 16 0 0 1 32 0v35" />
      <path d="M28 54V30" strokeLinecap="round" />
      <path d="M28 46c-4-1-6.5-3.8-6.5-7.5 3.6.3 6 2.6 6.5 6M28 40c4-1 6.5-3.8 6.5-7.5-3.6.3-6 2.6-6.5 6M28 35c-3-1-4.6-3.2-4.6-6 2.8.3 4.3 2 4.6 4.6" strokeLinecap="round" />
      <path d="M2 62h52" />
    </svg>
  );
}

export function Chip({ tone = "neutral", children, dot = false, title }: { tone?: Tone; children: React.ReactNode; dot?: boolean; title?: string }) {
  return (
    <span className={`chip ${tone === "neutral" ? "" : tone}`} title={title}>
      {dot ? <span className="dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function StatusChip({ map, value }: { map: Record<string, { label: string; tone: Tone }>; value: string | null | undefined }) {
  const v = value ? map[value] : undefined;
  return <Chip tone={v?.tone ?? "neutral"} dot>{v?.label ?? (value ? value.replace(/_/g, " ") : "Unknown")}</Chip>;
}

export function SimulatedTag({ simulated, compact = false }: { simulated: boolean; compact?: boolean }) {
  return simulated ? (
    <Chip tone="terra" title="Created by a simulated call. Not a real customer.">
      {compact ? "Simulated" : "Simulated call"}
    </Chip>
  ) : (
    <Chip tone="outline" title="Real phone enquiry">
      Live
    </Chip>
  );
}

export function Skeleton({ h = 16, w = "100%", style }: { h?: number; w?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height: h, width: w, ...style }} aria-hidden="true" />;
}

export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card" aria-busy="true">
      <span className="sr-only">Loading</span>
      <Skeleton h={22} w="45%" />
      <div className="stack" style={{ marginTop: 16 }}>
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} h={14} w={`${90 - i * 12}%`} />
        ))}
      </div>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="serif">{title}</div>
      {children ? <div className="small" style={{ maxWidth: 460, margin: "0 auto" }}>{children}</div> : null}
      {action ? <div style={{ marginTop: 14 }}>{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = describeError(error);
  return (
    <div className="error-box" role="alert">
      <strong>{e.title}</strong>
      <p>{e.detail}</p>
      {onRetry ? (
        <button type="button" className="btn sm" onClick={onRetry}>
          <Icon name="refresh" size={16} /> Try again
        </button>
      ) : null}
    </div>
  );
}

/** Fetch-on-mount resource with reload. Never substitutes sample data on failure. */
export function useResource<T>(fetcher: (() => Promise<T>) | null, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: Boolean(fetcher) });
  const [tick, setTick] = useState(0);
  const ref = useRef(fetcher);
  ref.current = fetcher;
  useEffect(() => {
    if (!ref.current) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    ref.current().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (error) => alive && setState({ data: null, error, loading: false }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

// ---------- Dialog ----------
export function Dialog({ open, onClose, title, subtitle, children, footer, wide = false }: { open: boolean; onClose: () => void; title: string; subtitle?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`dialog${wide ? " wide" : ""}`} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }} aria-labelledby="dialog-title">
      {open ? (
        <>
          <div className="dialog-head">
            <div>
              <h2 id="dialog-title" className="card-title">{title}</h2>
              {subtitle ? <div className="small muted" style={{ marginTop: 4 }}>{subtitle}</div> : null}
            </div>
            <button type="button" className="btn ghost sm" onClick={onClose} aria-label="Close dialog">
              <Icon name="close" size={18} />
            </button>
          </div>
          <div className="dialog-body">{children}</div>
          {footer ? <div className="dialog-foot">{footer}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}

// ---------- Toasts ----------
type Toast = { id: number; text: string; tone: "ok" | "bad" };
const ToastCtx = createContext<(text: string, tone?: "ok" | "bad") => void>(() => undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: "ok" | "bad" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "bad" ? 9000 : 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === "bad" ? "bad" : ""}`}>
            <Icon name={t.tone === "bad" ? "alert" : "check"} size={18} />
            <span>{t.text}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
