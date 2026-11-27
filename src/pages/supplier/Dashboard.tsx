import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, ClipboardList, IndianRupee, PackageCheck, Truck, Users, Wallet } from "lucide-react";
import { Link } from "react-router-dom";
import { useCanManage, useSupplier } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, LoadingState, PageHeader, StatCard } from "@/components/ui/states";
import { LevelPill } from "@/components/water/StockGauge";
import { StatusBadge } from "@/components/water/StatusBadge";
import type { StockLevel } from "@/lib/domain/stock";
import { formatDate, formatMoney } from "@/lib/format";
import { rpc } from "@/lib/supabase";
import type { SupplierDashboard as Dash } from "@/types/db";
import { useConnectionRequests } from "./Customers";
import { CanReportCard } from "@/components/water/CanControls";

function ListCard({ title, to, empty, children, count }: { title: string; to: string; empty: string; children: React.ReactNode; count: number }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>{title}</CardTitle>
        <Link to={to} className="flex items-center gap-1 text-sm font-medium text-primary">View all <ArrowRight className="h-3 w-3" /></Link>
      </CardHeader>
      <CardContent>{count === 0 ? <p className="py-4 text-center text-sm text-muted-foreground">{empty}</p> : <ul className="divide-y">{children}</ul>}</CardContent>
    </Card>
  );
}

export default function SupplierDashboard() {
  const supplier = useSupplier();
  const canManage = useCanManage();
  const requests = useConnectionRequests();
  const pendingRequests = requests.data?.length ?? 0;
  const { data: d, isLoading, error, refetch } = useQuery({ queryKey: ["supplier-dashboard"], queryFn: () => rpc<Dash>("get_supplier_dashboard"), refetchInterval: 60_000 });
  if (isLoading) return <LoadingState rows={6} />;
  if (error || !d) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <div>
      <PageHeader
        title={`Good day, ${supplier.owner_name.split(" ")[0]}`}
        description={`${supplier.business_name} · Supplier code ${supplier.business_code} · ${formatDate(d.today, "EEEE, d MMM")}`}
        actions={<><Button asChild variant="outline"><Link to="/supplier/orders"><ClipboardList /> Orders</Link></Button><Button asChild><Link to="/supplier/deliveries?new=1"><Truck /> Record delivery</Link></Button></>}
      />
      {pendingRequests > 0 && (
        <Link to="/supplier/customers?tab=requests" className="mb-4 flex items-center gap-3 rounded-xl border border-primary/40 bg-secondary p-3">
          <Users className="h-5 w-5 text-primary" />
          <span className="flex-1 text-sm font-semibold">{pendingRequests} new customer request{pendingRequests === 1 ? "" : "s"} waiting for you</span>
          <ArrowRight className="h-4 w-4 text-primary" />
        </Link>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Customers" value={d.total_customers} icon={Users} />
        <StatCard label="Today's orders" value={d.todays_orders} hint={`${d.pending_orders} pending response`} icon={ClipboardList} tone={d.pending_orders ? "low" : "default"} />
        <StatCard label="Pending deliveries" value={d.pending_deliveries} hint={`${d.awaiting_confirmation} awaiting customer confirmation`} icon={Truck} />
        <StatCard label="Delivered today" value={`${d.delivered_today} cans`} hint={`${d.delivered_this_month} this month`} icon={PackageCheck} tone="ok" />
        {canManage && <>
          <StatCard label="Revenue this month" value={formatMoney(d.revenue_this_month)} hint="Confirmed deliveries" icon={IndianRupee} />
          <StatCard label="Collected this month" value={formatMoney(d.collected_this_month)} icon={Wallet} tone="ok" />
          <StatCard label="Outstanding" value={formatMoney(d.outstanding_total)} hint={`${d.pending_payment_verifications} payments to verify`} icon={AlertTriangle} tone={Number(d.outstanding_total) > 0 ? "low" : "default"} />
        </>}
        <StatCard label="Low-stock customers" value={d.low_stock_customers.length} icon={AlertTriangle} tone={d.low_stock_customers.length ? "critical" : "default"} />
      </div>

      <div className="mt-5"><CanReportCard /></div>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <ListCard title="Needs delivery today" to="/supplier/orders" empty="No deliveries due today." count={d.needs_delivery_today.length}>
          {d.needs_delivery_today.map((o) => (
            <li key={o.order_id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <Link to={`/supplier/customers/${o.customer_id}`} className="font-medium hover:underline">{o.customer_name}</Link>
                <p className="truncate text-xs text-muted-foreground">{o.address}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2"><span className="font-bold">{o.quantity}</span><StatusBadge status={o.status} /></div>
            </li>
          ))}
        </ListCard>
        <ListCard title="Running low" to="/supplier/inventory" empty="Every customer has enough water." count={d.low_stock_customers.length}>
          {d.low_stock_customers.map((c) => (
            <li key={c.customer_id} className="flex items-center justify-between gap-3 py-2.5">
              <div>
                <Link to={`/supplier/customers/${c.customer_id}`} className="font-medium hover:underline">{c.customer_name}</Link>
                <p className="text-xs text-muted-foreground">{c.predicted_empty_date ? `Empty by ${formatDate(c.predicted_empty_date, "d MMM")}` : "No usage data"}{c.has_open_order ? " · order open" : ""}</p>
              </div>
              <div className="flex items-center gap-2"><span className="font-bold">{c.stock}</span><LevelPill level={(c.level === "none" ? "ok" : c.level) as StockLevel} /></div>
            </li>
          ))}
        </ListCard>
        {canManage && <ListCard title="Outstanding bills" to="/supplier/payments" empty="No outstanding balances." count={d.outstanding_customers.length}>
          {d.outstanding_customers.map((c) => (
            <li key={c.customer_id} className="flex items-center justify-between py-2.5">
              <Link to={`/supplier/customers/${c.customer_id}`} className="font-medium hover:underline">{c.customer_name}</Link>
              <span className="font-semibold text-amber-700">{formatMoney(c.balance)}</span>
            </li>
          ))}
        </ListCard>}
        <ListCard title="Delivery discrepancies (30 days)" to={canManage ? "/supplier/reports?r=accuracy" : "/supplier/deliveries"} empty="No shortages reported by customers." count={d.discrepancy_customers.length}>
          {d.discrepancy_customers.map((c) => (
            <li key={c.customer_id} className="flex items-center justify-between py-2.5">
              <Link to={`/supplier/customers/${c.customer_id}`} className="font-medium hover:underline">{c.customer_name}</Link>
              <span className="text-sm"><b className="text-stock-critical">{c.total_shortage}</b> cans short · {c.deliveries} deliveries</span>
            </li>
          ))}
        </ListCard>
      </div>
    </div>
  );
}
