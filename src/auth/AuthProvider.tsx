import type { Session } from "@supabase/supabase-js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { supabase } from "@/lib/supabase";
import { disablePush } from "@/lib/push";
import type { AccountMembership, AccountRole, Customer, CustomerAccount, Profile, Supplier, SupplierRole } from "@/types/db";

interface AuthState {
  session: Session | null;
  ready: boolean;
  profile: Profile | null;
  supplier: Supplier | null;
  /** owner, manager or delivery (null when not part of a business) */
  supplierRole: SupplierRole | null;
  /** co-worker whose access the owner blocked */
  staffBlocked: boolean;
  /** branches the customer user can access (across all their accounts) */
  customers: Customer[];
  activeCustomer: Customer | null;
  accounts: CustomerAccount[];
  memberships: AccountMembership[];
  /** account of the active branch */
  activeAccount: CustomerAccount | null;
  /** caller's role in the active branch's account (owner when the branch has no account) */
  accountRole: AccountRole | null;
  /** owner/admin of the active branch: may see bills and pay */
  canSeeMoney: boolean;
  /** every membership blocked and no branches left */
  memberBlocked: boolean;
  setActiveCustomerId: (id: string) => void;
  loadingProfile: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = React.createContext<AuthState | null>(null);
const ACTIVE_KEY = "wd.activeCustomer";

function readActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [session, setSession] = React.useState<Session | null>(null);
  const [ready, setReady] = React.useState(false);
  const [activeId, setActiveId] = React.useState<string | null>(readActive);

  React.useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (!s) qc.clear();
    });
    return () => sub.subscription.unsubscribe();
  }, [qc]);

  const userId = session?.user.id;
  const me = useQuery({
    queryKey: ["me", userId],
    enabled: Boolean(userId),
    queryFn: async () => {
      const { data: profile, error } = await supabase.from("profiles").select("*").eq("id", userId!).single();
      if (error) throw error;
      let supplier: Supplier | null = null;
      let supplierRole: SupplierRole | null = null;
      let staffBlocked = false;
      let customers: Customer[] = [];
      let accounts: CustomerAccount[] = [];
      let memberships: AccountMembership[] = [];
      if (profile.role === "supplier") {
        const roleRes = await supabase.rpc("my_supplier_role");
        if (roleRes.error) throw roleRes.error;
        supplierRole = (roleRes.data as SupplierRole | null) ?? null;
        if (supplierRole === "owner") {
          const r = await supabase.from("suppliers").select("*").eq("owner_id", userId!).maybeSingle();
          if (r.error) throw r.error;
          supplier = r.data;
        } else {
          const st = await supabase.from("supplier_staff").select("supplier_id, status").eq("user_id", userId!).maybeSingle();
          if (st.error) throw st.error;
          staffBlocked = st.data?.status === "blocked";
          if (st.data && !staffBlocked) {
            const r = await supabase.from("suppliers").select("*").eq("id", st.data.supplier_id).maybeSingle();
            if (r.error) throw r.error;
            supplier = r.data;
          }
        }
      }
      if (profile.role === "customer") {
        // RLS returns exactly the branches this user may access (own + family/team).
        const [r, acc, mem] = await Promise.all([
          supabase.from("customers").select("*").order("created_at"),
          supabase.from("customer_accounts").select("*").order("created_at"),
          supabase.from("customer_account_members").select("id, account_id, user_id, role, status, all_branches").eq("user_id", userId!),
        ]);
        if (r.error) throw r.error;
        if (acc.error) throw acc.error;
        if (mem.error) throw mem.error;
        customers = r.data ?? [];
        accounts = acc.data ?? [];
        memberships = (mem.data ?? []) as AccountMembership[];
      }
      return { profile: profile as Profile, supplier, supplierRole, staffBlocked, customers, accounts, memberships };
    },
  });

  const customers = me.data?.customers ?? [];
  const activeCustomer = customers.find((c) => c.id === activeId) ?? customers[0] ?? null;
  const accounts = me.data?.accounts ?? [];
  const memberships = me.data?.memberships ?? [];
  const activeAccount = accounts.find((a) => a.id === activeCustomer?.account_id) ?? null;
  const activeMembership = memberships.find((m) => m.account_id === activeCustomer?.account_id && m.status === "active");
  const accountRole: AccountRole | null = activeCustomer ? (activeCustomer.account_id ? activeMembership?.role ?? null : "owner") : null;

  const value: AuthState = {
    session,
    ready,
    profile: me.data?.profile ?? null,
    supplier: me.data?.supplier ?? null,
    supplierRole: me.data?.supplierRole ?? null,
    staffBlocked: me.data?.staffBlocked ?? false,
    customers,
    activeCustomer,
    accounts,
    memberships,
    activeAccount,
    accountRole,
    canSeeMoney: accountRole === "owner" || accountRole === "admin",
    memberBlocked: customers.length === 0 && memberships.length > 0 && memberships.every((m) => m.status === "blocked"),
    setActiveCustomerId: (id) => {
      setActiveId(id);
      try {
        localStorage.setItem(ACTIVE_KEY, id);
      } catch {
        /* storage unavailable */
      }
      qc.invalidateQueries();
    },
    loadingProfile: Boolean(userId) && me.isLoading,
    refresh: async () => {
      await qc.invalidateQueries({ queryKey: ["me"] });
    },
    signOut: async () => {
      await disablePush().catch(() => undefined);
      await supabase.auth.signOut();
      qc.clear();
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

/** The active customer account (customer app screens only). */
export function useCustomer(): Customer {
  const { activeCustomer } = useAuth();
  if (!activeCustomer) throw new Error("No customer account");
  return activeCustomer;
}

export function useSupplier(): Supplier {
  const { supplier } = useAuth();
  if (!supplier) throw new Error("No supplier account");
  return supplier;
}

/** True when the signed-in supplier user may handle money, reports and customer management. */
export function useCanManage(): boolean {
  const { supplierRole } = useAuth();
  return supplierRole === "owner" || supplierRole === "manager";
}

export const ACCOUNT_TYPES = {
  home: { label: "Home", teamLabel: "Family", memberWord: "family member", branchWord: "home" },
  store: { label: "Store", teamLabel: "Team", memberWord: "team member", branchWord: "branch" },
  company: { label: "Company", teamLabel: "Team", memberWord: "team member", branchWord: "branch" },
} as const;

/** "Raja Stores · Lake Rd branch" style label for a branch. */
export function branchLabel(c: Pick<Customer, "branch_name" | "address" | "customer_name">, account?: Pick<CustomerAccount, "name"> | null) {
  const where = c.branch_name || c.address.split(",")[0];
  return account ? `${account.name} · ${where}` : where || c.customer_name;
}
