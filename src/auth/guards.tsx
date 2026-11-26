import { ShieldOff } from "lucide-react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/Logo";
import type { AppRole, SupplierRole } from "@/types/db";
import { useAuth } from "./AuthProvider";

export function FullPageLoader() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4" role="status">
      <div className="relative">
        <span className="absolute inset-0 animate-ripple rounded-full bg-sky-300" />
        <Logo size="lg" />
      </div>
      <span className="sr-only">Loading Waterdrop…</span>
    </div>
  );
}

export function homeFor(role: AppRole | undefined, hasSupplier: boolean, hasCustomer: boolean) {
  if (role === "admin") return "/admin";
  if (role === "supplier") return hasSupplier ? "/supplier" : "/onboarding/supplier";
  if (role === "customer") return hasCustomer ? "/app" : "/onboarding/customer";
  return "/login";
}

export function RequireAuth() {
  const { session, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <FullPageLoader />;
  if (!session) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <Outlet />;
}

/** Ensures the user has the role and has finished onboarding. */
export function BlockedScreen({ title, message }: { title: string; message: string }) {
  const { signOut } = useAuth();
  return (
    <div className="safe-top flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <span className="rounded-full bg-red-50 p-4 text-stock-critical"><ShieldOff className="h-8 w-8" /></span>
      <Logo />
      <h1 className="text-xl font-bold">{title}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={signOut}>Sign out</Button>
    </div>
  );
}

/** Restricts a supplier route to some roles (delivery co-workers see fewer pages). */
export function RequireSupplierRole({ roles }: { roles: SupplierRole[] }) {
  const { supplierRole } = useAuth();
  if (!supplierRole || !roles.includes(supplierRole)) return <Navigate to="/supplier" replace />;
  return <Outlet />;
}

export function RequireRole({ role }: { role: AppRole }) {
  const { profile, supplier, customers, loadingProfile, staffBlocked, memberBlocked } = useAuth();
  if (loadingProfile || !profile) return <FullPageLoader />;
  if (profile.is_disabled) return <Navigate to="/disabled" replace />;
  if (profile.role !== role) return <Navigate to={homeFor(profile.role, !!supplier, customers.length > 0)} replace />;
  if (role === "supplier" && staffBlocked)
    return <BlockedScreen title="Access blocked" message="The business owner has blocked your co-worker access. Contact them to get access again." />;
  if (role === "supplier" && !supplier) return <Navigate to="/onboarding/supplier" replace />;
  if (role === "customer" && memberBlocked)
    return <BlockedScreen title="Access blocked" message="The account owner has blocked your access. Contact them to get access again." />;
  if (role === "customer" && customers.length === 0) return <Navigate to="/onboarding/customer" replace />;
  return <Outlet />;
}

export function RoleHome() {
  const { session, ready, profile, supplier, customers, loadingProfile } = useAuth();
  if (!ready || (session && (loadingProfile || !profile))) return <FullPageLoader />;
  if (!session) return <Navigate to="/" replace />;
  return <Navigate to={homeFor(profile?.role, !!supplier, customers.length > 0)} replace />;
}
