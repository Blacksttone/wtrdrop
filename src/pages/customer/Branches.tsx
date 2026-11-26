import { useQueries, useQuery } from "@tanstack/react-query";
import { Building2, Home, MapPin, Plus, Receipt, Store } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { ACCOUNT_TYPES, branchLabel, useAuth } from "@/auth/AuthProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/states";
import { LevelPill } from "@/components/water/StockGauge";
import { rpc, supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import type { AccountType, CustomerSummary } from "@/types/db";
import { PendingRequests } from "@/pages/public/CustomerOnboarding";

const ICON: Record<AccountType, typeof Home> = { home: Home, store: Store, company: Building2 };

/** All branches (homes / store branches / company branches) the user can access, grouped by account. */
export default function Branches() {
  const { customers, accounts, memberships, activeCustomer, setActiveCustomerId } = useAuth();
  const navigate = useNavigate();
  const supplierIds = [...new Set(customers.map((c) => c.supplier_id))];
  const suppliers = useQuery({
    queryKey: ["branch-suppliers", supplierIds.join(",")],
    enabled: supplierIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.from("suppliers").select("id, business_name").in("id", supplierIds);
      if (error) throw error;
      return Object.fromEntries((data ?? []).map((s) => [s.id, s.business_name as string]));
    },
  });
  const summaries = useQueries({
    queries: customers.map((c) => ({
      queryKey: ["summary", c.id],
      queryFn: () => rpc<CustomerSummary>("get_customer_summary", { p_customer_id: c.id }),
    })),
  });
  const summaryOf = (id: string) => summaries[customers.findIndex((c) => c.id === id)]?.data;

  const groups = [
    ...accounts.map((a) => ({ account: a, branches: customers.filter((c) => c.account_id === a.id) })),
    { account: null, branches: customers.filter((c) => !c.account_id) },
  ].filter((g) => g.account || g.branches.length);

  return (
    <div className="space-y-5">
      <PageHeader title="Branches & homes" description="Every place you get water for. Tap one to switch to it." />
      <PendingRequests />
      {groups.map(({ account, branches }) => {
        const role = account ? memberships.find((m) => m.account_id === account.id && m.status === "active")?.role : "owner";
        const canAdd = role === "owner" || role === "admin";
        const meta = account ? ACCOUNT_TYPES[account.account_type] : ACCOUNT_TYPES.home;
        const Icon = account ? ICON[account.account_type] : Home;
        return (
          <Card key={account?.id ?? "none"}>
            <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
              <div className="flex min-w-0 items-center gap-3">
                <Icon className="h-10 w-10 shrink-0 rounded-xl bg-secondary p-2 text-primary" />
                <div className="min-w-0">
                  <CardTitle className="truncate">{account?.name ?? "My connections"}</CardTitle>
                  <CardDescription>{meta.label} · {branches.length} {branches.length === 1 ? meta.branchWord : `${meta.branchWord}${meta.branchWord.endsWith("h") ? "es" : "s"}`}{role ? ` · you are ${role}` : ""}</CardDescription>
                </div>
              </div>
              {account && canAdd && (
                <Button size="sm" variant="outline" asChild>
                  <Link to={`/onboarding/customer?add=1&account=${account.id}`}><Plus /> Add {meta.branchWord}</Link>
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {!branches.length ? (
                <p className="text-sm text-muted-foreground">No {meta.branchWord} connected yet. {canAdd && "Add one and choose its supplier."}</p>
              ) : (
                <ul className="space-y-2">
                  {branches.map((c) => {
                    const s = summaryOf(c.id);
                    const head = c.bill_to_customer_id ? customers.find((x) => x.id === c.bill_to_customer_id) : null;
                    const isHead = customers.some((x) => x.bill_to_customer_id === c.id);
                    return (
                      <li key={c.id}>
                        <button type="button" onClick={() => { setActiveCustomerId(c.id); navigate("/app"); }}
                          className={cn("flex w-full items-start gap-3 rounded-xl border-2 p-3 text-left transition-colors",
                            activeCustomer?.id === c.id ? "border-primary bg-secondary" : "border-border hover:border-primary/40")}>
                          <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold">{branchLabel(c)}</p>
                            <p className="truncate text-xs text-muted-foreground">{c.address}</p>
                            <p className="mt-1 text-xs">
                              Supplier: <b>{suppliers.data?.[c.supplier_id] ?? "…"}</b>
                            </p>
                            {(isHead || head) && (
                              <p className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                                <Receipt className="h-3 w-3" />
                                {isHead ? "Combined bill for all branches with this supplier" : `Billed together with ${branchLabel(head!)}`}
                              </p>
                            )}
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            {c.blocked_at ? <Badge variant="danger">Blocked</Badge> : s ? <LevelPill level={s.prediction.level} /> : null}
                            {s && <span className="text-sm font-bold">{s.prediction.current_stock} cans</span>}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        );
      })}
      <Button variant="outline" className="w-full" asChild>
        <Link to="/onboarding/customer?add=1&new=1"><Plus /> Add another home, store or company</Link>
      </Button>
    </div>
  );
}
