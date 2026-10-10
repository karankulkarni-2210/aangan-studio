"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ApiFailure, describeError, request, type DemoSession, type Me, type RequestOptions } from "./api";

// No login screen: visitors are placed straight into the demo sandbox (simulated records only) as
// the founder, and can switch demo roles from the user menu. Real records stay behind backend auth.

export type Persona = "admin" | "front_desk" | "front_desk_b" | "designer" | "designer_b" | "designer_c";
type Stored = { token: string; expiresAt: string; persona: Persona };

const KEY = "aangan.demo-session.v2";

function load(): Stored | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    const s = raw ? (JSON.parse(raw) as Stored) : null;
    return s && new Date(s.expiresAt).getTime() - Date.now() > 60_000 ? s : null;
  } catch {
    return null;
  }
}
function save(s: Stored | null) {
  try {
    if (s) window.localStorage.setItem(KEY, JSON.stringify(s));
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable (private mode): the session lasts for this page only.
  }
}

type Status = "loading" | "error" | "ready";
interface SessionValue {
  status: Status;
  me: Me | null;
  persona: Persona | null;
  notice: string | null;
  switchPersona(persona: Persona): Promise<void>;
  retry(): void;
  api<T>(path: string, opts?: RequestOptions): Promise<{ status: number; data: T }>;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [stored, setStored] = useState<Stored | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const storedRef = useRef<Stored | null>(null);
  storedRef.current = stored;

  const start = useCallback(async (persona: Persona, existing?: Stored | null) => {
    setStatus("loading");
    try {
      let s = existing ?? null;
      if (!s) {
        const { data } = await request<DemoSession>("/api/v1/demo/session", { method: "POST", body: { persona } });
        s = { token: data.access_token, expiresAt: data.expires_at, persona };
      }
      const { data: who } = await request<Me>("/api/v1/me", { token: s.token });
      save(s);
      setStored(s);
      setMe(who);
      setNotice(null);
      setStatus("ready");
    } catch (err) {
      if (existing) return start(persona, null); // stale token: start a fresh sandbox session
      save(null);
      setNotice(describeError(err).detail);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    const s = load();
    void start(s?.persona ?? "admin", s);
  }, [start]);

  const api = useCallback(
    async <T,>(path: string, opts: RequestOptions = {}) => {
      const s = storedRef.current;
      if (!s) throw new ApiFailure(401, "no_session", "The demo is still starting. Try again in a moment.");
      try {
        return await request<T>(path, { ...opts, token: s.token });
      } catch (err) {
        if (err instanceof ApiFailure && err.status === 401) void start(s.persona, null);
        throw err;
      }
    },
    [start],
  );

  const value = useMemo<SessionValue>(
    () => ({
      status,
      me,
      persona: stored?.persona ?? null,
      notice,
      switchPersona: (p: Persona) => start(p, null),
      retry: () => void start(stored?.persona ?? "admin", null),
      api,
    }),
    [status, me, stored, notice, start, api],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession must be used inside SessionProvider");
  return v;
}
