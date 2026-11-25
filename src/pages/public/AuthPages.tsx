import { Building2, Home } from "lucide-react";
import * as React from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthProvider";
import { Logo, TAGLINE, TAMIL_TAGLINE } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/errors";
import { siteUrl } from "@/lib/native";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen md:grid-cols-2">
      <div className="water-gradient hidden flex-col justify-between p-10 text-white md:flex">
        <Logo light size="md" />
        <div>
          <p className="text-4xl font-extrabold leading-tight">{TAGLINE}</p>
          <p className="tamil mt-3 text-lg text-sky-100">{TAMIL_TAGLINE}</p>
        </div>
        <p className="text-sm text-sky-100">Accurate stock. On-time orders. Honest bills.</p>
      </div>
      <div className="safe-top flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 md:hidden"><Logo /></div>
          <h1 className="text-2xl font-bold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function Login() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const next = params.get("next") || "/home";
  if (session) return <Navigate to={next} replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (error) return toast.error(errorMessage(error));
    navigate(next, { replace: true });
  }

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your Waterdrop account">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full" size="lg" loading={loading}>Sign in</Button>
      </form>
      <div className="mt-4 flex justify-between text-sm">
        <Link to="/forgot-password" className="text-primary hover:underline">Forgot password?</Link>
        <Link to={`/signup${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`} className="text-primary hover:underline">Create account</Link>
      </div>
    </AuthShell>
  );
}

export function Signup() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const initialRole = params.get("role") === "supplier" ? "supplier" : "customer";
  const [role, setRole] = React.useState<"customer" | "supplier">(initialRole);
  const [form, setForm] = React.useState({ full_name: "", phone: "", email: "", password: "" });
  const [loading, setLoading] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const next = params.get("next");

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password.length < 8) return toast.error("Password must be at least 8 characters");
    if (!/^\+?[0-9 ]{7,16}$/.test(form.phone.trim())) return toast.error("Enter a valid mobile number");
    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email: form.email.trim(),
      password: form.password,
      options: {
        data: { full_name: form.full_name.trim(), phone: form.phone.trim(), role },
        emailRedirectTo: `${siteUrl()}${next ?? "/home"}`,
      },
    });
    setLoading(false);
    if (error) return toast.error(errorMessage(error));
    if (data.session) navigate(next ?? "/home", { replace: true });
    else setSent(true);
  }

  if (sent) {
    return (
      <AuthShell title="Check your email" subtitle={`We sent a confirmation link to ${form.email}.`}>
        <p className="text-sm text-muted-foreground">Open the link to activate your account, then continue setting up Waterdrop.</p>
        <Button asChild variant="outline" className="mt-6 w-full"><Link to="/login">Back to sign in</Link></Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Create your account" subtitle="Takes less than a minute.">
      <div className="mb-5 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Account type">
        {([
          ["customer", Home, "I need water", "Home / office"],
          ["supplier", Building2, "I supply water", "Water business"],
        ] as const).map(([value, Icon, label, sub]) => (
          <button key={value} type="button" role="radio" aria-checked={role === value} onClick={() => setRole(value)}
            className={cn("rounded-xl border-2 p-3 text-left transition-colors", role === value ? "border-primary bg-secondary" : "border-border hover:border-primary/40")}>
            <Icon className="h-5 w-5 text-primary" />
            <p className="mt-1 text-sm font-semibold">{label}</p>
            <p className="text-xs text-muted-foreground">{sub}</p>
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="space-y-4">
        <Field label={role === "supplier" ? "Owner name" : "Your name"} htmlFor="name">
          <Input id="name" required autoComplete="name" value={form.full_name} onChange={set("full_name")} />
        </Field>
        <Field label="Mobile number" htmlFor="phone">
          <Input id="phone" required type="tel" inputMode="tel" autoComplete="tel" placeholder="98765 43210" value={form.phone} onChange={set("phone")} />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input id="email" required type="email" autoComplete="email" value={form.email} onChange={set("email")} />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 8 characters">
          <Input id="password" required type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={set("password")} />
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={loading}>Create account</Button>
      </form>
      <p className="mt-4 text-center text-sm">Already have an account? <Link to="/login" className="text-primary hover:underline">Sign in</Link></p>
    </AuthShell>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${siteUrl()}/reset-password` });
    setLoading(false);
    if (error) return toast.error(errorMessage(error));
    setSent(true);
  }
  return (
    <AuthShell title="Reset password" subtitle={sent ? "If that email has an account, a reset link is on its way." : "We'll email you a reset link."}>
      {!sent && (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email" htmlFor="email"><Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button type="submit" className="w-full" loading={loading}>Send reset link</Button>
        </form>
      )}
      <Link to="/login" className="mt-4 block text-sm text-primary hover:underline">Back to sign in</Link>
    </AuthShell>
  );
}

export function ResetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) return toast.error("Password must be at least 8 characters");
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) return toast.error(errorMessage(error));
    toast.success("Password updated");
    navigate("/home", { replace: true });
  }
  return (
    <AuthShell title="Choose a new password">
      <form onSubmit={submit} className="space-y-4">
        <Field label="New password" htmlFor="pw"><Input id="pw" type="password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Button type="submit" className="w-full" loading={loading}>Update password</Button>
      </form>
    </AuthShell>
  );
}
