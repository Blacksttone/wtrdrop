import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseRazorpayEvent, safeEqual, verifyRazorpayWebhook } from "./crypto";

describe("payment webhook verification", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 48000, status: "captured" } } } });
  const good = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a correctly signed payload", async () => {
    expect(await verifyRazorpayWebhook(body, good, secret)).toBe(true);
  });
  it("rejects tampered payloads, wrong secrets and missing signatures", async () => {
    expect(await verifyRazorpayWebhook(body.replace("48000", "1"), good, secret)).toBe(false);
    expect(await verifyRazorpayWebhook(body, good, "other")).toBe(false);
    expect(await verifyRazorpayWebhook(body, null, secret)).toBe(false);
    expect(await verifyRazorpayWebhook(body, good, "")).toBe(false);
  });
  it("parses amount in rupees from paise", () => {
    expect(parseRazorpayEvent(JSON.parse(body))).toMatchObject({ event: "payment.captured", orderId: "order_1", paymentId: "pay_1", amountRupees: 480 });
  });
  it("compares in constant time", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "ab")).toBe(false);
  });
});
