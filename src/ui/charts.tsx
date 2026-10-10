"use client";

import { useState } from "react";
import { fmtInt, fmtPct } from "./format";

const dayLabel = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

/** Daily enquiries vs responses within target. Data are IST calendar days from the backend. */
export function ActivityChart({ days }: { days: Array<{ date: string; calls: number; responded_within_target: number }> }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 240;
  const pad = { l: 34, r: 12, t: 12, b: 28 };
  const max = Math.max(4, ...days.map((d) => d.calls));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const x = (i: number) => pad.l + (days.length <= 1 ? 0 : (i * (W - pad.l - pad.r)) / (days.length - 1));
  const y = (v: number) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
  const path = (key: "calls" | "responded_within_target") => days.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(" ");
  const every = Math.max(1, Math.ceil(days.length / 8));
  const h = hover !== null ? days[hover] : null;

  return (
    <div>
      <div style={{ position: "relative" }}>
        <svg
          className="chart"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Daily enquiries and responses within five minutes, ${days.length} days`}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const px = ((e.clientX - r.left) / r.width) * W;
            const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (days.length - 1));
            setHover(Math.max(0, Math.min(days.length - 1, i)));
          }}
        >
          {[0, 1, 2, 3, 4].map((k) => (
            <g key={k}>
              <line x1={pad.l} x2={W - pad.r} y1={y(k * step)} y2={y(k * step)} stroke="#ece9e2" />
              <text x={pad.l - 8} y={y(k * step) + 4} textAnchor="end">{k * step}</text>
            </g>
          ))}
          {days.map((d, i) =>
            i % every === 0 || i === days.length - 1 ? (
              <text key={d.date} x={x(i)} y={H - 8} textAnchor="middle">{dayLabel.format(new Date(`${d.date}T00:00:00Z`))}</text>
            ) : null,
          )}
          <path d={path("calls")} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
          <path d={path("responded_within_target")} fill="none" stroke="var(--terra)" strokeWidth={2} strokeLinejoin="round" strokeDasharray="5 4" />
          {days.length <= 31
            ? days.map((d, i) => (
                <g key={d.date}>
                  <circle cx={x(i)} cy={y(d.calls)} r={hover === i ? 4.5 : 3} fill="var(--accent)" />
                  <rect x={x(i) - 3} y={y(d.responded_within_target) - 3} width={6} height={6} fill="var(--terra)" />
                </g>
              ))
            : null}
          {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="#cfcac0" strokeDasharray="3 3" /> : null}
        </svg>
        {h ? (
          <div className="card small" style={{ position: "absolute", top: 4, left: `${Math.min(70, (x(hover!) / W) * 100)}%`, padding: "8px 10px", pointerEvents: "none" }}>
            <strong>{dayLabel.format(new Date(`${h.date}T00:00:00Z`))}</strong>
            <div>{fmtInt(h.calls)} enquiries</div>
            <div>{fmtInt(h.responded_within_target)} answered within 5 min</div>
          </div>
        ) : null}
      </div>
      <table className="sr-only">
        <caption>Daily enquiries</caption>
        <thead><tr><th>Day</th><th>Enquiries</th><th>Within 5 minutes</th></tr></thead>
        <tbody>{days.map((d) => <tr key={d.date}><td>{d.date}</td><td>{d.calls}</td><td>{d.responded_within_target}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

export function Funnel({ steps }: { steps: Array<{ label: string; value: number; note?: string }> }) {
  const first = steps[0]?.value ?? 0;
  return (
    <div className="funnel">
      {steps.map((s, i) => {
        const prev = i === 0 ? null : steps[i - 1].value;
        const share = first > 0 ? s.value / first : 0;
        return (
          <div className="funnel-row" key={s.label}>
            <div>
              <div>{s.label}</div>
              {s.note ? <div className="tiny muted">{s.note}</div> : null}
            </div>
            <div className="bar-track" aria-hidden="true">
              <div className={`bar-fill${i % 2 ? " terra" : ""}`} style={{ width: `${Math.max(s.value > 0 ? 2 : 0, share * 100)}%` }} />
            </div>
            <div className="num" style={{ textAlign: "right" }}>
              <strong>{fmtInt(s.value)}</strong>
              {prev !== null ? <div className="tiny muted">{prev > 0 ? fmtPct(s.value / prev) : "–"}</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Bars({ rows, format = fmtInt }: { rows: Array<{ label: string; value: number | null; tone?: "accent" | "terra" }>; format?: (n: number | null) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value ?? 0));
  return (
    <div className="funnel">
      {rows.map((r) => (
        <div className="funnel-row" key={r.label}>
          <div>{r.label}</div>
          <div className="bar-track" aria-hidden="true">
            <div className={`bar-fill${r.tone === "terra" ? " terra" : ""}`} style={{ width: `${((r.value ?? 0) / max) * 100}%` }} />
          </div>
          <div className="num" style={{ textAlign: "right" }}>{format(r.value)}</div>
        </div>
      ))}
    </div>
  );
}
