import { cn } from "@/lib/utils";
import type { StockLevel } from "@/lib/domain/stock";

export const LEVEL_META: Record<StockLevel, { label: string; text: string; bg: string; ring: string; fill: string }> = {
  ok: { label: "Sufficient stock", text: "text-stock-ok", bg: "bg-emerald-50", ring: "ring-emerald-200", fill: "#16a34a" },
  low: { label: "Low stock", text: "text-amber-600", bg: "bg-amber-50", ring: "ring-amber-200", fill: "#f59e0b" },
  critical: { label: "Critical stock", text: "text-stock-critical", bg: "bg-red-50", ring: "ring-red-200", fill: "#dc2626" },
  unknown: { label: "Stock not confirmed", text: "text-slate-500", bg: "bg-slate-100", ring: "ring-slate-200", fill: "#94a3b8" },
};

/** Big circular droplet gauge showing cans in stock, coloured by level. */
export function StockGauge({ stock, level, capacity }: { stock: number; level: StockLevel; capacity: number }) {
  const meta = LEVEL_META[level];
  const pct = level === "unknown" ? 0 : Math.max(0.06, Math.min(1, stock / Math.max(capacity, 1)));
  const fillY = 100 - pct * 84 - 8;
  return (
    <div className="relative mx-auto h-44 w-36" role="img" aria-label={`${stock} cans available, ${meta.label}`}>
      <svg viewBox="0 0 100 120" className="h-full w-full drop-shadow-sm">
        <defs>
          <clipPath id="drop-clip">
            <path d="M50 4C50 4 12 48 12 72a38 38 0 0 0 76 0C88 48 50 4 50 4Z" />
          </clipPath>
        </defs>
        <path d="M50 4C50 4 12 48 12 72a38 38 0 0 0 76 0C88 48 50 4 50 4Z" fill="#f1f5f9" stroke="#e2e8f0" strokeWidth="2" />
        <g clipPath="url(#drop-clip)">
          <rect x="0" y={fillY + 12} width="100" height="120" fill={meta.fill} opacity="0.9" />
          <path d={`M0 ${fillY + 14} Q 25 ${fillY + 6} 50 ${fillY + 14} T 100 ${fillY + 14} V 120 H 0 Z`} fill={meta.fill} />
        </g>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pt-8">
        <span className={cn("text-5xl font-extrabold tabular-nums drop-shadow", level === "unknown" ? "text-slate-500" : pct > 0.45 ? "text-white" : "text-slate-900")}>
          {level === "unknown" ? "?" : stock}
        </span>
        <span className={cn("text-xs font-semibold uppercase tracking-wider", pct > 0.45 && level !== "unknown" ? "text-white/90" : "text-slate-600")}>
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
