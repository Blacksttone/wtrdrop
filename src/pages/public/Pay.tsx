import { CheckCircle2, Clock, XCircle } from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";

declare global {
  interface Window { Cashfree?: (o: { mode: "sandbox" | "production" }) => { checkout: (o: { paymentSessionId: string; redirectTarget: string }) => Promise<unknown> } }
}

const SDK = "https://sdk.cashfree.com/js/v3/cashfree.js";

function loadSdk(): Promise<void> {
  if (window.Cashfree) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SDK;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load the payment page. Check your internet and try again."));
    document.head.appendChild(s);
  });
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-background p-6 text-center">
      <Logo size="lg" />
      {children}
    </div>
  );
}

/** Opens Cashfree checkout for a payment session (used by the website and, via the browser, by the app). */
export function PayCheckout() {
  const [params] = useSearchParams();
  const session = params.get("s");
  const mode = params.get("m") === "production" ? "production" : "sandbox";
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!session) { setError("This payment link is incomplete."); return; }
    loadSdk()
      .then(() => window.Cashfree!({ mode }).checkout({ paymentSessionId: session, redirectTarget: "_self" }))
      .catch((e) => setError(String(e?.message ?? e)));
  }, [session, mode]);
  return (
    <Frame>
      {error ? <><XCircle className="h-10 w-10 text-stock-critical" /><p className="max-w-sm text-sm">{error}</p></>
        : <><Clock className="h-10 w-10 animate-pulse text-primary" /><p className="text-sm text-muted-foreground">Opening secure payment page…</p></>}
    </Frame>
  );
}

/** Cashfree returns here; the server re-checks the order with Cashfree before marking the bill paid. */
export function PayDone() {
  const [params] = useSearchParams();
  const orderId = params.get("order_id") ?? "";
  const [status, setStatus] = React.useState<"checking" | "paid" | "pending" | "failed" | "error">("checking");
  React.useEffect(() => {
    let tries = 0;
    let stop = false;
    const check = async () => {
      const { data, error } = await supabase.functions.invoke("cashfree-platform/verify", { body: { order_id: orderId } });
      if (stop) return;
      if (error) return setStatus("error");
      const s = (data as { status?: string })?.status;
      if (s === "paid" || s === "failed") return setStatus(s);
      if (++tries < 6) setTimeout(check, 3000); else setStatus("pending");
    };
    check();
    return () => { stop = true; };
  }, [orderId]);
  return (
    <Frame>
      {status === "checking" && <><Clock className="h-10 w-10 animate-pulse text-primary" /><p>Confirming your payment…</p></>}
      {status === "paid" && <><CheckCircle2 className="h-12 w-12 text-stock-ok" /><h1 className="text-xl font-bold">Payment successful</h1><p className="text-sm text-muted-foreground">Your Waterdrop bill is marked paid. You can close this page and go back to the app.</p></>}
      {status === "pending" && <><Clock className="h-10 w-10 text-amber-600" /><h1 className="text-xl font-bold">Payment is being confirmed</h1><p className="max-w-sm text-sm text-muted-foreground">If money was taken, the bill will be marked paid automatically within a few minutes.</p></>}
      {(status === "failed" || status === "error") && <><XCircle className="h-12 w-12 text-stock-critical" /><h1 className="text-xl font-bold">Payment not completed</h1><p className="text-sm text-muted-foreground">No money was taken for this attempt. Please try again.</p></>}
      <Button variant="outline" asChild><Link to="/supplier/waterdrop-bill">Back to Waterdrop bill</Link></Button>
    </Frame>
  );
}
