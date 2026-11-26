import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, LogOut, Lock, Share2, Trash2, Unlock, UserPlus, Users } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { ACCOUNT_TYPES, branchLabel, useAuth } from "@/auth/AuthProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Switch } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui/states";
import { formatDate } from "@/lib/format";
import { useAction } from "@/lib/hooks";
import { openExternal } from "@/lib/native";
import { rpc, supabase } from "@/lib/supabase";
import type { AccountMember, AccountRole, Customer, CustomerAccount, MemberInvite } from "@/types/db";

const ROLE_INFO: Record<AccountRole, { label: string; text: string }> = {
  owner: { label: "Owner", text: "Full control, including members and bills." },
  admin: { label: "Admin", text: "Everything: orders, deliveries, usage, bills, payments, branches and members." },
  member: { label: "Member", text: "Order water, confirm deliveries and record usage. Cannot see bills or payments." },
};

function BranchPicker({ branches, all, setAll, ids, setIds }: {
  branches: Customer[]; all: boolean; setAll: (v: boolean) => void; ids: string[]; setIds: (v: string[]) => void;
}) {
  if (branches.length < 2) return null;
  return (
    <div className="space-y-2 rounded-xl bg-secondary p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Access to all branches</span>
        <Switch id="allb" label="Access to all branches" checked={all} onChange={setAll} />
      </div>
      {!all && branches.map((b) => (
        <label key={b.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4" checked={ids.includes(b.id)}
            onChange={(e) => setIds(e.target.checked ? [...ids, b.id] : ids.filter((x) => x !== b.id))} />
          {branchLabel(b)}
        </label>
      ))}
    </div>
  );
}

function InviteDialog({ account, myRole, branches, onClose }: { account: CustomerAccount; myRole: AccountRole; branches: Customer[]; onClose: () => void }) {
  const qc = useQueryClient();
  const meta = ACCOUNT_TYPES[account.account_type];
  const [role, setRole] = React.useState<AccountRole>("member");
  const [label, setLabel] = React.useState("");
  const [all, setAll] = React.useState(true);
  const [ids, setIds] = React.useState<string[]>([]);
  const [invite, setInvite] = React.useState<MemberInvite | null>(null);
  const create = useAction(() => rpc<MemberInvite>("create_member_invite", {
    p_account_id: account.id, p_role: role, p_all_branches: all || branches.length < 2, p_branch_ids: all ? [] : ids, p_label: label || null,
  }), { onSuccess: (r) => { setInvite(r); qc.invalidateQueries({ queryKey: ["member-invites", account.id] }); } });
  const message = invite
    ? `Join "${account.name}" on Waterdrop so you can order water and confirm deliveries.\n1. Install Waterdrop and sign up as "I need water".\n2. Tap "I have a family / team code" and enter: ${invite.code}\n(Valid for 7 days, one person only.)`
    : "";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Add a ${meta.memberWord}`} description="Each person gets their own login. Create a one-time code and send it to them.">
        {!invite ? (
          <div className="space-y-4">
            <Field label="Their name (for your reference)" htmlFor="ml"><Input id="ml" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder={account.account_type === "home" ? "e.g. Amma" : "e.g. Suresh – Anna Nagar"} /></Field>
            <Field label="Role" htmlFor="mr">
              <Select id="mr" value={role} onChange={(e) => setRole(e.target.value as AccountRole)}>
                <option value="member">Member</option>
                {myRole === "owner" && <option value="admin">Admin</option>}
              </Select>
            </Field>
            <p className="rounded-lg bg-secondary p-3 text-xs">{ROLE_INFO[role].text}</p>
            <BranchPicker branches={branches} all={all} setAll={setAll} ids={ids} setIds={setIds} />
            <Button className="w-full" disabled={!all && branches.length > 1 && !ids.length} loading={create.isPending} onClick={() => create.mutate(undefined)}>Create code</Button>
          </div>
        ) : (
          <div className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">{meta.teamLabel} code ({ROLE_INFO[invite.role].label})</p>
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

function BranchAccessDialog({ member, branches, onClose }: { member: AccountMember; branches: Customer[]; onClose: () => void }) {
  const [all, setAll] = React.useState(member.all_branches);
  const [ids, setIds] = React.useState<string[]>(member.branch_ids);
  const save = useAction(() => rpc("update_account_member", { p_member_id: member.id, p_all_branches: all, p_branch_ids: all ? [] : ids }), {
    success: "Access updated", invalidate: [["account-members"]], onSuccess: onClose,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Branch access – ${member.full_name}`}>
        <div className="space-y-4">
          <BranchPicker branches={branches} all={all} setAll={setAll} ids={ids} setIds={setIds} />
          <Button className="w-full" disabled={!all && !ids.length} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function CustomerTeam() {
  const { profile, accounts, memberships, activeAccount, customers, refresh } = useAuth();
  const [accountId, setAccountId] = React.useState(activeAccount?.id ?? accounts[0]?.id ?? "");
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0];
  const myRole = memberships.find((m) => m.account_id === account?.id && m.status === "active")?.role ?? "member";
  const canManage = myRole === "owner" || myRole === "admin";
  const branches = customers.filter((c) => c.account_id === account?.id);
  const meta = account ? ACCOUNT_TYPES[account.account_type] : ACCOUNT_TYPES.home;
  const [adding, setAdding] = React.useState(false);
  const [access, setAccess] = React.useState<AccountMember | null>(null);

  const members = useQuery({
    queryKey: ["account-members", account?.id], enabled: Boolean(account),
    queryFn: () => rpc<AccountMember[]>("list_account_members", { p_account_id: account!.id }),
  });
  const invites = useQuery({
    queryKey: ["member-invites", account?.id], enabled: Boolean(account) && canManage,
    queryFn: async () => {
      const { data, error } = await supabase.from("customer_member_invites").select("*").eq("account_id", account!.id)
        .is("used_at", null).is("revoked_at", null).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false });
      if (error) throw error;
      return data as MemberInvite[];
    },
  });
  const update = useAction((v: { id: string; role?: AccountRole; status?: string }) => rpc("update_account_member", { p_member_id: v.id, p_role: v.role ?? null, p_status: v.status ?? null }), {
    success: "Updated", invalidate: [["account-members"]],
  });
  const remove = useAction((id: string) => rpc("remove_account_member", { p_member_id: id }), { success: "Removed", invalidate: [["account-members"]] });
  const leave = useAction((id: string) => rpc("remove_account_member", { p_member_id: id }), { success: "You left the account", onSuccess: () => refresh() });
  const revoke = useAction((id: string) => rpc("revoke_member_invite", { p_invite_id: id }), { success: "Code cancelled", invalidate: [["member-invites"]] });

  if (!account) {
    return <EmptyState icon={Users} title="No family or team yet" description="Create a home, store or company account first." />;
  }

  return (
    <div className="space-y-5">
      <PageHeader title={meta.teamLabel} description={account.account_type === "home"
        ? "Give your family their own login to order water and confirm deliveries."
        : "Give your staff their own login. Limit them to some branches, or block anyone instantly."}
        actions={canManage && <Button onClick={() => setAdding(true)}><UserPlus /> Add {meta.memberWord}</Button>} />
      {accounts.length > 1 && (
        <Field label="Account" htmlFor="ta">
          <Select id="ta" value={account.id} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({ACCOUNT_TYPES[a.account_type].label})</option>)}
          </Select>
        </Field>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {(["admin", "member"] as const).map((r) => (
          <div key={r} className="rounded-xl border bg-card p-3 text-sm"><b>{ROLE_INFO[r].label}:</b> <span className="text-muted-foreground">{ROLE_INFO[r].text}</span></div>
        ))}
      </div>
      {canManage && (invites.data?.length ?? 0) > 0 && (
        <Card>
          <CardHeader><CardTitle>Codes not used yet</CardTitle><CardDescription>Share these, or cancel them.</CardDescription></CardHeader>
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
      {members.isLoading ? <LoadingState /> : members.error ? <ErrorState error={members.error} onRetry={members.refetch} /> : (
        <div className="grid gap-3 md:grid-cols-2">
          {members.data!.map((m) => {
            const isMe = m.user_id === profile?.id;
            const manageable = canManage && !isMe && m.role !== "owner" && (myRole === "owner" || m.role === "member");
            const scope = m.all_branches || branches.length < 2 ? "All branches"
              : branches.filter((b) => m.branch_ids.includes(b.id)).map((b) => branchLabel(b)).join(", ") || "No branches";
            return (
              <Card key={m.id} className={m.status === "blocked" ? "border-red-200 bg-red-50/40" : ""}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold">{m.full_name || "Unnamed"}{isMe && " (you)"}</p>
                      <p className="truncate text-xs text-muted-foreground">{m.email}{m.phone ? ` · ${m.phone}` : ""}</p>
                      <p className="text-xs text-muted-foreground">{ROLE_INFO[m.role].label}{branches.length > 1 ? ` · ${scope}` : ""}</p>
                    </div>
                    {m.status === "blocked" ? <Badge variant="danger">Blocked</Badge> : <Badge variant="success">Active</Badge>}
                  </div>
                  {manageable && (
                    <div className="flex flex-wrap items-center gap-2">
                      {myRole === "owner" && (
                        <select aria-label="Role" className="h-9 rounded-md border bg-card px-2 text-sm" value={m.role}
                          onChange={(e) => update.mutate({ id: m.id, role: e.target.value as AccountRole })}>
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                        </select>
                      )}
                      {branches.length > 1 && <Button size="sm" variant="outline" onClick={() => setAccess(m)}>Branches</Button>}
                      {m.status === "blocked" ? (
                        <Button size="sm" variant="success" onClick={() => update.mutate({ id: m.id, status: "active" })}><Unlock /> Unblock</Button>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => { if (confirm(`Block ${m.full_name}? They lose access immediately.`)) update.mutate({ id: m.id, status: "blocked" }); }}><Lock /> Block</Button>
                      )}
                      <Button size="sm" variant="ghost" aria-label="Remove member" onClick={() => { if (confirm(`Remove ${m.full_name} from ${account.name}?`)) remove.mutate(m.id); }}><Trash2 /></Button>
                    </div>
                  )}
                  {isMe && m.role !== "owner" && (
                    <Button size="sm" variant="ghost" onClick={() => { if (confirm(`Leave ${account.name}?`)) leave.mutate(m.id); }}><LogOut /> Leave</Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      {adding && <InviteDialog account={account} myRole={myRole} branches={branches} onClose={() => setAdding(false)} />}
      {access && <BranchAccessDialog member={access} branches={branches} onClose={() => setAccess(null)} />}
    </div>
  );
}
