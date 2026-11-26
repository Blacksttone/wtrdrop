import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Lock, Share2, Trash2, Unlock, UserPlus, Users } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui/states";
import { formatDate } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { openExternal } from "@/lib/native";
import { rpc, supabase } from "@/lib/supabase";
import type { StaffInvite, StaffMember } from "@/types/db";

const ROLE_INFO = {
  manager: { label: "Manager", text: "Everything except co-workers and business settings: billing, payments, reports, customers." },
  delivery: { label: "Delivery", text: "Customers, orders, deliveries and stock only. Cannot see bills, payments or reports." },
} as const;

function InviteDialog({ onClose }: { onClose: () => void }) {
  const { supplier } = useAuth();
  const qc = useQueryClient();
  const [role, setRole] = React.useState<"manager" | "delivery">("delivery");
  const [label, setLabel] = React.useState("");
  const [invite, setInvite] = React.useState<StaffInvite | null>(null);
  const create = useAction(() => rpc<StaffInvite>("create_staff_invite", { p_role: role, p_label: label || null }), {
    onSuccess: (r) => { setInvite(r); qc.invalidateQueries({ queryKey: ["staff-invites"] }); },
  });
  const message = invite
    ? `You're invited to work with ${supplier?.business_name} on Waterdrop.\n1. Install Waterdrop and sign up as "I supply water".\n2. Enter co-worker code: ${invite.code}\n(Code valid for 7 days, one person only.)`
    : "";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Add a co-worker" description="Each co-worker gets their own login. Create a one-time code and send it to them.">
        {!invite ? (
          <div className="space-y-4">
            <Field label="Their name (for your reference)" htmlFor="sl"><Input id="sl" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Dinesh – delivery" /></Field>
            <Field label="Role" htmlFor="sr">
              <Select id="sr" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                <option value="delivery">Delivery</option>
                <option value="manager">Manager</option>
              </Select>
            </Field>
            <p className="rounded-lg bg-secondary p-3 text-xs">{ROLE_INFO[role].text}</p>
            <Button className="w-full" loading={create.isPending} onClick={() => create.mutate(undefined)}>Create co-worker code</Button>
          </div>
        ) : (
          <div className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">Co-worker code ({ROLE_INFO[invite.role].label})</p>
            <p className="select-all text-4xl font-extrabold tracking-[0.25em] text-primary">{invite.code}</p>
            <p className="text-xs text-muted-foreground">Works once, valid until {formatDate(invite.expires_at)}.</p>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={async () => { await navigator.clipboard.writeText(invite.code); toast.success("Code copied"); }}><Copy /> Copy code</Button>
              <Button onClick={() => openExternal(`https://wa.me/?text=${encodeURIComponent(message)}`)}><Share2 /> WhatsApp</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function Team() {
  const { supplierRole } = useAuth();
  const isOwner = supplierRole === "owner";
  const [adding, setAdding] = React.useState(false);
  const staff = useQuery({ queryKey: ["staff"], queryFn: () => rpc<StaffMember[]>("list_staff") });
  const invites = useQuery({
    queryKey: ["staff-invites"], enabled: isOwner,
    queryFn: async () => {
      const { data, error } = await supabase.from("staff_invites").select("*").is("used_at", null).is("revoked_at", null)
        .gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false });
      if (error) throw error;
      return data as StaffInvite[];
    },
  });
  const update = useAction((v: { id: string; role?: string; status?: string }) => rpc("update_staff", { p_staff_id: v.id, p_role: v.role ?? null, p_status: v.status ?? null }), {
    success: "Co-worker updated", invalidate: [["staff"]],
  });
  const remove = useAction((id: string) => rpc("remove_staff", { p_staff_id: id }), { success: "Co-worker removed", invalidate: [["staff"]] });
  const revoke = useAction((id: string) => rpc("revoke_staff_invite", { p_invite_id: id }), { success: "Code cancelled", invalidate: [["staff-invites"]] });

  return (
    <div className="space-y-5">
      <PageHeader title="Co-workers" description="Give your staff their own login. Block anyone instantly."
        actions={isOwner && <Button onClick={() => setAdding(true)}><UserPlus /> Add co-worker</Button>} />
      <div className="grid gap-3 sm:grid-cols-2">
        {(["manager", "delivery"] as const).map((r) => (
          <div key={r} className="rounded-xl border bg-card p-3 text-sm"><b>{ROLE_INFO[r].label}:</b> <span className="text-muted-foreground">{ROLE_INFO[r].text}</span></div>
        ))}
      </div>
      {isOwner && (invites.data?.length ?? 0) > 0 && (
        <Card>
          <CardHeader><CardTitle>Codes not used yet</CardTitle><CardDescription>Share these with the co-worker, or cancel them.</CardDescription></CardHeader>
          <CardContent>
            <ul className="divide-y">
              {invites.data!.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div>
                    <p className="font-mono text-lg font-bold tracking-widest">{i.code}</p>
                    <p className="text-xs text-muted-foreground">{i.label ?? "No name"} · {ROLE_INFO[i.role].label} · valid till {formatDate(i.expires_at)}</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}>Cancel</Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {staff.isLoading ? <LoadingState /> : staff.error ? <ErrorState error={staff.error} onRetry={staff.refetch} /> : !staff.data?.length ? (
        <EmptyState icon={Users} title="No co-workers yet" description="Add delivery staff or a manager so they can use Waterdrop with their own login."
          action={isOwner && <Button onClick={() => setAdding(true)}><UserPlus /> Add co-worker</Button>} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {staff.data.map((m) => (
            <Card key={m.id} className={m.status === "blocked" ? "border-red-200 bg-red-50/40" : ""}>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold">{m.staff_name}</p>
                    <p className="truncate text-xs text-muted-foreground">{m.email}{m.phone ? ` · ${m.phone}` : ""}</p>
                    <p className="text-xs text-muted-foreground">Joined {formatDate(m.created_at)}</p>
                  </div>
                  {m.status === "blocked" ? <Badge variant="danger">Blocked</Badge> : <Badge variant="success">Active</Badge>}
                </div>
                {isOwner ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <select aria-label="Role" className="h-9 rounded-md border bg-card px-2 text-sm" value={m.role}
                      onChange={(e) => update.mutate({ id: m.id, role: e.target.value })}>
                      <option value="delivery">Delivery</option>
                      <option value="manager">Manager</option>
                    </select>
                    {m.status === "blocked" ? (
                      <Button size="sm" variant="success" onClick={() => update.mutate({ id: m.id, status: "active" })}><Unlock /> Unblock</Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => { if (confirm(`Block ${m.staff_name}? They will lose access immediately.`)) update.mutate({ id: m.id, status: "blocked" }); }}><Lock /> Block</Button>
                    )}
                    <Button size="sm" variant="ghost" aria-label="Remove co-worker" onClick={() => { if (confirm(`Remove ${m.staff_name} from your business?`)) remove.mutate(m.id); }}><Trash2 /></Button>
                  </div>
                ) : (
                  <p className="text-sm">{ROLE_INFO[m.role].label}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {adding && <InviteDialog onClose={() => setAdding(false)} />}
    </div>
  );
}
