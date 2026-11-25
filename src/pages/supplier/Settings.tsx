import { useQuery, useQueryClient } from "@tanstack/react-query";
import { QrCode, Upload } from "lucide-react";
import * as React from "react";
import { useAuth, useSupplier } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Switch, Textarea } from "@/components/ui/input";
import { ErrorState, LoadingState, PageHeader } from "@/components/ui/states";
import { formatDate } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { useSupplierSettings } from "@/lib/queries";
import { supabase } from "@/lib/supabase";
import type { SupplierInvite, SupplierSettings } from "@/types/db";
import { uploadLogo } from "../public/Onboarding";
import { InviteDialog } from "./Customers";

function BusinessCard() {
  const supplier = useSupplier();
  const { session, refresh } = useAuth();
  const [f, setF] = React.useState({
    business_name: supplier.business_name, owner_name: supplier.owner_name, phone: supplier.phone, email: supplier.email ?? "",
    address: supplier.address, delivery_area: supplier.delivery_area ?? "", ...supplier.billing_info,
  } as Record<string, string>);
  const [logo, setLogo] = React.useState<File | null>(null);
  const save = useAction(async () => {
    const logo_url = logo && session ? await uploadLogo(logo, session.user.id) : supplier.logo_url;
    const billing_info = Object.fromEntries(["gstin", "upi_id", "bank_name", "account_number", "ifsc"].map((k) => [k, (f[k] ?? "").trim()]).filter(([, v]) => v));
    const { error } = await supabase.from("suppliers").update({
      business_name: f.business_name, owner_name: f.owner_name, phone: f.phone, email: f.email || null, address: f.address,
      delivery_area: f.delivery_area || null, billing_info, logo_url,
    }).eq("id", supplier.id);
    if (error) throw error;
  }, { success: "Business details saved", onSuccess: () => refresh() });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Card>
      <CardHeader><CardTitle>Business profile</CardTitle><CardDescription>Supplier code <b className="tracking-widest text-primary">{supplier.business_code}</b> · Status {supplier.status}</CardDescription></CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <Field label="Business name" htmlFor="bn"><Input id="bn" value={f.business_name} onChange={set("business_name")} /></Field>
        <Field label="Owner name" htmlFor="on"><Input id="on" value={f.owner_name} onChange={set("owner_name")} /></Field>
        <Field label="Mobile" htmlFor="ph"><Input id="ph" value={f.phone} onChange={set("phone")} /></Field>
        <Field label="Email" htmlFor="em"><Input id="em" value={f.email} onChange={set("email")} /></Field>
        <Field label="Address" htmlFor="ad" className="sm:col-span-2"><Textarea id="ad" value={f.address} onChange={set("address")} /></Field>
        <Field label="Delivery area" htmlFor="da" className="sm:col-span-2"><Input id="da" value={f.delivery_area} onChange={set("delivery_area")} /></Field>
        <Field label="UPI ID" htmlFor="upi"><Input id="upi" value={f.upi_id ?? ""} onChange={set("upi_id")} /></Field>
        <Field label="GSTIN" htmlFor="gst"><Input id="gst" value={f.gstin ?? ""} onChange={set("gstin")} /></Field>
        <Field label="Bank name" htmlFor="bk"><Input id="bk" value={f.bank_name ?? ""} onChange={set("bank_name")} /></Field>
        <Field label="Account number" htmlFor="ac"><Input id="ac" value={f.account_number ?? ""} onChange={set("account_number")} /></Field>
        <Field label="IFSC" htmlFor="ifsc"><Input id="ifsc" value={f.ifsc ?? ""} onChange={set("ifsc")} /></Field>
        <Field label="Logo" htmlFor="lg">
          <label htmlFor="lg" className="flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-dashed px-3 text-sm hover:bg-secondary">
            {supplier.logo_url && !logo ? <img src={supplier.logo_url} alt="" className="h-6 w-6 rounded object-cover" /> : <Upload className="h-4 w-4" />} {logo?.name ?? "Change logo"}
          </label>
          <input id="lg" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="sr-only" onChange={(e) => setLogo(e.target.files?.[0] ?? null)} />
        </Field>
        <Button className="sm:col-span-2" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save business profile</Button>
      </CardContent>
    </Card>
  );
}

function OperationsCard({ settings }: { settings: SupplierSettings }) {
  const qc = useQueryClient();
  const [f, setF] = React.useState({ ...settings });
  const save = useAction(async () => {
    if (f.default_critical_threshold > f.default_low_stock_threshold) throw new Error("Critical threshold must be at or below the low threshold");
    const { error } = await supabase.from("supplier_settings").update({
      default_can_price: Number(f.default_can_price), delivery_lead_days: Number(f.delivery_lead_days), billing_day: Number(f.billing_day),
      billing_due_days: Number(f.billing_due_days), tax_rate: Number(f.tax_rate), tax_label: f.tax_label, invoice_prefix: f.invoice_prefix.toUpperCase(),
      bulk_order_threshold: Number(f.bulk_order_threshold), default_low_stock_threshold: Number(f.default_low_stock_threshold),
      default_critical_threshold: Number(f.default_critical_threshold), default_safety_stock: Number(f.default_safety_stock),
      notification_settings: f.notification_settings,
    }).eq("id", settings.id);
    if (error) throw error;
  }, { success: "Settings saved", onSuccess: () => qc.invalidateQueries() });
  const num = (k: keyof SupplierSettings) => ({ value: String(f[k] ?? ""), onChange: (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value }) });
  const notif = f.notification_settings ?? {};
  return (
    <Card>
      <CardHeader><CardTitle>Pricing, delivery & billing</CardTitle><CardDescription>Price changes apply to new deliveries; recorded deliveries keep the price they were delivered at.</CardDescription></CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3">
        <Field label="Default price/can (₹)" htmlFor="p"><Input id="p" type="number" min={0} step="0.5" {...num("default_can_price")} /></Field>
        <Field label="Delivery lead time (days)" htmlFor="l"><Input id="l" type="number" min={0} max={30} {...num("delivery_lead_days")} /></Field>
        <Field label="Bulk order from (cans)" htmlFor="b"><Input id="b" type="number" min={2} {...num("bulk_order_threshold")} /></Field>
        <Field label="Billing day (1–28)" htmlFor="bd" hint="Bills for the previous cycle are generated on this day"><Input id="bd" type="number" min={1} max={28} {...num("billing_day")} /></Field>
        <Field label="Payment due after (days)" htmlFor="dd"><Input id="dd" type="number" min={0} max={90} {...num("billing_due_days")} /></Field>
        <Field label="Invoice prefix" htmlFor="ip"><Input id="ip" maxLength={8} {...num("invoice_prefix")} /></Field>
        <Field label="Tax rate (%)" htmlFor="tr"><Input id="tr" type="number" min={0} max={50} step="0.01" {...num("tax_rate")} /></Field>
        <Field label="Tax label" htmlFor="tl"><Input id="tl" {...num("tax_label")} /></Field>
        <div />
        <Field label="Default low-stock alert" htmlFor="lo"><Input id="lo" type="number" min={0} {...num("default_low_stock_threshold")} /></Field>
        <Field label="Default critical alert" htmlFor="cr"><Input id="cr" type="number" min={0} {...num("default_critical_threshold")} /></Field>
        <Field label="Default safety stock" htmlFor="ss"><Input id="ss" type="number" min={0} {...num("default_safety_stock")} /></Field>
        <div className="space-y-3 sm:col-span-3">
          {([["notify_new_orders", "Notify me about new orders"], ["notify_shortages", "Notify me when customers report shortages"], ["notify_critical_customers", "Notify me when a customer is critically low"]] as const).map(([k, label]) => (
            <div key={k} className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
              <span className="text-sm">{label}</span>
              <Switch id={k} label={label} checked={notif[k] !== false} onChange={(v) => setF({ ...f, notification_settings: { ...notif, [k]: v } })} />
            </div>
          ))}
        </div>
        <Button className="sm:col-span-3" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save settings</Button>
      </CardContent>
    </Card>
  );
}

function InvitesCard() {
  const supplier = useSupplier();
  const [show, setShow] = React.useState(false);
  const invites = useQuery({ queryKey: ["invites", supplier.id], queryFn: async () => {
    const { data, error } = await supabase.from("supplier_invites").select("*").eq("supplier_id", supplier.id).order("created_at", { ascending: false });
    if (error) throw error;
    return data as SupplierInvite[];
  } });
  const revoke = useAction(async (id: string) => {
    const { error } = await supabase.from("supplier_invites").update({ revoked_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
  }, { success: "Invite revoked", invalidate: [["invites"]] });
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0"><CardTitle>Invitation links</CardTitle><Button size="sm" onClick={() => setShow(true)}><QrCode /> Show QR / create link</Button></CardHeader>
      <CardContent>
        {!invites.data?.length ? <p className="text-sm text-muted-foreground">No private links yet. Customers can always join with your supplier code.</p> : (
          <ul className="divide-y text-sm">
            {invites.data.map((i) => (
              <li key={i.id} className="flex items-center justify-between py-2">
                <span>…{i.token.slice(-6)} · used {i.uses}{i.max_uses ? `/${i.max_uses}` : ""} · {i.revoked_at ? "revoked" : i.expires_at ? `expires ${formatDate(i.expires_at)}` : "no expiry"}</span>
                {!i.revoked_at && <Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}>Revoke</Button>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {show && <InviteDialog onClose={() => { setShow(false); invites.refetch(); }} />}
    </Card>
  );
}

export default function SupplierSettingsPage() {
  const supplier = useSupplier();
  const s = useSupplierSettings(supplier.id);
  return (
    <div className="space-y-5">
      <PageHeader title="Business settings" />
      <BusinessCard />
      {s.isLoading ? <LoadingState rows={2} /> : s.error || !s.data ? <ErrorState error={s.error} onRetry={s.refetch} /> : <OperationsCard settings={s.data} />}
      <InvitesCard />
    </div>
  );
}
