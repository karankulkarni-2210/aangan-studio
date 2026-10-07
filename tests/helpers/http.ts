import { mintDemoToken } from "@/lib/auth/demo-token";
import { DEMO_STAFF, type DemoStaffKey } from "@/lib/seed/demo";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

export async function tokenFor(key: DemoStaffKey): Promise<string> {
  return mintDemoToken(DEMO_STAFF.find((s) => s.key === key)!.auth);
}

export async function call(
  handler: unknown,
  method: string,
  path: string,
  opts: { body?: unknown; raw?: string; as?: DemoStaffKey; token?: string; headers?: Record<string, string>; params?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
  if (opts.as) headers.authorization = `Bearer ${await tokenFor(opts.as)}`;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const raw = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  const res = await (handler as Handler)(new Request(`http://localhost:3000${path}`, { method, headers, body: raw }), { params: Promise.resolve(opts.params ?? {}) });
  const text = await res.text();
  let body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}
