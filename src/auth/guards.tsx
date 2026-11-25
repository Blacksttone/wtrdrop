import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Logo } from "@/components/brand/Logo";
import type { AppRole } from "@/types/db";
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
export function RequireRole({ role }: { role: AppRole }) {
  const { profile, supplier, customers, loadingProfile } = useAuth();
  if (loadingProfile || !profile) return <FullPageLoader />;
  if (profile.is_disabled) return <Navigate to="/disabled" replace />;
  if (profile.role !== role) return <Navigate to={homeFor(profile.role, !!supplier, customers.length > 0)} replace />;
  if (role === "supplier" && !supplier) return <Navigate to="/onboarding/supplier" replace />;
  if (role === "customer" && customers.length === 0) return <Navigate to="/onboarding/customer" replace />;
  return <Outlet />;
}

export function RoleHome() {
  const { session, ready, profile, supplier, customers, loadingProfile } = useAuth();
  if (!ready || (session && (loadingProfile || !profile))) return <FullPageLoader />;
  if (!session) return <Navigate to="/" replace />;
  return <Navigate to={homeFor(profile?.role, !!supplier, customers.length > 0)} replace />;
}
