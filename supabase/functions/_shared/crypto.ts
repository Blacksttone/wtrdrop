// Pure Web Crypto helpers (work in Deno, browsers and Node ≥ 18; unit-tested with Vitest).

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison to avoid timing attacks on signatures/secrets. */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Razorpay webhook: X-Razorpay-Signature = HMAC_SHA256(raw body, webhook secret). */
export async function verifyRazorpayWebhook(rawBody: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  return safeEqual(await hmacSha256Hex(secret, rawBody), signature);
}

export interface RazorpayPaymentEvent {
  event: string;
  orderId: string | null;
  paymentId: string | null;
  amountRupees: number | null;
  status: string | null;
  reason: string | null;
}

export function parseRazorpayEvent(body: unknown): RazorpayPaymentEvent {
  const b = body as {
    event?: string;
    payload?: {
      payment?: { entity?: { id?: string; order_id?: string; amount?: number; status?: string; error_description?: string } };
      order?: { entity?: { id?: string; amount_paid?: number } };
    };
  };
  const p = b?.payload?.payment?.entity;
  const o = b?.payload?.order?.entity;
  const paise = p?.amount ?? o?.amount_paid ?? null;
  return {
    event: b?.event ?? "",
    orderId: p?.order_id ?? o?.id ?? null,
    paymentId: p?.id ?? null,
    amountRupees: paise == null ? null : Math.round(paise) / 100,
    status: p?.status ?? null,
    reason: p?.error_description ?? null,
  };
}
