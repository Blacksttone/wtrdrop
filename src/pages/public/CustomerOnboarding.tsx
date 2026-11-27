import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, CheckCircle2, Clock, Home, KeyRound, Search, Store, Users } from "lucide-react";
import * as React from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ACCOUNT_TYPES, useAuth } from "@/auth/AuthProvider";
import { FullPageLoader } from "@/auth/guards";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { LocationPicker } from "@/components/water/LocationControls";
import { QrScanButton } from "@/components/water/QrScanButton";
import { StatusBadge } from "@/components/water/StatusBadge";
import { errorMessage } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { HOUSEHOLD_TYPES, suggestedDailyCans } from "@/lib/household";
import type { GeoPoint } from "@/lib/location";
import { parseSupplierQr } from "@/lib/qr";
import { rpc, supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import type { AccountType, ConnectionRequest, CustomerAccount } from "@/types/db";
import { clearInvite, readInvite, Shell } from "./Onboarding";

type SupplierHit = { supplier_id: string; business_name: string; delivery_area: string | null; address: string; logo_url: string | null };

const TYPE_CARDS: { value: AccountType; icon: typeof Home; title: string; sub: string; namePlaceholder: string }[] = [
  { value: "home", icon: Home, title: "Home", sub: "House or flat (veedu)", namePlaceholder: "e.g. Iyer family" },
  { value: "store", icon: Store, title: "Store", sub: "Shop, hotel, mess", namePlaceholder: "e.g. Raja Stores" },
  { value: "company", icon: Building2, title: "Company", sub: "Office, factory, branches", namePlaceholder: "e.g. Sri Tech Pvt Ltd" },
];

/** Pending supplier requests for the user's accounts (shown while waiting for approval). */
export function PendingRequests({ onlyIfAny = true }: { onlyIfAny?: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["my-connection-requests"],
    queryFn: async () => {
      const { data, error } = await supabase.from("supplier_connection_requests")
        .select("*, suppliers(business_name)").order("created_at", { ascending: false }).limit(20);
      if (error) throw error;
      return data as ConnectionRequest[];
    },
    refetchInterval: 30_000,
  });
  const rows = (q.data ?? []).filter((r) => r.status !== "cancelled");
  if (onlyIfAny && !rows.length) return null;
  return (
    <Card className="mb-6">
      <CardHeader><CardTitle>Your supplier requests</CardTitle><CardDescription>We'll notify you when the supplier answers.</CardDescription></CardHeader>
      <CardContent>
        <ul className="divide-y">
          {rows.map((r) => (
            <li key={r.id} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-medium">{r.suppliers?.business_name}</p>
                <p className="truncate text-xs text-muted-foreground">{r.branch_name ? `${r.branch_name} · ` : ""}{r.address}</p>
                <p className="text-xs text-muted-foreground">Sent {formatDate(r.created_at)}{r.reason ? ` · ${r.reason}` : ""}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                {r.status === "pending" ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700"><Clock className="h-3 w-3" /> Waiting</span>
                  : <StatusBadge status={r.status === "approved" ? "confirmed" : "rejected"} label={r.status === "approved" ? "Accepted" : "Declined"} />}
                {r.status === "pending" && (
                  <button className="text-xs text-primary underline" onClick={async () => {
                    try { await rpc("cancel_connection_request", { p_request_id: r.id }); qc.invalidateQueries({ queryKey: ["my-connection-requests"] }); }
                    catch (e) { toast.error(errorMessage(e)); }
                  }}>Cancel</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function CustomerOnboarding() {
  const { profile, customers, accounts, memberships, refresh, loadingProfile, setActiveCustomerId } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const pending = readInvite();
  const adding = params.get("add") === "1";
  const adminAccounts = accounts.filter((a) => memberships.some((m) => m.account_id === a.id && m.status === "active" && (m.role === "owner" || m.role === "admin")));

  const [accountId, setAccountId] = React.useState<string>(params.get("account") ?? "");
  const account: CustomerAccount | undefined = accounts.find((a) => a.id === accountId) ?? (adminAccounts.length === 1 && !params.get("new") ? adminAccounts[0] : undefined);
  const [mode, setMode] = React.useState<"choose" | "join">("choose");
  const [type, setType] = React.useState<AccountType>("home");
  const [accName, setAccName] = React.useState(profile?.full_name ?? "");
  const [creating, setCreating] = React.useState(false);
  const [joinCode, setJoinCode] = React.useState("");
  const [joining, setJoining] = React.useState(false);

  const [f, setF] = React.useState({ branch: "", name: profile?.full_name ?? "", phone: profile?.phone ?? "", address: "", instructions: "", opening: "", daily: "2", household: "", members: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const [tab, setTab] = React.useState<"search" | "code">(pending.token || pending.code || params.get("invite") || params.get("code") ? "code" : "search");
  const [query, setQuery] = React.useState("");
  const [picked, setPicked] = React.useState<SupplierHit | null>(null);
  const [token, setToken] = React.useState(params.get("invite") ?? pending.token ?? "");
  const [code, setCode] = React.useState(params.get("code") ?? pending.code ?? "");
  const [lookupCode, setLookupCode] = React.useState(token ? "" : code);
  const [submitting, setSubmitting] = React.useState(false);
  const [loc, setLoc] = React.useState<GeoPoint | null>(null);
  const [sent, setSent] = React.useState(false);

  const search = useQuery({
    queryKey: ["supplier-search", query],
    enabled: tab === "search" && Boolean(account),
    queryFn: () => rpc<SupplierHit[]>("search_suppliers", { p_query: query || null }),
  });
  const lookup = useQuery({
    queryKey: ["lookup-supplier", token, lookupCode],
    enabled: tab === "code" && Boolean(token || lookupCode.length >= 6),
    queryFn: () => rpc<SupplierHit[]>("lookup_supplier", { p_code: token ? null : lookupCode, p_invite_token: token || null }),
  });
  const codeSupplier = lookup.data?.[0];

  if (loadingProfile) return <FullPageLoader />;
  if (profile?.role !== "customer") return <Navigate to="/home" replace />;
  if (customers.length > 0 && !adding && !token && !params.get("code") && !sent) return <Navigate to="/app" replace />;

  const suggestion = suggestedDailyCans(Number(f.members) || 0);
  const branchLabel = account ? ACCOUNT_TYPES[account.account_type].branchWord : "home";
  const onScan = (text: string) => {
    const qr = parseSupplierQr(text);
    if (!qr) return toast.error("That QR code is not a Waterdrop supplier code.");
    if ("token" in qr) { setToken(qr.token); setCode(""); setLookupCode(""); } else { setToken(""); setCode(qr.code); setLookupCode(qr.code); }
    toast.success("QR code scanned");
  };

  async function createAccount(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const a = await rpc<CustomerAccount>("create_customer_account", { p_name: accName, p_type: type });
      await refresh();
      setAccountId(a.id);
      if (type === "home" && f.household === "") setF((x) => ({ ...x, household: "family" }));
      if (type !== "home") setF((x) => ({ ...x, branch: x.branch || "Main branch", household: type === "store" ? "shop" : "office" }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function joinAccount(e: React.FormEvent) {
    e.preventDefault();
    setJoining(true);
    try {
      await rpc("join_customer_account", { p_code: joinCode });
      await refresh();
      toast.success("You joined the account");
      navigate("/app", { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setJoining(false);
    }
  }

  const branchArgs = () => ({
    p_branch_name: f.branch || null, p_delivery_instructions: f.instructions || null, p_household_type: f.household || null,
    p_members_count: f.members === "" ? null : Number(f.members), p_opening_stock: f.opening === "" ? null : Number(f.opening),
    p_daily_consumption: Number(f.daily) || 0,
  });

  // Location is optional: a failure here never undoes the connection.
  async function saveLocation(fn: string, target: Record<string, string>) {
    try {
      await rpc(fn, { ...target, p_latitude: loc!.latitude, p_longitude: loc!.longitude, p_accuracy_m: loc!.accuracy == null ? null : Math.round(loc!.accuracy) });
    } catch (e) {
      toast.warning(`Connected, but the location was not saved: ${errorMessage(e)}`);
    }
  }

  async function submit() {
    if (!account) return;
    if (f.name.trim().length < 2 || f.address.trim().length < 3) return toast.error("Enter the contact name and delivery address");
    setSubmitting(true);
    try {
      if (tab === "search") {
        if (!picked) return toast.error("Choose a supplier from the list");
        const req = await rpc<{ id: string }>("request_supplier_connection", {
          p_account_id: account.id, p_supplier_id: picked.supplier_id, p_contact_name: f.name, p_phone: f.phone || null, p_address: f.address, ...branchArgs(),
        });
        if (loc) await saveLocation("set_request_location", { p_request_id: req.id });
        qc.invalidateQueries({ queryKey: ["my-connection-requests"] });
        setSent(true);
        toast.success(`Request sent to ${picked.business_name}`);
      } else {
        if (!codeSupplier) return toast.error("Enter or scan the supplier code first");
        const c = await rpc<{ id: string }>("connect_to_supplier", {
          p_customer_name: f.name, p_phone: f.phone || null, p_address: f.address, p_business_code: token ? null : lookupCode,
          p_invite_token: token || null, p_account_id: account.id, ...branchArgs(),
        });
        if (loc) await saveLocation("set_customer_location", { p_customer_id: c.id });
        clearInvite();
        await refresh();
        setActiveCustomerId(c.id);
        toast.success(`Connected to ${codeSupplier.business_name}`);
        navigate("/app", { replace: true });
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  // ---- Request sent: waiting screen
  if (sent) {
    return (
      <Shell step="Waiting for your supplier">
        <div className="mb-6 rounded-2xl bg-secondary p-5 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-stock-ok" />
          <h1 className="mt-2 text-xl font-bold">Request sent</h1>
          <p className="mt-1 text-sm text-muted-foreground">The supplier will review it. You'll get a notification when they accept.</p>
        </div>
        <PendingRequests onlyIfAny={false} />
        <div className="grid gap-2 sm:grid-cols-2">
          <Button variant="outline" onClick={() => { setSent(false); setPicked(null); }}>Request another supplier</Button>
          {customers.length > 0 && <Button onClick={() => navigate("/app")}>Go to the app</Button>}
        </div>
      </Shell>
    );
  }

  // ---- Step 1: account type (or join with a code)
  if (!account) {
    return (
      <Shell step="Step 1 of 3 · Who needs water?">
        <PendingRequests />
        {mode === "join" ? (
          <Card>
            <CardHeader><CardTitle>Join your family or team</CardTitle><CardDescription>Enter the 8-letter code the account owner shared with you.</CardDescription></CardHeader>
            <CardContent>
              <form onSubmit={joinAccount} className="flex gap-2">
                <Input aria-label="Family or team code" placeholder="CODE" className="uppercase tracking-widest" maxLength={8} autoCapitalize="characters"
                  value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} />
                <Button type="submit" disabled={joinCode.length !== 8} loading={joining}>Join</Button>
              </form>
              <Button variant="link" className="mt-2 px-0" onClick={() => setMode("choose")}>Create my own home, store or company instead</Button>
            </CardContent>
          </Card>
        ) : (
          <form onSubmit={createAccount} className="space-y-5">
            <div>
              <h1 className="text-2xl font-bold">Who are you ordering water for?</h1>
              <div className="mt-4 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Account type">
                {TYPE_CARDS.map((t) => (
                  <button key={t.value} type="button" role="radio" aria-checked={type === t.value} onClick={() => setType(t.value)}
                    className={cn("rounded-xl border-2 p-3 text-left transition-colors", type === t.value ? "border-primary bg-secondary" : "border-border bg-card hover:border-primary/40")}>
                    <t.icon className="h-6 w-6 text-primary" />
                    <p className="mt-1 font-semibold">{t.title}</p>
                    <p className="text-xs text-muted-foreground">{t.sub}</p>
                  </button>
                ))}
              </div>
            </div>
            <Field label={type === "home" ? "Family / home name" : type === "store" ? "Store name" : "Company name"} htmlFor="an">
              <Input id="an" required minLength={2} maxLength={120} value={accName} placeholder={TYPE_CARDS.find((t) => t.value === type)!.namePlaceholder} onChange={(e) => setAccName(e.target.value)} />
            </Field>
            <p className="text-xs text-muted-foreground">
              {type === "home" ? "You can add family members later so everyone can order and confirm deliveries." : "You can add branches and team members later. Each branch can have its own supplier, with one combined bill per supplier."}
            </p>
            <Button type="submit" size="lg" className="w-full" loading={creating}>Continue</Button>
            <button type="button" className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed p-3 text-sm font-medium text-primary hover:bg-secondary" onClick={() => setMode("join")}>
              <Users className="h-4 w-4" /> I have a family / team code
            </button>
          </form>
        )}
      </Shell>
    );
  }

  // ---- Steps 2 & 3: branch details + supplier
  return (
    <Shell step={`${account.name} · ${adding ? `Add a ${branchLabel}` : "Steps 2–3 of 3"}`}>
      {adminAccounts.length > 1 && (
        <Field label="Account" htmlFor="acct" className="mb-4">
          <Select id="acct" value={account.id} onChange={(e) => setAccountId(e.target.value)}>
            {adminAccounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({ACCOUNT_TYPES[a.account_type].label})</option>)}
          </Select>
        </Field>
      )}
      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle>Delivery details</CardTitle><CardDescription>Where should water be delivered?</CardDescription></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {account.account_type !== "home" && (
              <Field label="Branch name" htmlFor="bn" className="sm:col-span-2"><Input id="bn" maxLength={80} value={f.branch} placeholder="e.g. Anna Nagar branch" onChange={set("branch")} /></Field>
            )}
            <Field label="Contact person" htmlFor="n"><Input id="n" required minLength={2} value={f.name} onChange={set("name")} /></Field>
            <Field label="Mobile number" htmlFor="p"><Input id="p" type="tel" pattern="\+?[0-9 ]{7,16}" value={f.phone} onChange={set("phone")} /></Field>
            <Field label="Delivery address" htmlFor="a" className="sm:col-span-2"><Textarea id="a" required minLength={3} value={f.address} onChange={set("address")} /></Field>
            <Field label="Delivery instructions (optional)" htmlFor="i" className="sm:col-span-2"><Input id="i" placeholder="e.g. 2nd floor, ring the bell" value={f.instructions} onChange={set("instructions")} /></Field>
            <div className="sm:col-span-2">
              <LocationPicker value={loc} onChange={setLoc} label="Use my current location"
                hint="Optional. Tap this only while you are at the delivery address, so the delivery person can find you on Maps." />
            </div>
            <Field label={account.account_type === "home" ? "Who lives here?" : "Type of place"} htmlFor="ht">
              <Select id="ht" value={f.household} onChange={set("household")}>
                <option value="">Select…</option>
                {HOUSEHOLD_TYPES.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
              </Select>
            </Field>
            <Field label={account.account_type === "home" ? "Number of members" : "People using water here"} htmlFor="mc">
              <Input id="mc" type="number" inputMode="numeric" min={1} max={500} value={f.members}
                onChange={(e) => { const m = e.target.value; setF({ ...f, members: m, daily: m && Number(m) > 0 ? String(suggestedDailyCans(Number(m))) : f.daily }); }} />
            </Field>
            <Field label="Full cans you have now" htmlFor="o" hint="Leave blank if unsure"><Input id="o" type="number" min={0} max={1000} value={f.opening} onChange={set("opening")} /></Field>
            <Field label="Cans used per day" htmlFor="d" hint={suggestion ? `About ${suggestion} for ${f.members} people` : undefined}><Input id="d" type="number" min={0} max={1000} value={f.daily} onChange={set("daily")} /></Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Choose your water supplier</CardTitle></CardHeader>
          <CardContent>
            <div className="mb-4 inline-flex w-full rounded-lg bg-muted p-1" role="tablist">
              {([["search", Search, "Search suppliers"], ["code", KeyRound, "Code / QR"]] as const).map(([k, Icon, label]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                  className={cn("flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium", tab === k ? "bg-card shadow-sm" : "text-muted-foreground")}>
                  <Icon className="h-4 w-4" /> {label}
                </button>
              ))}
            </div>
            {tab === "search" ? (
              <div className="space-y-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input aria-label="Search suppliers" className="pl-9" placeholder="Area or supplier name, e.g. Anna Nagar" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                {search.isLoading ? <p className="text-sm text-muted-foreground">Searching…</p> : !search.data?.length ? (
                  <p className="text-sm text-muted-foreground">No suppliers found. Try another area, or use the Code / QR tab.</p>
                ) : (
                  <ul className="max-h-72 space-y-2 overflow-y-auto" role="listbox" aria-label="Suppliers">
                    {search.data.map((s) => (
                      <li key={s.supplier_id}>
                        <button type="button" role="option" aria-selected={picked?.supplier_id === s.supplier_id} onClick={() => setPicked(s)}
                          className={cn("flex w-full items-center gap-3 rounded-xl border-2 p-3 text-left", picked?.supplier_id === s.supplier_id ? "border-primary bg-secondary" : "border-border hover:border-primary/40")}>
                          {s.logo_url ? <img src={s.logo_url} alt="" className="h-10 w-10 rounded-lg object-cover" /> : <Store className="h-10 w-10 rounded-lg bg-secondary p-2 text-primary" />}
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold">{s.business_name}</p>
                            <p className="truncate text-xs text-muted-foreground">{s.delivery_area ?? s.address}</p>
                          </div>
                          {picked?.supplier_id === s.supplier_id && <CheckCircle2 className="h-5 w-5 text-primary" />}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground">The supplier must accept your request before deliveries start.</p>
              </div>
            ) : (
              <div className="space-y-3">
                <QrScanButton onResult={onScan} label="Scan supplier QR code" />
                {token ? (
                  <p className="text-sm text-muted-foreground">Using invitation link. <button type="button" className="text-primary underline" onClick={() => setToken("")}>Use a code instead</button></p>
                ) : (
                  <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setLookupCode(code.trim().toUpperCase()); }}>
                    <Input aria-label="Supplier code" placeholder="SUPPLIER CODE" className="uppercase tracking-widest" maxLength={10} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
                    <Button type="submit" variant="secondary">Find</Button>
                  </form>
                )}
                {lookup.isSuccess && !codeSupplier && <p className="text-sm font-medium text-destructive">No active supplier found for that code.</p>}
                {codeSupplier && (
                  <div className="flex items-center gap-3 rounded-xl bg-secondary p-3">
                    <Store className="h-10 w-10 rounded-lg bg-white p-2 text-primary" />
                    <div className="min-w-0"><p className="font-semibold">{codeSupplier.business_name}</p><p className="truncate text-xs text-muted-foreground">{codeSupplier.delivery_area ?? codeSupplier.address}</p></div>
                    <CheckCircle2 className="ml-auto h-5 w-5 text-stock-ok" />
                  </div>
                )}
                <p className="text-xs text-muted-foreground">With the supplier's code or QR you are connected immediately.</p>
              </div>
            )}
          </CardContent>
        </Card>
        <Button size="lg" className="w-full" loading={submitting} onClick={submit}
          disabled={tab === "search" ? !picked : !codeSupplier}>
          {tab === "search" ? (picked ? `Send request to ${picked.business_name}` : "Choose a supplier") : codeSupplier ? `Connect to ${codeSupplier.business_name}` : "Enter supplier code"}
        </Button>
        {adding && <Button variant="ghost" className="w-full" onClick={() => navigate(-1)}>Cancel</Button>}
      </div>
    </Shell>
  );
}
