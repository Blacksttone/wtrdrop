import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, Building2, IndianRupee, Package, Truck, Users } from "lucide-react";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Switch, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatCard } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { StatusBadge } from "@/components/water/StatusBadge";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { rpc, supabase } from "@/lib/supabase";
import Reports from "../supplier/Reports";

interface Stats { suppliers: number; active_suppliers: number; suspended_suppliers: number; customers: number; users: number; orders_30d: number; cans_delivered_30d: number; billed_30d: number; collected_30d: number; failed_jobs_7d: number; failed_notifications_7d: number }
interface SupplierRow { id: string; business_name: string; business_code: string; owner_name: string; phone: string; email: string | null; status: "active" | "suspended"; plan_name: string | null; customers: number; created_at: string }
interface Plan { id: string; name: string; price_monthly: number; max_customers: number | null; features: string[]; is_active: boolean }

export function AdminDashboard() {
  const { data: s, isLoading, error, refetch } = useQuery({ queryKey: ["admin-stats"], queryFn: () => rpc<Stats>("admin_platform_stats") });
  if (isLoading) return <LoadingState rows={4} />;
  if (error || !s) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <div>
      <PageHeader title="Platform overview" description="Last 30 days unless noted." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Suppliers" value={s.suppliers} hint={`${s.active_suppliers} active · ${s.suspended_suppliers} suspended`} icon={Building2} />
        <StatCard label="Customers" value={s.customers} hint={`${s.users} user accounts`} icon={Users} />
        <StatCard label="Orders" value={s.orders_30d} icon={Package} />
        <StatCard label="Cans delivered" value={s.cans_delivered_30d} icon={Truck} tone="ok" />
        <StatCard label="Billed" value={formatMoney(s.billed_30d)} icon={IndianRupee} />
        <StatCard label="Collected" value={formatMoney(s.collected_30d)} icon={IndianRupee} tone="ok" />
        <StatCard label="Failed jobs (7d)" value={s.failed_jobs_7d} icon={Activity} tone={s.failed_jobs_7d ? "critical" : "default"} />
        <StatCard label="Failed notifications (7d)" value={s.failed_notifications_7d} icon={AlertTriangle} tone={s.failed_notifications_7d ? "low" : "default"} />
      </div>
    </div>
  );
}

export function AdminSuppliers() {
  const list = useQuery({ queryKey: ["admin-suppliers"], queryFn: () => rpc<SupplierRow[]>("admin_list_suppliers") });
  const plans = useQuery({ queryKey: ["plans"], queryFn: async () => (await supabase.from("subscription_plans").select("*").order("price_monthly")).data as Plan[] });
  const [target, setTarget] = React.useState<SupplierRow | null>(null);
  const [reason, setReason] = React.useState("");
  const [reportFor, setReportFor] = React.useState<string | null>(null);
  const toggle = useAction(() => rpc("admin_set_supplier_status", { p_supplier_id: target!.id, p_status: target!.status === "active" ? "suspended" : "active", p_reason: reason }), {
    success: "Supplier status updated", invalidate: [["admin-suppliers"], ["admin-stats"]], onSuccess: () => { setTarget(null); setReason(""); },
  });
  const setPlan = useAction((v: { id: string; plan: string }) => rpc("admin_set_supplier_plan", { p_supplier_id: v.id, p_plan_id: v.plan || null }), {
    success: "Plan updated", invalidate: [["admin-suppliers"]],
  });
  if (reportFor) return <div><Button variant="outline" className="mb-4" onClick={() => setReportFor(null)}>← Back to suppliers</Button><Reports supplierId={reportFor} /></div>;
  return (
    <div>
      <PageHeader title="Suppliers" />
      {list.isLoading ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={list.refetch} /> : !list.data?.length ? <EmptyState title="No suppliers yet" /> : (
        <Card>
          <Table>
            <THead><TR><TH>Business</TH><TH>Owner</TH><TH>Code</TH><TH>Customers</TH><TH>Plan</TH><TH>Status</TH><TH>Joined</TH><TH /></TR></THead>
            <TBody>
              {list.data.map((s) => (
                <TR key={s.id}>
                  <TD className="font-medium">{s.business_name}</TD>
                  <TD>{s.owner_name}<div className="text-xs text-muted-foreground">{s.phone}</div></TD>
                  <TD className="font-mono text-xs">{s.business_code}</TD>
                  <TD>{s.customers}</TD>
                  <TD>
                    <Select aria-label="Plan" className="h-8 w-32 text-xs" value={plans.data?.find((p) => p.name === s.plan_name)?.id ?? ""} onChange={(e) => setPlan.mutate({ id: s.id, plan: e.target.value })}>
                      <option value="">No plan</option>
                      {plans.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </Select>
                  </TD>
                  <TD><StatusBadge status={s.status} /></TD>
                  <TD>{formatDate(s.created_at)}</TD>
                  <TD className="space-x-1">
                    <Button size="sm" variant="ghost" onClick={() => setReportFor(s.id)}>Reports</Button>
                    <Button size="sm" variant={s.status === "active" ? "outline" : "success"} onClick={() => setTarget(s)}>{s.status === "active" ? "Suspend" : "Activate"}</Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      {target && (
        <Dialog open onOpenChange={(o) => !o && setTarget(null)}>
          <DialogContent title={`${target.status === "active" ? "Suspend" : "Activate"} ${target.business_name}?`} description={target.status === "active" ? "Suspended suppliers can view data but cannot record deliveries, bill or accept orders." : "The supplier regains full access."}>
            <Field label="Reason (sent to supplier, audited)" htmlFor="rs"><Textarea id="rs" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <Button className="mt-4 w-full" variant={target.status === "active" ? "destructive" : "success"} disabled={reason.trim().length < 3} loading={toggle.isPending} onClick={() => toggle.mutate(undefined)}>Confirm</Button>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

interface AdminCustomerRow { id: string; customer_name: string; phone: string | null; supplier_name: string; has_app: boolean; user_id: string | null; user_disabled: boolean; status: string; current_stock: number; balance: number; created_at: string; account_name: string | null; account_type: string | null; branch_name: string | null }

export function AdminCustomers() {
  const [q, setQ] = React.useState("");
  const [search, setSearch] = React.useState("");
  const list = useQuery({ queryKey: ["admin-customers", search], queryFn: () => rpc<AdminCustomerRow[]>("admin_list_customers", { p_search: search || null }) });
  const toggle = useAction((r: AdminCustomerRow) => rpc("admin_set_user_disabled", { p_user_id: r.user_id, p_disabled: !r.user_disabled, p_reason: "Admin action" }), {
    success: "Account updated", invalidate: [["admin-customers"]],
  });
  return (
    <div>
      <PageHeader title="Customers & accounts" />
      <form className="mb-4 flex max-w-md gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); }}>
        <Input aria-label="Search" placeholder="Name or phone" value={q} onChange={(e) => setQ(e.target.value)} /><Button type="submit" variant="secondary">Search</Button>
      </form>
      {list.isLoading ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={list.refetch} /> : !list.data?.length ? <EmptyState title="No customers found" /> : (
        <Card>
          <Table>
            <THead><TR><TH>Customer</TH><TH>Supplier</TH><TH>Stock</TH><TH className="text-right">Balance</TH><TH>Account</TH><TH /></TR></THead>
            <TBody>
              {list.data.map((r) => (
                <TR key={r.id}>
                  <TD className="font-medium">{r.customer_name}<div className="text-xs text-muted-foreground">{r.phone}</div>{r.account_name && <div className="text-xs text-muted-foreground">{r.account_name} · {r.account_type}{r.branch_name ? ` · ${r.branch_name}` : ""}</div>}</TD>
                  <TD>{r.supplier_name}</TD>
                  <TD>{r.current_stock}</TD>
                  <TD className="text-right">{formatMoney(r.balance)}</TD>
                  <TD>{!r.has_app ? <Badge variant="muted">offline</Badge> : r.user_disabled ? <Badge variant="danger">disabled</Badge> : <Badge variant="success">active</Badge>}</TD>
                  <TD>{r.user_id && <Button size="sm" variant="outline" onClick={() => toggle.mutate(r)}>{r.user_disabled ? "Enable" : "Disable"}</Button>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

export function AdminPlans() {
  const plans = useQuery({ queryKey: ["plans"], queryFn: async () => {
    const { data, error } = await supabase.from("subscription_plans").select("*").order("price_monthly");
    if (error) throw error;
    return data as Plan[];
  } });
  const [editing, setEditing] = React.useState<Partial<Plan> | null>(null);
  const save = useAction(async (p: Partial<Plan>) => {
    const row = { name: p.name, price_monthly: Number(p.price_monthly ?? 0), max_customers: p.max_customers ? Number(p.max_customers) : null, features: p.features ?? [], is_active: p.is_active ?? true };
    const { error } = p.id ? await supabase.from("subscription_plans").update(row).eq("id", p.id) : await supabase.from("subscription_plans").insert(row);
    if (error) throw error;
  }, { success: "Plan saved", invalidate: [["plans"]], onSuccess: () => setEditing(null) });
  return (
    <div>
      <PageHeader title="Subscription plans" actions={<Button onClick={() => setEditing({ is_active: true, features: [] })}>New plan</Button>} />
      {plans.isLoading ? <LoadingState /> : plans.error ? <ErrorState error={plans.error} onRetry={plans.refetch} /> : (
        <div className="grid gap-4 md:grid-cols-3">
          {plans.data?.map((p) => (
            <Card key={p.id} className={!p.is_active ? "opacity-60" : ""}>
              <CardHeader><CardTitle>{p.name}</CardTitle><p className="text-2xl font-bold">{formatMoney(p.price_monthly)}<span className="text-sm font-normal text-muted-foreground">/month</span></p></CardHeader>
              <CardContent>
                <p className="text-sm">{p.max_customers ? `Up to ${p.max_customers} customers` : "Unlimited customers"}</p>
                <ul className="mt-2 list-inside list-disc text-sm text-muted-foreground">{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
                <Button variant="outline" size="sm" className="mt-4" onClick={() => setEditing(p)}>Edit</Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {editing && (
        <Dialog open onOpenChange={(o) => !o && setEditing(null)}>
          <DialogContent title={editing.id ? "Edit plan" : "New plan"}>
            <div className="space-y-3">
              <Field label="Name" htmlFor="pn"><Input id="pn" value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
              <Field label="Monthly price (₹)" htmlFor="pp"><Input id="pp" type="number" min={0} value={editing.price_monthly ?? 0} onChange={(e) => setEditing({ ...editing, price_monthly: Number(e.target.value) })} /></Field>
              <Field label="Max customers (blank = unlimited)" htmlFor="pm"><Input id="pm" type="number" min={1} value={editing.max_customers ?? ""} onChange={(e) => setEditing({ ...editing, max_customers: e.target.value ? Number(e.target.value) : null })} /></Field>
              <Field label="Features (one per line)" htmlFor="pf"><Textarea id="pf" value={(editing.features ?? []).join("\n")} onChange={(e) => setEditing({ ...editing, features: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })} /></Field>
              <div className="flex items-center justify-between"><span className="text-sm">Available for new suppliers</span><Switch id="pa" label="Active" checked={editing.is_active ?? true} onChange={(v) => setEditing({ ...editing, is_active: v })} /></div>
              <Button className="w-full" disabled={!editing.name?.trim()} loading={save.isPending} onClick={() => save.mutate(editing)}>Save plan</Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

export function AdminActivity() {
  const audit = useQuery({ queryKey: ["audit"], queryFn: async () => {
    const { data, error } = await supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(200);
    if (error) throw error;
    return data as { id: number; action: string; entity_type: string; details: Record<string, unknown>; created_at: string }[];
  } });
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: async () => {
    const { data, error } = await supabase.from("job_runs").select("*").order("started_at", { ascending: false }).limit(50);
    if (error) throw error;
    return data as { id: number; job_name: string; run_key: string; status: string; details: Record<string, unknown>; error: string | null; started_at: string }[];
  } });
  return (
    <div className="space-y-5">
      <PageHeader title="System activity" description="Scheduled job runs, errors and the audit trail." />
      <Card>
        <CardHeader><CardTitle>Scheduled jobs</CardTitle></CardHeader>
        {jobs.isLoading ? <CardContent><LoadingState rows={2} /></CardContent> : (
          <Table>
            <THead><TR><TH>Started</TH><TH>Job</TH><TH>Run</TH><TH>Status</TH><TH>Result</TH></TR></THead>
            <TBody>
              {jobs.data?.map((j) => (
                <TR key={j.id}>
                  <TD className="text-xs">{formatDateTime(j.started_at)}</TD><TD>{j.job_name}</TD><TD className="font-mono text-xs">{j.run_key}</TD>
                  <TD><Badge variant={j.status === "succeeded" ? "success" : j.status === "failed" ? "danger" : "warning"}>{j.status}</Badge></TD>
                  <TD className="max-w-md truncate text-xs">{j.error ?? JSON.stringify(j.details)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader><CardTitle>Audit log</CardTitle></CardHeader>
        {audit.isLoading ? <CardContent><LoadingState rows={3} /></CardContent> : (
          <Table>
            <THead><TR><TH>When</TH><TH>Action</TH><TH>Entity</TH><TH>Details</TH></TR></THead>
            <TBody>
              {audit.data?.map((a) => (
                <TR key={a.id}>
                  <TD className="text-xs">{formatDateTime(a.created_at)}</TD><TD className="font-medium">{a.action}</TD><TD>{a.entity_type}</TD>
                  <TD className="max-w-md truncate font-mono text-xs">{JSON.stringify(a.details)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
