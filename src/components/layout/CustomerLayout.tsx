import { Droplets, FileText, Home, Package, Settings } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import { Logo } from "@/components/brand/Logo";
import { cn } from "@/lib/utils";
import { NotificationBell } from "./NotificationBell";

const tabs = [
  { to: "/app", label: "Home", icon: Home, end: true },
  { to: "/app/orders", label: "Orders", icon: Package },
  { to: "/app/consumption", label: "Usage", icon: Droplets },
  { to: "/app/bills", label: "Bills", icon: FileText },
  { to: "/app/settings", label: "Settings", icon: Settings },
];

/** Simple, thumb-friendly shell for customers (bottom tabs on mobile). */
export function CustomerLayout() {
  const { customers, activeCustomer, setActiveCustomerId } = useAuth();
  return (
    <div className="min-h-screen pb-24 md:pb-8">
      <header className="safe-top sticky top-0 z-30 border-b bg-card/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-3xl items-center gap-3 px-4">
          <Logo size="sm" />
          {customers.length > 1 && (
            <select
              aria-label="Supplier account"
              className="ml-2 max-w-[40vw] truncate rounded-md border bg-card px-2 py-1 text-sm"
              value={activeCustomer?.id}
              onChange={(e) => setActiveCustomerId(e.target.value)}
            >
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.customer_name} · {c.address.slice(0, 18)}</option>
              ))}
            </select>
          )}
          <nav className="ml-auto hidden items-center gap-1 md:flex" aria-label="Main">
            {tabs.map((t) => (
              <NavLink key={t.to} to={t.to} end={t.end}
                className={({ isActive }) => cn("rounded-lg px-3 py-2 text-sm font-medium", isActive ? "bg-secondary text-primary" : "text-slate-600 hover:bg-secondary")}>
                {t.label}
              </NavLink>
            ))}
          </nav>
          <NotificationBell to="/app/notifications" className="ml-auto md:ml-0" />
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl px-4 py-5">
        <Outlet />
      </main>
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t bg-card md:hidden" aria-label="Main">
        <div className="mx-auto grid max-w-md grid-cols-5">
          {tabs.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end}
              className={({ isActive }) => cn("flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium", isActive ? "text-primary" : "text-slate-500")}>
              <t.icon className="h-5 w-5" />
              {t.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
