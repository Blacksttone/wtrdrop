import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MapPin } from "lucide-react";
import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui/states";
import { directionsUrl } from "@/lib/location";
import { openExternal } from "@/lib/native";
import type { CustomerListRow, StockLevel } from "@/types/db";
import { useCustomerList } from "./dialogs";

/** Marker colour by stock level: green → amber → red (grey = stock not confirmed yet). */
export const LEVEL_COLOR: Record<StockLevel | "unknown", string> = {
  ok: "#16a34a", low: "#f59e0b", critical: "#dc2626", unknown: "#94a3b8",
};

const LEGEND: [StockLevel | "unknown", string][] = [["ok", "Enough"], ["low", "Low"], ["critical", "Critical / empty"], ["unknown", "Not confirmed"]];

function markerIcon(c: CustomerListRow) {
  const color = LEVEL_COLOR[(c.level as StockLevel) ?? "unknown"] ?? LEVEL_COLOR.unknown;
  const label = c.stock_confirmed ? String(c.current_stock) : "?";
  return L.divIcon({
    className: "",
    iconSize: [36, 44],
    iconAnchor: [18, 42],
    popupAnchor: [0, -38],
    html: `<div style="position:relative;width:36px;height:44px">
      <svg viewBox="0 0 36 44" width="36" height="44"><path d="M18 1C8.6 1 1 8.6 1 18c0 12.4 17 25 17 25s17-12.6 17-25C35 8.6 27.4 1 18 1z" fill="${color}" stroke="white" stroke-width="2"/></svg>
      <span style="position:absolute;top:6px;left:0;width:36px;text-align:center;color:white;font:800 13px/22px Inter,system-ui,sans-serif">${label}</span>
    </div>`,
  });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** All customers with a saved location on a map, coloured by how much water they have left. */
export default function CustomerMap() {
  const { data, isLoading, error, refetch } = useCustomerList();
  const navigate = useNavigate();
  const el = React.useRef<HTMLDivElement>(null);
  const map = React.useRef<L.Map | null>(null);
  const placed = React.useMemo(() => (data ?? []).filter((c) => c.latitude != null && c.longitude != null && c.status === "active"), [data]);
  const missing = React.useMemo(() => (data ?? []).filter((c) => c.latitude == null && c.status === "active"), [data]);
  const fitted = React.useRef(false);

  React.useEffect(() => {
    if (!el.current || !placed.length) return;
    if (!map.current) {
      map.current = L.map(el.current, { zoomControl: true }).setView([placed[0].latitude!, placed[0].longitude!], 14);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map.current);
    }
    const layer = L.layerGroup().addTo(map.current);
    // Most urgent on top.
    const rank = { critical: 3, low: 2, unknown: 1, ok: 0 } as Record<string, number>;
    for (const c of [...placed].sort((a, b) => (rank[a.level] ?? 0) - (rank[b.level] ?? 0))) {
      const name = c.account_name && c.account_type !== "home" ? `${c.account_name}${c.branch_name ? ` · ${c.branch_name}` : ""}` : c.customer_name;
      const popup = document.createElement("div");
      popup.innerHTML = `<p style="font-weight:700;margin:0">${esc(name)}</p>
        <p style="margin:2px 0;color:#64748b;font-size:12px">${esc(c.address)}</p>
        <p style="margin:4px 0;font-weight:700;color:${LEVEL_COLOR[c.level as StockLevel] ?? LEVEL_COLOR.unknown}">${c.stock_confirmed ? `${c.current_stock} cans` : "Stock not confirmed"}</p>`;
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:6px;margin-top:6px";
      const btn = (label: string, primary: boolean, onClick: () => void) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.cssText = `flex:1;padding:6px 8px;border-radius:8px;font-weight:600;font-size:12px;border:1px solid #0b6bcb;${primary ? "background:#0b6bcb;color:white" : "background:white;color:#0b6bcb"}`;
        b.onclick = onClick;
        return b;
      };
      row.append(
        btn("Directions", true, () => openExternal(directionsUrl(c.latitude!, c.longitude!))),
        btn("Open", false, () => navigate(`/supplier/customers/${c.id}`)),
      );
      popup.append(row);
      L.marker([c.latitude!, c.longitude!], { icon: markerIcon(c), title: name }).bindPopup(popup).addTo(layer);
    }
    if (!fitted.current) {
      map.current.fitBounds(L.latLngBounds(placed.map((c) => [c.latitude!, c.longitude!] as [number, number])), { padding: [40, 40], maxZoom: 16 });
      fitted.current = true;
    }
    return () => { layer.remove(); };
  }, [placed, navigate]);

  React.useEffect(() => () => { map.current?.remove(); map.current = null; fitted.current = false; }, []);

  if (isLoading) return <LoadingState rows={4} />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <div className="space-y-4">
      <PageHeader title="Customer map" description="Where your customers are and how much water they have left." />
      <div className="flex flex-wrap gap-3 text-xs">
        {LEGEND.map(([k, label]) => (
          <span key={k} className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-full" style={{ background: LEVEL_COLOR[k] }} /> {label}</span>
        ))}
        <span className="text-muted-foreground">· number = full cans left</span>
      </div>
      {!placed.length ? (
        <EmptyState icon={MapPin} title="No locations saved yet"
          description="Open a customer and tap 'Save current location' at their door, or ask customers to save it in their app." />
      ) : (
        <Card className="overflow-hidden"><div ref={el} className="h-[65vh] min-h-[360px] w-full" aria-label="Customer map" /></Card>
      )}
      {missing.length > 0 && (
        <Card className="p-4 text-sm">
          <p className="font-semibold">{missing.length} customer{missing.length === 1 ? "" : "s"} without a location</p>
          <p className="mb-2 text-muted-foreground">Save it when you are at their door.</p>
          <ul className="flex flex-wrap gap-2">
            {missing.slice(0, 30).map((c) => (
              <li key={c.id}><Link className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-primary" to={`/supplier/customers/${c.id}`}>{c.customer_name}</Link></li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
