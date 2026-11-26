import { Upload } from "lucide-react";
import * as React from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import { FullPageLoader } from "@/auth/guards";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/input";
import { errorMessage } from "@/lib/errors";
import { rpc, supabase } from "@/lib/supabase";

export function Shell({ children, step }: { children: React.ReactNode; step: string }) {
  const { signOut } = useAuth();
  return (
    <div className="min-h-screen bg-background">
      <header className="safe-top mx-auto flex min-h-16 max-w-2xl items-center justify-between px-4">
        <Logo size="sm" />
        <Button variant="ghost" size="sm" onClick={signOut}>Sign out</Button>
      </header>
      <main className="mx-auto max-w-2xl px-4 pb-16">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-primary">{step}</p>
        {children}
      </main>
    </div>
  );
}

export async function uploadLogo(file: File, userId: string): Promise<string> {
  if (file.size > 1024 * 1024) throw new Error("Logo must be under 1 MB");
  if (!["image/png", "image/jpeg", "image/webp", "image/svg+xml"].includes(file.type)) throw new Error("Use a PNG, JPG, WEBP or SVG image");
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "png";
  const path = `${userId}/logo-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from("logos").upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw error;
  return supabase.storage.from("logos").getPublicUrl(path).data.publicUrl;
}

export function SupplierOnboarding() {
  const { profile, supplier, session, refresh, loadingProfile } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = React.useState(false);
  const [logo, setLogo] = React.useState<File | null>(null);
  const [staffCode, setStaffCode] = React.useState("");
  const [joining, setJoining] = React.useState(false);
  const [f, setF] = React.useState({
    business_name: "", owner_name: profile?.full_name ?? "", phone: profile?.phone ?? "", email: profile?.email ?? "",
    address: "", delivery_area: "", default_can_price: "40", delivery_lead_days: "1",
    gstin: "", upi_id: "", bank_name: "", account_number: "", ifsc: "",
  });
  if (loadingProfile) return <FullPageLoader />;
  if (profile?.role !== "supplier") return <Navigate to="/home" replace />;
  if (supplier) return <Navigate to="/supplier" replace />;

  async function joinAsStaff(e: React.FormEvent) {
    e.preventDefault();
    setJoining(true);
    try {
      await rpc("join_supplier_as_staff", { p_code: staffCode });
      await refresh();
      toast.success("You joined the business as a co-worker");
      navigate("/supplier", { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setJoining(false);
    }
  }

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const price = Number(f.default_can_price);
    if (!Number.isFinite(price) || price < 0) return toast.error("Enter a valid can price");
    setLoading(true);
    try {
      const logoUrl = logo && session ? await uploadLogo(logo, session.user.id) : null;
      await rpc("register_supplier", {
        p_business_name: f.business_name, p_owner_name: f.owner_name, p_phone: f.phone, p_email: f.email || null,
        p_address: f.address, p_delivery_area: f.delivery_area || null, p_default_can_price: price,
        p_billing_info: Object.fromEntries(Object.entries({ gstin: f.gstin, upi_id: f.upi_id, bank_name: f.bank_name, account_number: f.account_number, ifsc: f.ifsc }).filter(([, v]) => v.trim())),
        p_logo_url: logoUrl, p_delivery_lead_days: Number(f.delivery_lead_days) || 1,
      });
      await refresh();
      toast.success("Your water business is ready!");
      navigate("/supplier", { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Shell step="Set up your business">
      <Card className="mb-8 border-primary/40">
        <CardHeader>
          <CardTitle>Working for a water business?</CardTitle>
          <CardDescription>If the owner gave you a co-worker code, enter it here instead of creating a new business.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={joinAsStaff} className="flex gap-2">
            <Input aria-label="Co-worker code" placeholder="CO-WORKER CODE" className="uppercase tracking-widest" maxLength={8}
              value={staffCode} onChange={(e) => setStaffCode(e.target.value.toUpperCase())} autoCapitalize="characters" />
            <Button type="submit" disabled={staffCode.length !== 8} loading={joining}>Join</Button>
          </form>
        </CardContent>
      </Card>
      <h1 className="text-2xl font-bold">Or set up your own water business</h1>
      <p className="mt-1 text-sm text-muted-foreground">Customers will see these details on orders and bills.</p>
      <form onSubmit={submit} className="mt-6 space-y-6">
        <Card>
          <CardHeader><CardTitle>Business</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Business name" htmlFor="bn" className="sm:col-span-2"><Input id="bn" required minLength={2} value={f.business_name} onChange={set("business_name")} /></Field>
            <Field label="Owner name" htmlFor="on"><Input id="on" required minLength={2} value={f.owner_name} onChange={set("owner_name")} /></Field>
            <Field label="Mobile number" htmlFor="ph"><Input id="ph" required type="tel" pattern="\+?[0-9 ]{7,16}" value={f.phone} onChange={set("phone")} /></Field>
            <Field label="Email" htmlFor="em"><Input id="em" type="email" value={f.email} onChange={set("email")} /></Field>
            <Field label="Delivery area" htmlFor="da" hint="e.g. T Nagar, Adyar, Velachery"><Input id="da" value={f.delivery_area} onChange={set("delivery_area")} /></Field>
            <Field label="Business address" htmlFor="ad" className="sm:col-span-2"><Textarea id="ad" required minLength={3} value={f.address} onChange={set("address")} /></Field>
            <Field label="Logo (optional)" htmlFor="logo" className="sm:col-span-2" hint="PNG, JPG, WEBP or SVG under 1 MB">
              <label htmlFor="logo" className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed p-3 text-sm hover:bg-secondary">
                <Upload className="h-4 w-4" /> {logo ? logo.name : "Choose image"}
              </label>
              <input id="logo" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="sr-only" onChange={(e) => setLogo(e.target.files?.[0] ?? null)} />
            </Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Pricing & delivery</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Default price per can (₹)" htmlFor="pr"><Input id="pr" required type="number" min={0} step="0.5" value={f.default_can_price} onChange={set("default_can_price")} /></Field>
            <Field label="Delivery time (days)" htmlFor="ld" hint="How long after an order you usually deliver"><Input id="ld" type="number" min={0} max={30} value={f.delivery_lead_days} onChange={set("delivery_lead_days")} /></Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Billing information</CardTitle><CardDescription>Printed on invoices so customers can pay you.</CardDescription></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="UPI ID" htmlFor="upi"><Input id="upi" placeholder="business@upi" value={f.upi_id} onChange={set("upi_id")} /></Field>
            <Field label="GSTIN" htmlFor="gst"><Input id="gst" value={f.gstin} onChange={set("gstin")} /></Field>
            <Field label="Bank name" htmlFor="bank"><Input id="bank" value={f.bank_name} onChange={set("bank_name")} /></Field>
            <Field label="Account number" htmlFor="acc"><Input id="acc" value={f.account_number} onChange={set("account_number")} /></Field>
            <Field label="IFSC" htmlFor="ifsc"><Input id="ifsc" value={f.ifsc} onChange={set("ifsc")} /></Field>
          </CardContent>
        </Card>
        <Button type="submit" size="lg" className="w-full" loading={loading}>Create business</Button>
      </form>
    </Shell>
  );
}

const INVITE_KEY = "wd.pendingInvite";
export function rememberInvite(v: { token?: string; code?: string }) {
  try { sessionStorage.setItem(INVITE_KEY, JSON.stringify(v)); } catch { /* ignore */ }
}
export function readInvite(): { token?: string; code?: string } {
  try { return JSON.parse(sessionStorage.getItem(INVITE_KEY) ?? "{}"); } catch { return {}; }
}

export function clearInvite() {
  try { sessionStorage.removeItem(INVITE_KEY); } catch { /* ignore */ }
}

/** /join/:token or /join?code=XXXX — entry point from invite links & QR codes. */
export function Join() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const { session, ready, profile, loadingProfile } = useAuth();
  const code = params.get("code") ?? undefined;
  React.useEffect(() => rememberInvite({ token, code }), [token, code]);
  if (!ready || (session && loadingProfile)) return <FullPageLoader />;
  const target = `/onboarding/customer?${token ? `invite=${token}` : `code=${code ?? ""}`}`;
  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-sm text-center">
          <CardContent className="pt-6">
            <Logo className="justify-center" />
            <p className="mt-4 font-semibold">You're invited to order water with Waterdrop</p>
            <p className="mt-1 text-sm text-muted-foreground">Create a customer account or sign in to connect to your supplier.</p>
            <div className="mt-5 grid gap-2">
              <Button asChild size="lg"><Link to={`/signup?role=customer&next=${encodeURIComponent(target)}`}>Create account</Link></Button>
              <Button asChild variant="outline"><Link to={`/login?next=${encodeURIComponent(target)}`}>I already have an account</Link></Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (profile?.role !== "customer") {
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center">
        <div><p className="font-semibold">Invitations are for customer accounts.</p><Link to="/home" className="text-primary">Go to my dashboard</Link></div>
      </div>
    );
  }
  return <Navigate to={target} replace />;
}
