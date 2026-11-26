import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, LogOut, MapPin, Plus, Users } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { ACCOUNT_TYPES, useAuth, useCustomer } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EditableSection } from "@/components/ui/editable-section";
import { Field, Input, Select, Switch } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/states";
import { useAction } from "@/lib/hooks";
import { HOUSEHOLD_TYPES, suggestedDailyCans } from "@/lib/household";
import { useCustomerSummary } from "@/lib/queries";
import { rpc, supabase } from "@/lib/supabase";
import type { AccountType, Customer } from "@/types/db";

const TIMEZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Colombo", "Europe/London", "America/New_York"];

const fromCustomer = (c: Customer) => ({
  daily: String(c.daily_consumption), auto: c.auto_consumption_enabled, time: c.auto_consumption_time.slice(0, 5),
  tz: c.timezone, low: String(c.low_stock_threshold), critical: String(c.critical_threshold),
  safety: String(c.safety_stock), address: c.address, phone: c.phone ?? "", instructions: c.delivery_instructions ?? "",
  household: c.household_type ?? "", members: c.members_count == null ? "" : String(c.members_count),
  branch: c.branch_name ?? "",
});

export default function CustomerSettings() {
  const customer = useCustomer();
  const { profile, refresh, signOut, activeAccount, accountRole, canSeeMoney } = useAuth();
  const canAdmin = canSeeMoney;
  const [acc, setAcc] = React.useState({ name: activeAccount?.name ?? "", type: (activeAccount?.account_type ?? "home") as AccountType });
  const saveAccount = useAction(() => rpc("update_customer_account", { p_account_id: activeAccount!.id, p_name: acc.name, p_type: acc.type }), {
    success: "Account saved", onSuccess: () => refresh(),
  });
  const qc = useQueryClient();
  const summary = useCustomerSummary(customer.id);
  const [f, setF] = React.useState(() => fromCustomer(customer));
  const reset = () => setF(fromCustomer(customer));
  const savedPrefs = { email: true, whatsapp: false, noncritical: true, ...(profile?.notification_preferences ?? {}) };
  const [prefs, setPrefs] = React.useState(savedPrefs);
  const [opening, setOpening] = React.useState("");

  const save = useAction(
    async () => {
      if (Number(f.critical) > Number(f.low)) throw new Error("Critical level must be at or below the low level");
      if (f.members !== "" && !(Number(f.members) >= 1)) throw new Error("Members must be 1 or more");
      return rpc("update_my_customer_settings", {
        p_customer_id: customer.id, p_daily_consumption: Number(f.daily), p_auto_consumption_enabled: f.auto, p_auto_consumption_time: f.time,
        p_timezone: f.tz, p_low_stock_threshold: Number(f.low), p_critical_threshold: Number(f.critical), p_safety_stock: Number(f.safety),
        p_delivery_instructions: f.instructions, p_address: f.address, p_phone: f.phone,
        p_household_type: f.household || null, p_members_count: f.members === "" ? null : Number(f.members),
        p_branch_name: f.branch || null,
      });
    },
    { success: "Saved", onSuccess: () => { refresh(); qc.invalidateQueries(); } },
  );
  const savePrefs = useAction(async () => {
    const { error } = await supabase.from("profiles").update({ notification_preferences: prefs }).eq("id", profile!.id);
    if (error) throw error;
  }, { success: "Notification preferences saved", onSuccess: () => refresh() });
  const setOpeningStock = useAction(() => rpc("set_opening_stock", { p_customer_id: customer.id, p_quantity: Number(opening) }), {
    success: "Current stock saved", onSuccess: () => qc.invalidateQueries(),
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const suggestion = suggestedDailyCans(Number(f.members) || 0);

  return (
    <div className="space-y-4">
      <PageHeader title="Settings" description="Tap Edit on a section to change it." />
      {summary.data && !summary.data.prediction.stock_confirmed && (
        <Card className="border-primary/40">
          <CardHeader><CardTitle>How many full cans do you have now?</CardTitle><CardDescription>Set this once to start tracking. Later changes happen through deliveries and usage.</CardDescription></CardHeader>
          <CardContent className="flex gap-2">
            <Input aria-label="Current cans" type="number" min={0} max={1000} value={opening} onChange={(e) => setOpening(e.target.value)} className="w-32" />
            <Button disabled={opening === ""} loading={setOpeningStock.isPending} onClick={() => setOpeningStock.mutate(undefined)}>Save</Button>
          </CardContent>
        </Card>
      )}

      {activeAccount && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Link to="/app/branches" className="flex items-center gap-3 rounded-xl border bg-card p-3 hover:shadow-sm">
            <MapPin className="h-5 w-5 text-primary" /><span className="flex-1 text-sm font-medium">Branches & homes</span><ChevronRight className="h-4 w-4 text-muted-foreground" />
          </Link>
          <Link to="/app/team" className="flex items-center gap-3 rounded-xl border bg-card p-3 hover:shadow-sm">
            <Users className="h-5 w-5 text-primary" /><span className="flex-1 text-sm font-medium">{ACCOUNT_TYPES[activeAccount.account_type].teamLabel} members</span><ChevronRight className="h-4 w-4 text-muted-foreground" />
          </Link>
        </div>
      )}

      {activeAccount && (canAdmin ? (
        <EditableSection title="Account" description={`You are the ${accountRole} of this account.`}
          onSave={() => saveAccount.mutateAsync(undefined)} onCancel={() => setAcc({ name: activeAccount.name, type: activeAccount.account_type })} saving={saveAccount.isPending}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="accn"><Input id="accn" value={acc.name} maxLength={120} onChange={(e) => setAcc({ ...acc, name: e.target.value })} /></Field>
            <Field label="Type" htmlFor="acct">
              <Select id="acct" value={acc.type} onChange={(e) => setAcc({ ...acc, type: e.target.value as AccountType })}>
                {(Object.keys(ACCOUNT_TYPES) as AccountType[]).map((t) => <option key={t} value={t}>{ACCOUNT_TYPES[t].label}</option>)}
              </Select>
            </Field>
          </div>
        </EditableSection>
      ) : (
        <Card><CardContent className="p-4 text-sm">
          <p className="font-semibold">{activeAccount.name} · {ACCOUNT_TYPES[activeAccount.account_type].label}</p>
          <p className="text-muted-foreground">You are a member. Bills and payments are handled by the account owner or an admin.</p>
        </CardContent></Card>
      ))}

      {activeAccount && activeAccount.account_type !== "home" && (
        <EditableSection title="Branch" description="The name shown for this branch on orders and the combined bill." onSave={() => save.mutateAsync(undefined)} onCancel={reset} saving={save.isPending}>
          <Field label="Branch name" htmlFor="brn"><Input id="brn" value={f.branch} maxLength={80} placeholder="e.g. Anna Nagar branch" onChange={set("branch")} /></Field>
        </EditableSection>
      )}

      <EditableSection title="Household" description="Who uses the water here." onSave={() => save.mutateAsync(undefined)} onCancel={reset} saving={save.isPending}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Who lives here?" htmlFor="ht">
            <Select id="ht" value={f.household} onChange={set("household")}>
              <option value="">Not set</option>
              {HOUSEHOLD_TYPES.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
            </Select>
          </Field>
          <Field label="Number of members" htmlFor="mc" hint={suggestion ? `Usually about ${suggestion} can${suggestion === 1 ? "" : "s"} a day` : undefined}>
            <Input id="mc" type="number" inputMode="numeric" min={1} max={500} value={f.members} onChange={set("members")} />
          </Field>
        </div>
      </EditableSection>

      <EditableSection title="Water usage & alerts" onSave={() => save.mutateAsync(undefined)} onCancel={reset} saving={save.isPending}>
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
      </EditableSection>

      <EditableSection title="Delivery details" onSave={() => save.mutateAsync(undefined)} onCancel={reset} saving={save.isPending}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Address" htmlFor="addr" className="sm:col-span-2"><Input id="addr" value={f.address} onChange={set("address")} /></Field>
          <Field label="Mobile" htmlFor="ph"><Input id="ph" type="tel" value={f.phone} onChange={set("phone")} /></Field>
          <Field label="Delivery instructions" htmlFor="ins"><Input id="ins" value={f.instructions} onChange={set("instructions")} /></Field>
        </div>
      </EditableSection>

      <EditableSection title="Notifications" description="Critical water shortage alerts always appear in the app."
        onSave={() => savePrefs.mutateAsync(undefined)} onCancel={() => setPrefs(savedPrefs)} saving={savePrefs.isPending}>
        {([["email", "Email alerts"], ["whatsapp", "WhatsApp alerts (if your supplier enabled it)"], ["noncritical", "Non-critical reminders (low stock, order soon, bill due)"]] as const).map(([k, label]) => (
          <div key={k} className="flex items-center justify-between">
            <span className="text-sm">{label}</span>
            <Switch id={`pref-${k}`} label={label} checked={Boolean(prefs[k])} onChange={(v) => setPrefs({ ...prefs, [k]: v })} />
          </div>
        ))}
      </EditableSection>

      <div className="grid gap-2 sm:grid-cols-2">
        {canAdmin && <Button variant="outline" asChild><Link to={`/onboarding/customer?add=1${activeAccount ? `&account=${activeAccount.id}` : ""}`}><Plus /> Add a branch / supplier</Link></Button>}
        <Button variant="ghost" onClick={signOut}><LogOut /> Sign out</Button>
      </div>
    </div>
  );
}
