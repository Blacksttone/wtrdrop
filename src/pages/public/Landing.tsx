import { BellRing, CalendarClock, CheckCircle2, Download, FileText, ShieldCheck, Truck } from "lucide-react";
import { Link } from "react-router-dom";
import { Logo, LogoMark, TAGLINE, TAMIL_TAGLINE } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { formatSize, useLatestRelease } from "@/lib/appUpdate";

const features = [
  { icon: CheckCircle2, title: "Customer-confirmed deliveries", text: "Stock only increases by the cans the customer actually received. Shortages are recorded automatically." },
  { icon: CalendarClock, title: "Know when water runs out", text: "Daily consumption tracking predicts your empty date and tells you when to order, factoring in delivery time." },
  { icon: BellRing, title: "Low-stock alerts", text: "One clear alert when stock is low or critical — in-app, email and optional WhatsApp. No spam." },
  { icon: Truck, title: "Orders & delivery tracking", text: "Regular and bulk orders, preferred dates, live status from pending to out for delivery." },
  { icon: FileText, title: "Automatic monthly bills", text: "Professional PDF invoices from confirmed deliveries, with balances, partial payments and credit notes." },
  { icon: ShieldCheck, title: "Secure by design", text: "Every supplier and customer sees only their own data, enforced by database row-level security." },
];

export default function Landing() {
  const release = useLatestRelease();
  return (
    <div className="min-h-screen bg-white">
      <header className="safe-top mx-auto flex min-h-16 max-w-6xl items-center justify-between px-4">
        <Logo />
        <div className="flex gap-2">
          <Button variant="ghost" asChild><Link to="/login">Sign in</Link></Button>
          <Button asChild><Link to="/signup">Get started</Link></Button>
        </div>
      </header>

      <section className="water-gradient relative overflow-hidden">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 md:grid-cols-2 md:py-24">
          <div className="text-white">
            <p className="tamil mb-3 inline-block rounded-full bg-white/15 px-3 py-1 text-sm font-semibold">{TAMIL_TAGLINE}</p>
            <h1 className="text-4xl font-extrabold leading-tight tracking-tight md:text-6xl">{TAGLINE}</h1>
            <p className="mt-4 max-w-lg text-lg text-sky-50">
              Waterdrop keeps an accurate count of every water can — from supplier delivery to the last glass —
              so homes and offices order on time and suppliers bill exactly what was delivered.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" className="bg-white text-primary hover:bg-sky-50" asChild>
                <Link to="/signup?role=customer">I need water</Link>
              </Button>
              <Button size="lg" variant="outline" className="border-white/60 bg-transparent text-white hover:bg-white/10 hover:text-white" asChild>
                <Link to="/signup?role=supplier">I supply water</Link>
              </Button>
            </div>
            {release.data && (
              <a href={release.data.download_url} className="mt-5 inline-flex items-center gap-2 rounded-xl bg-slate-900/30 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-900/40">
                <Download className="h-4 w-4" /> Download Android app · v{release.data.version_name}{release.data.file_size ? ` · ${formatSize(release.data.file_size)}` : ""}
              </a>
            )}
          </div>
          <div className="relative mx-auto w-full max-w-sm">
            <div className="rounded-3xl bg-white p-6 shadow-2xl">
              <p className="text-sm font-medium text-slate-500">Water cans available</p>
              <div className="mt-2 flex items-end gap-2">
                <span className="text-6xl font-extrabold text-slate-900">4</span>
                <span className="mb-2 text-slate-500">cans</span>
                <span className="mb-3 ml-auto rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">Low stock</span>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl bg-slate-50 p-3"><p className="text-slate-500">Runs out</p><p className="font-semibold">Fri, in 2 days</p></div>
                <div className="rounded-xl bg-slate-50 p-3"><p className="text-slate-500">Avg use</p><p className="font-semibold">2 cans/day</p></div>
              </div>
              <div className="mt-4 rounded-xl bg-red-50 p-3 text-sm font-medium text-red-700">Order now — delivery takes 1 day.</div>
              <Button size="lg" className="mt-4 w-full">Order Water</Button>
            </div>
            <LogoMark className="absolute -right-6 -top-6 h-16 w-16 rotate-12 opacity-90" />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16">
        <h2 className="text-center text-3xl font-bold">Built for real water can deliveries</h2>
        <p className="mx-auto mt-2 max-w-2xl text-center text-muted-foreground">
          Fixes short deliveries, forgotten orders and messy month-end billing.
        </p>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="rounded-2xl border p-6">
              <f.icon className="h-8 w-8 text-primary" />
              <h3 className="mt-3 font-semibold">{f.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{f.text}</p>
            </div>
          ))}
        </div>
      </section>
      <footer className="border-t py-8 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} Waterdrop · <span className="tamil">{TAMIL_TAGLINE}</span>
      </footer>
    </div>
  );
}
