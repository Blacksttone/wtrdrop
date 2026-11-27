import { describe, expect, it } from "vitest";
import { cashfreeConfig, cfBase, cfPhone, verifyCashfreeSignature, webhookOrderId } from "./cashfree";

async function sign(secret: string, ts: string, body: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(ts + body)))));
}

describe("cashfree", () => {
  it("reads config and picks the environment", () => {
    expect(cashfreeConfig(() => undefined)).toBeNull();
    const env: Record<string, string> = { CASHFREE_APP_ID: " id ", CASHFREE_SECRET_KEY: "s" };
    expect(cashfreeConfig((k) => env[k])).toEqual({ appId: "id", secret: "s", env: "sandbox" });
    env.CASHFREE_ENV = "production";
    expect(cfBase(cashfreeConfig((k) => env[k])!)).toBe("https://api.cashfree.com/pg");
  });
  it("normalises phone numbers", () => {
    expect(cfPhone("+91 98765 43210")).toBe("9876543210");
    expect(cfPhone(null)).toBe("9999999999");
  });
  it("accepts only correctly signed webhooks", async () => {
    const body = JSON.stringify({ data: { order: { order_id: "wdp_abc123" } }, type: "PAYMENT_SUCCESS_WEBHOOK" });
    const sig = await sign("secret", "1700000000", body);
    expect(await verifyCashfreeSignature(body, "1700000000", sig, "secret")).toBe(true);
    expect(await verifyCashfreeSignature(body + " ", "1700000000", sig, "secret")).toBe(false);
    expect(await verifyCashfreeSignature(body, "1700000001", sig, "secret")).toBe(false);
    expect(await verifyCashfreeSignature(body, "1700000000", sig, "other")).toBe(false);
    expect(await verifyCashfreeSignature(body, null, sig, "secret")).toBe(false);
    expect(webhookOrderId(JSON.parse(body))).toBe("wdp_abc123");
  });
});
