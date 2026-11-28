import * as React from "react";
import { cn } from "@/lib/utils";
import type { StockLevel } from "@/lib/domain/stock";

export const LEVEL_META: Record<StockLevel, { label: string; text: string; bg: string; ring: string; fill: string }> = {
  ok: { label: "Sufficient stock", text: "text-stock-ok", bg: "bg-emerald-50", ring: "ring-emerald-200", fill: "#16a34a" },
  low: { label: "Low stock", text: "text-amber-600", bg: "bg-amber-50", ring: "ring-amber-200", fill: "#f59e0b" },
  critical: { label: "Critical stock", text: "text-stock-critical", bg: "bg-red-50", ring: "ring-red-200", fill: "#dc2626" },
  unknown: { label: "Stock not confirmed", text: "text-slate-500", bg: "bg-slate-100", ring: "ring-slate-200", fill: "#94a3b8" },
};

/** Wave path wider than the drop so it can slide sideways forever (one period = 100 units). */
const wave = (y: number, amp: number) =>
  `M0 ${y} Q 25 ${y - amp} 50 ${y} T 100 ${y} T 150 ${y} T 200 ${y} V 130 H 0 Z`;

/** Droplet gauge with moving water: waves flow, bubbles rise, and the level fills up on load. */
export function StockGauge({ stock, level, capacity }: { stock: number; level: StockLevel; capacity: number }) {
  const meta = LEVEL_META[level];
  const id = React.useId().replace(/:/g, "");
  const pct = level === "unknown" ? 0 : Math.max(0.06, Math.min(1, stock / Math.max(capacity, 1)));
  const fillY = 100 - pct * 84 - 8 + 12; // water surface y inside the 0–120 drop
  const empty = level === "unknown";
  return (
    <div className="relative mx-auto h-44 w-36" role="img" aria-label={`${stock} cans available, ${meta.label}`}>
      <svg viewBox="0 0 100 120" className="h-full w-full drop-shadow-sm">
        <defs>
          <clipPath id={`drop-${id}`}>
            <path d="M50 4C50 4 12 48 12 72a38 38 0 0 0 76 0C88 48 50 4 50 4Z" />
          </clipPath>
        </defs>
        <path d="M50 4C50 4 12 48 12 72a38 38 0 0 0 76 0C88 48 50 4 50 4Z" fill="#f1f5f9" stroke="#e2e8f0" strokeWidth="2" />
        {!empty && (
          <g clipPath={`url(#drop-${id})`}>
            <g className="wd-water-rise" style={{ ["--wd-rise" as string]: `${120 - fillY}px` }}>
              <path className="wd-wave-back" d={wave(fillY - 1, 4)} fill={meta.fill} opacity="0.45" />
              <path className="wd-wave-front" d={wave(fillY + 2, 3)} fill={meta.fill} opacity="0.95" />
              <circle className="wd-bubble" cx="35" cy="112" r="1.6" fill="white" opacity="0.7" />
              <circle className="wd-bubble wd-bubble-2" cx="58" cy="114" r="1.2" fill="white" opacity="0.6" />
              <circle className="wd-bubble wd-bubble-3" cx="67" cy="110" r="1" fill="white" opacity="0.6" />
            </g>
          </g>
        )}
        {/* glossy highlight */}
        <path d="M34 40 C 28 52 24 62 25 72" stroke="white" strokeOpacity="0.55" strokeWidth="3" strokeLinecap="round" fill="none" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pt-8">
        <span className={cn("text-5xl font-extrabold tabular-nums drop-shadow", empty ? "text-slate-500" : pct > 0.45 ? "text-white" : "text-slate-900")}>
          {empty ? "?" : stock}
        </span>
        <span className={cn("text-xs font-semibold uppercase tracking-wider", pct > 0.45 && !empty ? "text-white/90" : "text-slate-600")}>
          can{stock === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}

export function LevelPill({ level, className }: { level: StockLevel; className?: string }) {
  const m = LEVEL_META[level];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1", m.bg, m.text, m.ring, className)}>
      <span className="h-2 w-2 rounded-full" style={{ background: m.fill }} aria-hidden />
      {m.label}
    </span>
  );
}
