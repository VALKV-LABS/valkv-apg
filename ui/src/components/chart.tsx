/** A bar chart over time, drawn as SVG. Small on purpose: the numbers are also in a table wherever it matters. */

import type { Json } from "../api";
import { formatNumber } from "../api";

export interface Point {
  label: string;
  value: number;
  /** The part of `value` drawn in the error colour. */
  errors?: number;
}

/** Sums usage rows that share a bucket. */
export function byBucket(rows: Json[]): Point[] {
  const map = new Map<string, Point>();
  for (const r of rows) {
    const key = String(r["bucket"]);
    const p = map.get(key) ?? { label: key, value: 0, errors: 0 };
    p.value += Number(r["requests"] ?? 0);
    p.errors = (p.errors ?? 0) + Number(r["status_5xx"] ?? 0);
    map.set(key, p);
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function BarChart({ points, label }: { points: Point[]; label: string }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const total = points.reduce((n, p) => n + p.value, 0);
  const width = 600;
  const height = 120;
  const slot = width / Math.max(points.length, 1);
  const bar = Math.max(1, Math.min(slot - 2, 28));
  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${label}: ${formatNumber(total)} in total over ${points.length} interval${points.length === 1 ? "" : "s"}, peak ${formatNumber(max)}`}>
      <line className="axis" x1="0" y1={height - 0.5} x2={width} y2={height - 0.5} />
      {points.map((p, i) => {
        const h = (p.value / max) * (height - 6);
        const e = ((p.errors ?? 0) / max) * (height - 6);
        const x = i * slot + (slot - bar) / 2;
        return (
          <g key={p.label}>
            <title>{`${new Date(p.label).toLocaleString()}: ${formatNumber(p.value)}${p.errors ? `, ${formatNumber(p.errors)} server errors` : ""}`}</title>
            <rect className="bar" x={x} y={height - 1 - h} width={bar} height={Math.max(h - e, 0)} />
            {e > 0 && <rect className="bar err" x={x} y={height - 1 - e} width={bar} height={e} />}
          </g>
        );
      })}
    </svg>
  );
}
