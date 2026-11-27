// Cashfree Payment Gateway (PG API version 2023-08-01).
// Keys come only from Edge Function secrets: CASHFREE_APP_ID, CASHFREE_SECRET_KEY, CASHFREE_ENV (sandbox | production).

export const CF_API_VERSION = "2023-08-01";

export interface CashfreeConfig { appId: string; secret: string; env: "sandbox" | "production" }

export function cashfreeConfig(get: (k: string) => string | undefined): CashfreeConfig | null {
  const appId = get("CASHFREE_APP_ID")?.trim();
  const secret = get("CASHFREE_SECRET_KEY")?.trim();
  if (!appId || !secret) return null;
  return { appId, secret, env: get("CASHFREE_ENV")?.trim() === "production" ? "production" : "sandbox" };
}

export const cfBase = (c: CashfreeConfig) => (c.env === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg");

const headers = (c: CashfreeConfig) => ({
  "x-client-id": c.appId, "x-client-secret": c.secret, "x-api-version": CF_API_VERSION, "Content-Type": "application/json",
});

/** Cashfree wants a 10-digit Indian mobile number. */
export function cfPhone(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "9999999999";
}

export async function createOrder(c: CashfreeConfig, o: {
  orderId: string; amount: number; customerId: string; phone: string; email?: string | null; name?: string;
  returnUrl: string; notifyUrl: string; note?: string;
}): Promise<{ payment_session_id: string; order_id: string }> {
  const res = await fetch(`${cfBase(c)}/orders`, {
    method: "POST", headers: headers(c),
    body: JSON.stringify({
      order_id: o.orderId, order_amount: Number(o.amount.toFixed(2)), order_currency: "INR",
      customer_details: { customer_id: o.customerId, customer_phone: cfPhone(o.phone), customer_email: o.email || undefined, customer_name: o.name },
      order_meta: { return_url: o.returnUrl, notify_url: o.notifyUrl },
      order_note: o.note,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.payment_session_id) throw new Error(`cashfree create order ${res.status}: ${data.message ?? ""}`);
  return data;
}

export async function getOrder(c: CashfreeConfig, orderId: string): Promise<{ order_status: string; order_amount: number; cf_order_id?: string }> {
  const res = await fetch(`${cfBase(c)}/orders/${encodeURIComponent(orderId)}`, { headers: headers(c) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`cashfree get order ${res.status}: ${data.message ?? ""}`);
  return data;
}

/** Webhook signature: base64(HMAC-SHA256(secret, timestamp + raw body)). */
export async function verifyCashfreeSignature(rawBody: string, timestamp: string | null, signature: string | null, secret: string): Promise<boolean> {
  if (!timestamp || !signature || !secret) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(timestamp + rawBody)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

/** Pulls the order id out of a Cashfree payment webhook. */
export function webhookOrderId(body: unknown): string | null {
  const b = body as { data?: { order?: { order_id?: string } } };
  return b?.data?.order?.order_id ?? null;
}
