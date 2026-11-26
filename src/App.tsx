import {
  Activity, BarChart3, Boxes, Building2, ClipboardList, CreditCard, FileText, LayoutDashboard, Package, Settings, Truck, Users,
} from "lucide-react";
import { lazy, Suspense, useEffect } from "react";
import { Link, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { useAuth } from "./auth/AuthProvider";
import { FullPageLoader, RequireAuth, RequireRole, RoleHome } from "./auth/guards";
import { Logo } from "./components/brand/Logo";
import { CustomerLayout } from "./components/layout/CustomerLayout";
import { DashboardLayout, type NavItem } from "./components/layout/DashboardLayout";
import { Button } from "./components/ui/button";
import { initNativeApp, isNativeApp } from "./lib/native";
import { isSupabaseConfigured, supabase } from "./lib/supabase";

const Landing = lazy(() => import("./pages/public/Landing"));
const AuthPages = import("./pages/public/AuthPages");
const Login = lazy(() => AuthPages.then((m) => ({ default: m.Login })));
const Signup = lazy(() => AuthPages.then((m) => ({ default: m.Signup })));
const ForgotPassword = lazy(() => AuthPages.then((m) => ({ default: m.ForgotPassword })));
const ResetPassword = lazy(() => AuthPages.then((m) => ({ default: m.ResetPassword })));
const Onb = () => import("./pages/public/Onboarding");
const SupplierOnboarding = lazy(() => Onb().then((m) => ({ default: m.SupplierOnboarding })));
const CustomerOnboarding = lazy(() => Onb().then((m) => ({ default: m.CustomerOnboarding })));
const Join = lazy(() => Onb().then((m) => ({ default: m.Join })));
const Notifications = lazy(() => import("./pages/shared/Notifications"));

const CustomerHome = lazy(() => import("./pages/customer/Home"));
const COrders = () => import("./pages/customer/Orders");
const NewOrder = lazy(() => COrders().then((m) => ({ default: m.NewOrder })));
const OrdersList = lazy(() => COrders().then((m) => ({ default: m.OrdersList })));
const CustomerDeliveries = lazy(() => import("./pages/customer/Deliveries"));
const Consumption = lazy(() => import("./pages/customer/Consumption"));
const Bills = lazy(() => import("./pages/customer/Bills"));
const CustomerSettings = lazy(() => import("./pages/customer/Settings"));

const SupplierDashboard = lazy(() => import("./pages/supplier/Dashboard"));
const Customers = lazy(() => import("./pages/supplier/Customers"));
const CustomerDetail = lazy(() => import("./pages/supplier/CustomerDetail"));
const SupplierDeliveries = lazy(() => import("./pages/supplier/Deliveries"));
const SupplierOrders = lazy(() => import("./pages/supplier/Orders"));
const Inventory = lazy(() => import("./pages/supplier/Inventory"));
const SupplierBills = lazy(() => import("./pages/supplier/Bills"));
const SupplierPayments = lazy(() => import("./pages/supplier/Payments"));
const Reports = lazy(() => import("./pages/supplier/Reports"));
const SupplierSettings = lazy(() => import("./pages/supplier/Settings"));

const Adm = () => import("./pages/admin/Admin");
const AdminDashboard = lazy(() => Adm().then((m) => ({ default: m.AdminDashboard })));
const AdminSuppliers = lazy(() => Adm().then((m) => ({ default: m.AdminSuppliers })));
const AdminCustomers = lazy(() => Adm().then((m) => ({ default: m.AdminCustomers })));
const AdminPlans = lazy(() => Adm().then((m) => ({ default: m.AdminPlans })));
const AdminActivity = lazy(() => Adm().then((m) => ({ default: m.AdminActivity })));

const supplierNav: NavItem[] = [
  { to: "/supplier", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/supplier/customers", label: "Customers", icon: Users },
  { to: "/supplier/deliveries", label: "Deliveries", icon: Truck },
  { to: "/supplier/orders", label: "Orders", icon: ClipboardList },
  { to: "/supplier/inventory", label: "Inventory", icon: Boxes },
  { to: "/supplier/bills", label: "Monthly Bills", icon: FileText },
  { to: "/supplier/payments", label: "Payments", icon: CreditCard },
  { to: "/supplier/reports", label: "Reports", icon: BarChart3 },
  { to: "/supplier/settings", label: "Business Settings", icon: Settings },
];
const adminNav: NavItem[] = [
  { to: "/admin", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/admin/suppliers", label: "Suppliers", icon: Building2 },
  { to: "/admin/customers", label: "Customers", icon: Users },
  { to: "/admin/plans", label: "Plans", icon: Package },
  { to: "/admin/activity", label: "System activity", icon: Activity },
];

function SuspendedBanner() {
  const { supplier } = useAuth();
  if (supplier?.status !== "suspended") return null;
  return <div className="bg-red-600 px-4 py-2 text-center text-sm font-medium text-white">Your account is suspended. You can view data but cannot record deliveries or bill customers. Contact Waterdrop support.</div>;
}

/** Signed-in visitors skip the marketing page and go straight to their dashboard. */
function HomeOrLanding() {
  const { session, ready } = useAuth();
  if (!ready) return <FullPageLoader />;
  return session ? <Navigate to="/home" replace /> : <Landing />;
}

function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <Logo size="lg" />
      <p className="text-lg font-semibold">This page dried up.</p>
      <Button asChild><Link to="/home">Go home</Link></Button>
    </div>
  );
}

function Disabled() {
  const { signOut } = useAuth();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <Logo size="lg" />
      <p className="text-lg font-semibold">This account has been disabled.</p>
      <p className="text-sm text-muted-foreground">Contact Waterdrop support if you believe this is a mistake.</p>
      <Button variant="outline" onClick={signOut}>Sign out</Button>
    </div>
  );
}

function ConfigMissing() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md rounded-2xl border bg-card p-6">
        <Logo />
        <h1 className="mt-4 text-lg font-bold">Connect Supabase to start</h1>
        <p className="mt-2 text-sm text-muted-foreground">This build has no Supabase settings. Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in <code>.env.production</code> (or as <b>build</b> variables on your host) and rebuild. For local development use <code>.env.local</code>. See README.md.</p>
      </div>
    </div>
  );
}

export default function App() {
  const navigate = useNavigate();
  useEffect(
    () =>
      initNativeApp(
        () => navigate(-1),
        (active) => (active ? supabase.auth.startAutoRefresh() : supabase.auth.stopAutoRefresh()),
      ),
    [navigate],
  );
  if (!isSupabaseConfigured) return <ConfigMissing />;
  return (
    <Suspense fallback={<FullPageLoader />}>
      <Routes>
        <Route path="/" element={isNativeApp ? <Navigate to="/home" replace /> : <HomeOrLanding />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/join" element={<Join />} />
        <Route path="/join/:token" element={<Join />} />
        <Route path="/disabled" element={<Disabled />} />

        <Route element={<RequireAuth />}>
          <Route path="/home" element={<RoleHome />} />
          <Route path="/onboarding/supplier" element={<SupplierOnboarding />} />
          <Route path="/onboarding/customer" element={<CustomerOnboarding />} />

          <Route element={<RequireRole role="customer" />}>
            <Route path="/app" element={<CustomerLayout />}>
              <Route index element={<CustomerHome />} />
              <Route path="order" element={<NewOrder />} />
              <Route path="orders" element={<OrdersList />} />
              <Route path="deliveries" element={<CustomerDeliveries />} />
              <Route path="consumption" element={<Consumption />} />
              <Route path="bills" element={<Bills />} />
              <Route path="payments" element={<Navigate to="/app/bills" replace />} />
              <Route path="notifications" element={<Notifications />} />
              <Route path="settings" element={<CustomerSettings />} />
            </Route>
          </Route>

          <Route element={<RequireRole role="supplier" />}>
            <Route path="/supplier" element={<DashboardLayout nav={supplierNav} title="Supplier" notificationsPath="/supplier/notifications" banner={<SuspendedBanner />} />}>
              <Route index element={<SupplierDashboard />} />
              <Route path="customers" element={<Customers />} />
              <Route path="customers/:id" element={<CustomerDetail />} />
              <Route path="deliveries" element={<SupplierDeliveries />} />
              <Route path="orders" element={<SupplierOrders />} />
              <Route path="inventory" element={<Inventory />} />
              <Route path="bills" element={<SupplierBills />} />
              <Route path="payments" element={<SupplierPayments />} />
              <Route path="reports" element={<Reports />} />
              <Route path="settings" element={<SupplierSettings />} />
              <Route path="notifications" element={<Notifications />} />
            </Route>
          </Route>

          <Route element={<RequireRole role="admin" />}>
            <Route path="/admin" element={<DashboardLayout nav={adminNav} title="Platform admin" notificationsPath="/admin/notifications" />}>
              <Route index element={<AdminDashboard />} />
              <Route path="suppliers" element={<AdminSuppliers />} />
              <Route path="customers" element={<AdminCustomers />} />
              <Route path="plans" element={<AdminPlans />} />
              <Route path="activity" element={<AdminActivity />} />
              <Route path="notifications" element={<Notifications />} />
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
