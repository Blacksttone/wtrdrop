import { cn } from "@/lib/utils";

/** Waterdrop mark: a droplet with a highlight and a ripple line. */
export function LogoMark({ className, title = "Waterdrop" }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={cn("h-8 w-8", className)} role="img" aria-label={title}>
      <defs>
        <linearGradient id="wd-drop" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#38bdf8" />
          <stop offset="1" stopColor="#0b5cad" />
        </linearGradient>
      </defs>
      <path d="M24 3C24 3 8 21.5 8 31.5a16 16 0 0 0 32 0C40 21.5 24 3 24 3Z" fill="url(#wd-drop)" />
      <path d="M16.5 32a7.5 7.5 0 0 0 7.5 7.5" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" fill="none" opacity="0.9" />
      <ellipse cx="19" cy="22" rx="2.2" ry="3.4" fill="#fff" opacity="0.35" transform="rotate(25 19 22)" />
    </svg>
  );
}

export function Logo({ className, size = "md", light = false }: { className?: string; size?: "sm" | "md" | "lg"; light?: boolean }) {
  const dims = { sm: "h-7 w-7", md: "h-9 w-9", lg: "h-14 w-14" }[size];
  const text = { sm: "text-lg", md: "text-xl", lg: "text-3xl" }[size];
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark className={dims} />
      <span className={cn("font-extrabold tracking-tight", text, light ? "text-white" : "text-slate-900")}>
        Water<span className={light ? "text-sky-200" : "text-primary"}>drop</span>
      </span>
    </span>
  );
}

export const TAGLINE = "Never Run Out of Water.";
export const TAMIL_TAGLINE = "தண்ணீர் தீரும் முன் Waterdrop!";
