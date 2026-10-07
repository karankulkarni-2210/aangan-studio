// Structured JSON logs with redaction. Personal data (phone numbers, emails, transcript text) and
// credentials never reach logs; only identifiers and counts do.

const SENSITIVE_KEY = /(authorization|token|secret|password|api[_-]?key|cookie|signature|phone|email|text|quote|transcript|body|name)/i;
const EMAIL = /[^\s@"']+@[^\s@"']+\.[^\s@"']+/g;
const PHONE = /\+?\d[\d\s-]{7,}\d/g;
const BEARER = /bearer\s+[a-z0-9._~+/=-]+/gi;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") {
    return value.replace(BEARER, "Bearer [redacted]").replace(EMAIL, "[email]").replace(PHONE, "[phone]");
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) && typeof v !== "number" && typeof v !== "boolean" ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (process.env.LOG_LEVEL === "silent") return;
  if (level === "debug" && process.env.LOG_LEVEL !== "debug") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(fields) as object) });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
