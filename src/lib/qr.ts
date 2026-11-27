/**
 * Understands every QR / text a supplier can share:
 *   https://<site>/join/<invite-token>
 *   https://<site>/join?code=ABCD2345
 *   ABCD2345            (plain supplier code)
 */
export type SupplierQr = { token: string } | { code: string };

export function parseSupplierQr(raw: string): SupplierQr | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    const code = url.searchParams.get("code");
    if (code && /^[A-Za-z0-9]{6,10}$/.test(code)) return { code: code.toUpperCase() };
    const m = url.pathname.match(/\/join\/([A-Za-z0-9]{16,64})\/?$/);
    if (m) return { token: m[1] };
    return null;
  } catch {
    // not a URL
  }
  return /^[A-Za-z0-9]{6,10}$/.test(text) ? { code: text.toUpperCase() } : null;
}

/**
 * Family / team invite QR: https://<site>/onboarding/customer?family=ABCD2345
 * (a plain 8-letter code is accepted too, when typed or scanned from text).
 */
export function familyInviteUrl(site: string, code: string) {
  return `${site.replace(/\/$/, "")}/onboarding/customer?family=${encodeURIComponent(code)}`;
}

export function parseFamilyQr(raw: string): string | null {
  const text = raw.trim();
  const ok = (c: string | null) => (c && /^[A-Za-z0-9]{8}$/.test(c) ? c.toUpperCase() : null);
  try {
    return ok(new URL(text).searchParams.get("family"));
  } catch {
    return ok(text);
  }
}
