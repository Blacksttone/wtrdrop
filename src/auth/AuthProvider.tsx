import type { Session } from "@supabase/supabase-js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { supabase } from "@/lib/supabase";
import type { Customer, Profile, Supplier } from "@/types/db";

interface AuthState {
  session: Session | null;
  ready: boolean;
  profile: Profile | null;
  supplier: Supplier | null;
  customers: Customer[];
  activeCustomer: Customer | null;
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
      let customers: Customer[] = [];
      if (profile.role === "supplier") {
        const r = await supabase.from("suppliers").select("*").eq("owner_id", userId!).maybeSingle();
        if (r.error) throw r.error;
        supplier = r.data;
      }
      if (profile.role === "customer") {
        const r = await supabase.from("customers").select("*").eq("user_id", userId!).order("created_at");
        if (r.error) throw r.error;
        customers = r.data ?? [];
      }
      return { profile: profile as Profile, supplier, customers };
    },
  });

  const customers = me.data?.customers ?? [];
  const activeCustomer = customers.find((c) => c.id === activeId) ?? customers[0] ?? null;

  const value: AuthState = {
    session,
    ready,
    profile: me.data?.profile ?? null,
    supplier: me.data?.supplier ?? null,
    customers,
    activeCustomer,
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
