import { QRCodeSVG } from "qrcode.react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Check, Copy, Home, Inbox, QrCode, Search, Store, UserPlus, Users, X } from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useCanManage, useSupplier } from "@/auth/AuthProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { LevelPill } from "@/components/water/StockGauge";
import { formatDate, formatMoney } from "@/lib/format";
import { householdLabel } from "@/lib/household";
import { useAction } from "@/lib/hooks";
import { openExternal, siteUrl } from "@/lib/native";
import { rpc, supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import type { AccountType, ConnectionRequest, SupplierInvite } from "@/types/db";
import { useCustomerList } from "./dialogs";

export function InviteDialog({ onClose }: { onClose: () => void }) {
  const supplier = useSupplier();
  const [invite, setInvite] = React.useState<SupplierInvite | null>(null);
  const create = useAction(() => rpc<SupplierInvite>("create_supplier_invite", { p_label: "Shared link", p_expires_in_days: 30 }), { onSuccess: setInvite });
  const codeUrl = `${siteUrl()}/join?code=${supplier.business_code}`;
  const url = invite ? `${siteUrl()}/join/${invite.token}` : codeUrl;
  const copy = async (s: string) => { await navigator.clipboard.writeText(s); toast.success("Copied"); };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Invite customers" description="Customers can only connect with your code, invite link or QR code.">
        <div className="flex flex-col items-center gap-4">
          <div className="rounded-2xl border bg-white p-4"><QRCodeSVG value={url} size={180} fgColor="#0b5cad" /></div>
          <div className="w-full rounded-xl bg-secondary p-3 text-center">
            <p className="text-xs text-muted-foreground">Supplier code</p>
            <p className="text-2xl font-extrabold tracking-[0.3em] text-primary">{supplier.business_code}</p>
          </div>
          <div className="flex w-full gap-2">
            <Input readOnly value={url} aria-label="Invite link" />
            <Button variant="outline" size="icon" onClick={() => copy(url)} aria-label="Copy link"><Copy /></Button>
          </div>
          {!invite && <Button variant="outline" className="w-full" loading={create.isPending} onClick={() => create.mutate(undefined)}>Create a private 30-day invite link</Button>}
          {invite && <p className="text-xs text-muted-foreground">Private link expires {formatDate(invite.expires_at)}.</p>}
          <Button className="w-full" onClick={() => openExternal(`https://wa.me/?text=${encodeURIComponent(`Order water from ${supplier.business_name} on Waterdrop: ${url}`)}`)}>
            Share on WhatsApp
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddCustomerDialog({ onClose }: { onClose: () => void }) {
  const [f, setF] = React.useState({ name: "", phone: "", address: "", instructions: "", price: "", daily: "2", opening: "", balance: "0" });
  const save = useAction(() => rpc("supplier_add_customer", {
    p_customer_name: f.name, p_phone: f.phone || null, p_address: f.address, p_delivery_instructions: f.instructions || null,
    p_can_price: f.price === "" ? null : Number(f.price), p_daily_consumption: Number(f.daily) || 0,
    p_opening_stock: f.opening === "" ? null : Number(f.opening), p_opening_balance: Number(f.balance) || 0,
  }), { success: "Customer added", invalidate: [["supplier-customers"]], onSuccess: onClose });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Add customer without app" description="For customers who don't use Waterdrop. You'll confirm their deliveries on their behalf.">
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
          <Field label="Name" htmlFor="n"><Input id="n" required minLength={2} value={f.name} onChange={set("name")} /></Field>
          <Field label="Mobile" htmlFor="p"><Input id="p" type="tel" pattern="\+?[0-9 ]{7,16}" value={f.phone} onChange={set("phone")} /></Field>
          <Field label="Address" htmlFor="a" className="sm:col-span-2"><Textarea id="a" required minLength={3} value={f.address} onChange={set("address")} /></Field>
          <Field label="Delivery instructions" htmlFor="i" className="sm:col-span-2"><Input id="i" value={f.instructions} onChange={set("instructions")} /></Field>
          <Field label="Custom price/can (₹)" htmlFor="pr" hint="Blank = your default"><Input id="pr" type="number" min={0} step="0.5" value={f.price} onChange={set("price")} /></Field>
          <Field label="Cans per day" htmlFor="d"><Input id="d" type="number" min={0} value={f.daily} onChange={set("daily")} /></Field>
          <Field label="Current cans (opening stock)" htmlFor="o"><Input id="o" type="number" min={0} value={f.opening} onChange={set("opening")} /></Field>
          <Field label="Opening balance (₹)" htmlFor="b" hint="Amount already owed"><Input id="b" type="number" step="0.01" value={f.balance} onChange={set("balance")} /></Field>
          <Button type="submit" className="sm:col-span-2" loading={save.isPending}>Add customer</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const TYPE_ICON: Record<AccountType, typeof Home> = { home: Home, store: Store, company: Building2 };
const TYPE_LABEL: Record<AccountType, string> = { home: "Home", store: "Store", company: "Company" };

export function useConnectionRequests() {
  const supplier = useSupplier();
  return useQuery({
    queryKey: ["connection-requests", supplier.id],
    queryFn: async () => {
      const { data, error } = await supabase.from("supplier_connection_requests").select("*, customer_accounts(name, account_type)")
        .eq("supplier_id", supplier.id).eq("status", "pending").order("created_at");
      if (error) throw error;
      return data as ConnectionRequest[];
    },
    refetchInterval: 60_000,
  });
}

function RequestCard({ r, canManage }: { r: ConnectionRequest; canManage: boolean }) {
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const decide = useAction((approve: boolean) => rpc("decide_connection_request", { p_request_id: r.id, p_approve: approve, p_reason: approve ? null : reason || null }), {
    success: "Done", invalidate: [["connection-requests"], ["supplier-customers"]],
  });
  const type = r.customer_accounts?.account_type ?? "home";
  const Icon = TYPE_ICON[type];
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <Icon className="h-10 w-10 shrink-0 rounded-xl bg-secondary p-2 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{r.customer_accounts?.name ?? r.contact_name}{r.branch_name ? ` · ${r.branch_name}` : ""}</p>
            <p className="text-xs text-muted-foreground">{TYPE_LABEL[type]} · {r.contact_name}{r.phone ? ` · ${r.phone}` : ""}</p>
            <p className="text-sm">{r.address}</p>
            {r.delivery_instructions && <p className="text-xs text-muted-foreground">Note: {r.delivery_instructions}</p>}
            <p className="text-xs text-muted-foreground">
              {r.household_type ? `${householdLabel(r.household_type)} · ` : ""}{r.members_count ? `${r.members_count} people · ` : ""}
              about {r.daily_consumption} can{r.daily_consumption === 1 ? "" : "s"}/day · requested {formatDate(r.created_at)}
            </p>
          </div>
        </div>
        {canManage ? (rejecting ? (
          <div className="flex gap-2">
            <Input aria-label="Reason" placeholder="Reason, e.g. outside our delivery area" value={reason} onChange={(e) => setReason(e.target.value)} />
            <Button variant="destructive" disabled={reason.trim().length < 3} loading={decide.isPending} onClick={() => decide.mutate(false)}>Decline</Button>
            <Button variant="ghost" onClick={() => setRejecting(false)}>Back</Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => setRejecting(true)}><X /> Decline</Button>
            <Button variant="success" loading={decide.isPending} onClick={() => decide.mutate(true)}><Check /> Accept</Button>
          </div>
        )) : <p className="text-xs text-muted-foreground">An owner or manager can accept this request.</p>}
      </CardContent>
    </Card>
  );
}

export default function Customers() {
  const { data, isLoading, error, refetch } = useCustomerList();
  const canManage = useCanManage();
  const [q, setQ] = React.useState("");
  const [dialog, setDialog] = React.useState<"invite" | "add" | null>(null);
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "requests" ? "requests" : "list";
  const requests = useConnectionRequests();
  const pending = requests.data?.length ?? 0;
  const filtered = (data ?? []).filter((c) => `${c.customer_name} ${c.account_name ?? ""} ${c.branch_name ?? ""} ${c.phone ?? ""} ${c.address}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <PageHeader title="Customers" description={`${data?.length ?? 0} customers`}
        actions={<>{canManage && <Button variant="outline" onClick={() => setDialog("add")}><UserPlus /> Add offline customer</Button>}<Button onClick={() => setDialog("invite")}><QrCode /> Invite customers</Button></>} />
      <div className="mb-4 inline-flex rounded-lg bg-muted p-1" role="tablist">
        {([["list", "Customers"], ["requests", "Requests"]] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setParams(k === "list" ? {} : { tab: k })}
            className={cn("flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-medium", tab === k ? "bg-card shadow-sm" : "text-muted-foreground")}>
            {label}{k === "requests" && pending > 0 && <span className="rounded-full bg-primary px-1.5 text-xs text-white">{pending}</span>}
          </button>
        ))}
      </div>
      {tab === "requests" ? (
        requests.isLoading ? <LoadingState /> : requests.error ? <ErrorState error={requests.error} onRetry={requests.refetch} /> : !pending ? (
          <EmptyState icon={Inbox} title="No new requests" description="Customers who find you in the Waterdrop search appear here for you to accept." />
        ) : <div className="grid gap-3 md:grid-cols-2">{requests.data!.map((r) => <RequestCard key={r.id} r={r} canManage={canManage} />)}</div>
      ) : <>
      <div className="relative mb-4 max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label="Search customers" placeholder="Search name, phone, address" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {isLoading ? <LoadingState /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? (
        <EmptyState icon={Users} title="No customers yet" description="Share your supplier code or QR code so customers can connect." action={<Button onClick={() => setDialog("invite")}>Invite customers</Button>} />
      ) : (
        <Card>
          <Table>
            <THead><TR><TH>Customer</TH><TH>Stock</TH><TH>Runs out</TH><TH>Use/day</TH>{canManage && <><TH>Price</TH><TH className="text-right">Balance</TH></>}</TR></THead>
            <TBody>
              {filtered.map((c) => (
                <TR key={c.id}>
                  <TD>
                    <Link to={`/supplier/customers/${c.id}`} className="font-medium text-primary hover:underline">{c.account_name && c.account_type !== "home" ? c.account_name : c.customer_name}</Link>
                    {(c.branch_name || (c.account_type && c.account_type !== "home")) && (
                      <div className="text-xs font-medium">{c.account_type ? TYPE_LABEL[c.account_type] : ""}{c.branch_name ? ` · ${c.branch_name}` : ""}{c.bill_to_customer_id ? " · combined bill" : ""}</div>
                    )}
                    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">{c.phone ?? "—"} {!c.has_app && <Badge variant="muted">offline</Badge>} {c.status === "inactive" && <Badge variant="muted">inactive</Badge>} {c.blocked && <Badge variant="danger">blocked</Badge>}</div>
                    {(c.household_type || c.members_count) && <div className="text-xs text-muted-foreground">{householdLabel(c.household_type)}{c.members_count ? ` · ${c.members_count} members` : ""}</div>}
                  </TD>
                  <TD><div className="flex items-center gap-2"><b className="tabular-nums">{c.stock_confirmed ? c.current_stock : "?"}</b><LevelPill level={c.level} /></div></TD>
                  <TD>{formatDate(c.predicted_empty_date, "d MMM")}</TD>
                  <TD>{c.daily_consumption}</TD>
                  {canManage && <>
                    <TD>{formatMoney(c.can_price)}</TD>
                    <TD className={`text-right font-semibold ${Number(c.balance) > 0 ? "text-amber-700" : ""}`}>{c.balance == null ? <span className="text-xs font-normal text-muted-foreground">on head bill</span> : formatMoney(c.balance)}</TD>
                  </>}
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      </>}
      {dialog === "invite" && <InviteDialog onClose={() => setDialog(null)} />}
      {dialog === "add" && <AddCustomerDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
