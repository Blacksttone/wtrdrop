import { QRCodeSVG } from "qrcode.react";
import { Copy, QrCode, Search, UserPlus, Users } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useSupplier } from "@/auth/AuthProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { LevelPill } from "@/components/water/StockGauge";
import { formatDate, formatMoney } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { rpc } from "@/lib/supabase";
import type { SupplierInvite } from "@/types/db";
import { useCustomerList } from "./dialogs";

export function InviteDialog({ onClose }: { onClose: () => void }) {
  const supplier = useSupplier();
  const [invite, setInvite] = React.useState<SupplierInvite | null>(null);
  const create = useAction(() => rpc<SupplierInvite>("create_supplier_invite", { p_label: "Shared link", p_expires_in_days: 30 }), { onSuccess: setInvite });
  const codeUrl = `${window.location.origin}/join?code=${supplier.business_code}`;
  const url = invite ? `${window.location.origin}/join/${invite.token}` : codeUrl;
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
          <Button className="w-full" asChild>
            <a href={`https://wa.me/?text=${encodeURIComponent(`Order water from ${supplier.business_name} on Waterdrop: ${url}`)}`} target="_blank" rel="noreferrer">Share on WhatsApp</a>
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

export default function Customers() {
  const { data, isLoading, error, refetch } = useCustomerList();
  const [q, setQ] = React.useState("");
  const [dialog, setDialog] = React.useState<"invite" | "add" | null>(null);
  const filtered = (data ?? []).filter((c) => `${c.customer_name} ${c.phone ?? ""} ${c.address}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <PageHeader title="Customers" description={`${data?.length ?? 0} customers`}
        actions={<><Button variant="outline" onClick={() => setDialog("add")}><UserPlus /> Add offline customer</Button><Button onClick={() => setDialog("invite")}><QrCode /> Invite customers</Button></>} />
      <div className="relative mb-4 max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label="Search customers" placeholder="Search name, phone, address" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {isLoading ? <LoadingState /> : error ? <ErrorState error={error} onRetry={refetch} /> : !data?.length ? (
        <EmptyState icon={Users} title="No customers yet" description="Share your supplier code or QR code so customers can connect." action={<Button onClick={() => setDialog("invite")}>Invite customers</Button>} />
      ) : (
        <Card>
          <Table>
            <THead><TR><TH>Customer</TH><TH>Stock</TH><TH>Runs out</TH><TH>Use/day</TH><TH>Price</TH><TH className="text-right">Balance</TH></TR></THead>
            <TBody>
              {filtered.map((c) => (
                <TR key={c.id}>
                  <TD>
                    <Link to={`/supplier/customers/${c.id}`} className="font-medium text-primary hover:underline">{c.customer_name}</Link>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">{c.phone ?? "—"} {!c.has_app && <Badge variant="muted">offline</Badge>} {c.status === "inactive" && <Badge variant="muted">inactive</Badge>}</div>
                  </TD>
                  <TD><div className="flex items-center gap-2"><b className="tabular-nums">{c.stock_confirmed ? c.current_stock : "?"}</b><LevelPill level={c.level} /></div></TD>
                  <TD>{formatDate(c.predicted_empty_date, "d MMM")}</TD>
                  <TD>{c.daily_consumption}</TD>
                  <TD>{formatMoney(c.can_price)}</TD>
                  <TD className={`text-right font-semibold ${Number(c.balance) > 0 ? "text-amber-700" : ""}`}>{formatMoney(c.balance)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      {dialog === "invite" && <InviteDialog onClose={() => setDialog(null)} />}
      {dialog === "add" && <AddCustomerDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
