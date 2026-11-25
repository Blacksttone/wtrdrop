import { useQueryClient } from "@tanstack/react-query";
import { LogOut, Plus } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { useAuth, useCustomer } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Switch } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/states";
import { useAction } from "@/lib/hooks";
import { useCustomerSummary } from "@/lib/queries";
import { rpc, supabase } from "@/lib/supabase";

const TIMEZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Colombo", "Europe/London", "America/New_York"];

export default function CustomerSettings() {
  const customer = useCustomer();
  const { profile, refresh, signOut } = useAuth();
  const qc = useQueryClient();
  const summary = useCustomerSummary(customer.id);
  const [f, setF] = React.useState({
    daily: String(customer.daily_consumption), auto: customer.auto_consumption_enabled, time: customer.auto_consumption_time.slice(0, 5),
    tz: customer.timezone, low: String(customer.low_stock_threshold), critical: String(customer.critical_threshold),
    safety: String(customer.safety_stock), address: customer.address, phone: customer.phone ?? "", instructions: customer.delivery_instructions ?? "",
  });
  const [prefs, setPrefs] = React.useState({ email: true, whatsapp: false, noncritical: true, ...(profile?.notification_preferences ?? {}) });
  const [opening, setOpening] = React.useState("");

  const save = useAction(
    () => {
      if (Number(f.critical) > Number(f.low)) throw new Error("Critical level must be at or below the low level");
      return rpc("update_my_customer_settings", {
        p_customer_id: customer.id, p_daily_consumption: Number(f.daily), p_auto_consumption_enabled: f.auto, p_auto_consumption_time: f.time,
        p_timezone: f.tz, p_low_stock_threshold: Number(f.low), p_critical_threshold: Number(f.critical), p_safety_stock: Number(f.safety),
        p_delivery_instructions: f.instructions, p_address: f.address, p_phone: f.phone,
      });
    },
    { success: "Settings saved", onSuccess: () => { refresh(); qc.invalidateQueries(); } },
  );
  const savePrefs = useAction(async () => {
    const { error } = await supabase.from("profiles").update({ notification_preferences: prefs }).eq("id", profile!.id);
    if (error) throw error;
  }, { success: "Notification preferences saved", onSuccess: () => refresh() });
  const setOpeningStock = useAction(() => rpc("set_opening_stock", { p_customer_id: customer.id, p_quantity: Number(opening) }), {
    success: "Current stock saved", onSuccess: () => qc.invalidateQueries(),
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="space-y-4">
      <PageHeader title="Settings" />
      {summary.data && !summary.data.prediction.stock_confirmed && (
        <Card className="border-primary/40">
          <CardHeader><CardTitle>How many full cans do you have now?</CardTitle><CardDescription>Set this once to start tracking. Later changes happen through deliveries and usage.</CardDescription></CardHeader>
          <CardContent className="flex gap-2">
            <Input aria-label="Current cans" type="number" min={0} max={1000} value={opening} onChange={(e) => setOpening(e.target.value)} className="w-32" />
            <Button disabled={opening === ""} loading={setOpeningStock.isPending} onClick={() => setOpeningStock.mutate(undefined)}>Save</Button>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader><CardTitle>Water usage & alerts</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Expected cans per day" htmlFor="daily"><Input id="daily" type="number" min={0} max={100} value={f.daily} onChange={set("daily")} /></Field>
            <Field label="Safety stock (cans)" htmlFor="safety" hint="Extra cans to keep on hand when ordering"><Input id="safety" type="number" min={0} value={f.safety} onChange={set("safety")} /></Field>
            <Field label="Low stock alert at" htmlFor="low" hint="Yellow warning"><Input id="low" type="number" min={0} value={f.low} onChange={set("low")} /></Field>
            <Field label="Critical alert at" htmlFor="critical" hint="Red alert (default 1 can)"><Input id="critical" type="number" min={0} value={f.critical} onChange={set("critical")} /></Field>
          </div>
          <div className="flex items-center justify-between rounded-xl bg-secondary p-3">
            <div>
              <p className="text-sm font-semibold">Record usage automatically</p>
              <p className="text-xs text-muted-foreground">Each day at the time below, Waterdrop records your expected cans. You can correct it anytime.</p>
            </div>
            <Switch id="auto" label="Automatic daily consumption" checked={f.auto} onChange={(v) => setF({ ...f, auto: v })} />
          </div>
          {f.auto && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Record at" htmlFor="time"><Input id="time" type="time" value={f.time} onChange={set("time")} /></Field>
              <Field label="Time zone" htmlFor="tz"><Select id="tz" value={f.tz} onChange={set("tz")}>{TIMEZONES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Delivery details</CardTitle></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Address" htmlFor="addr" className="sm:col-span-2"><Input id="addr" value={f.address} onChange={set("address")} /></Field>
          <Field label="Mobile" htmlFor="ph"><Input id="ph" type="tel" value={f.phone} onChange={set("phone")} /></Field>
          <Field label="Delivery instructions" htmlFor="ins"><Input id="ins" value={f.instructions} onChange={set("instructions")} /></Field>
        </CardContent>
      </Card>
      <Button size="lg" className="w-full" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save settings</Button>

      <Card>
        <CardHeader><CardTitle>Notifications</CardTitle><CardDescription>Critical water shortage alerts always appear in the app.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {([["email", "Email alerts"], ["whatsapp", "WhatsApp alerts (if your supplier enabled it)"], ["noncritical", "Non-critical reminders (low stock, order soon, bill due)"]] as const).map(([k, label]) => (
            <div key={k} className="flex items-center justify-between">
              <span className="text-sm">{label}</span>
              <Switch id={`pref-${k}`} label={label} checked={Boolean(prefs[k])} onChange={(v) => setPrefs({ ...prefs, [k]: v })} />
            </div>
          ))}
          <Button variant="outline" loading={savePrefs.isPending} onClick={() => savePrefs.mutate(undefined)}>Save notification preferences</Button>
        </CardContent>
      </Card>
      <div className="grid gap-2 sm:grid-cols-2">
        <Button variant="outline" asChild><Link to="/onboarding/customer?add=1"><Plus /> Connect another supplier</Link></Button>
        <Button variant="ghost" onClick={signOut}><LogOut /> Sign out</Button>
      </div>
    </div>
  );
}
