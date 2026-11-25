import { LogOut, Menu, X } from "lucide-react";
import * as React from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NotificationBell } from "./NotificationBell";

export interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  end?: boolean;
}

/** Data-rich shell used by suppliers and platform admins. */
export function DashboardLayout({ nav, title, notificationsPath, banner }: {
  nav: NavItem[];
  title: string;
  notificationsPath: string;
  banner?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const loc = useLocation();
  const { profile, signOut } = useAuth();
  React.useEffect(() => setOpen(false), [loc.pathname]);

  const links = (
    <nav className="flex flex-col gap-1 p-3" aria-label="Main">
      {nav.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              isActive ? "bg-primary text-primary-foreground shadow-sm" : "text-slate-600 hover:bg-secondary hover:text-secondary-foreground",
            )
          }
        >
          <item.icon className="h-4 w-4" />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="hidden border-r bg-card lg:flex lg:flex-col">
        <div className="flex h-16 items-center border-b px-5"><Logo size="sm" /></div>
        <div className="px-5 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
        {links}
        <div className="mt-auto border-t p-3">
          <div className="mb-2 truncate px-3 text-sm font-medium">{profile?.full_name || profile?.email}</div>
          <Button variant="ghost" className="w-full justify-start" onClick={signOut}><LogOut /> Sign out</Button>
        </div>
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute inset-y-0 left-0 flex w-72 flex-col bg-card shadow-xl">
            <div className="flex h-16 items-center justify-between border-b px-5">
              <Logo size="sm" />
              <button onClick={() => setOpen(false)} aria-label="Close menu" className="rounded p-1 hover:bg-secondary"><X className="h-5 w-5" /></button>
            </div>
            {links}
            <div className="mt-auto border-t p-3">
              <Button variant="ghost" className="w-full justify-start" onClick={signOut}><LogOut /> Sign out</Button>
            </div>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-card/90 px-4 backdrop-blur lg:px-8">
          <button className="rounded-lg p-2 hover:bg-secondary lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </button>
          <div className="lg:hidden"><Logo size="sm" /></div>
          <div className="ml-auto flex items-center gap-2">
            <NotificationBell to={notificationsPath} />
          </div>
        </header>
        {banner}
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
