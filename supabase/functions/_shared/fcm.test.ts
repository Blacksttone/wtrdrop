import { describe, expect, it } from "vitest";
import { buildMessage, channelFor, readServiceAccount, sendPush, signServiceJwt } from "./fcm";

describe("fcm", () => {
  it("reads only complete service accounts", () => {
    expect(readServiceAccount(undefined)).toBeNull();
    expect(readServiceAccount("not json")).toBeNull();
    expect(readServiceAccount('{"project_id":"p"}')).toBeNull();
    expect(readServiceAccount('{"project_id":"p","client_email":"a@b","private_key":"k"}')?.project_id).toBe("p");
  });
  it("routes orders to the loud channel", () => {
    expect(channelFor("new_order", "info")).toBe("orders");
    expect(channelFor("bill_generated", "info")).toBe("general");
    expect(channelFor("low_stock", "critical")).toBe("orders");
  });
  it("builds an FCM v1 message", () => {
    const m = buildMessage("tok", { title: "New order", message: "3 cans", link: "/supplier/orders", notification_type: "new_order", severity: "info" });
    expect(m.message.android.priority).toBe("HIGH");
    expect(m.message.data.link).toBe("/supplier/orders");
    expect(m.message.android.notification.channel_id).toBe("orders");
  });
  it("signs a verifiable RS256 JWT", async () => {
    const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
    const jwt = await signServiceJwt({ project_id: "p", client_email: "svc@p.iam.gserviceaccount.com", private_key: pem }, 1000);
    const [h, c, s] = jwt.split(".");
    const dec = (x: string) => Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", kp.publicKey, dec(s), new TextEncoder().encode(`${h}.${c}`));
    expect(ok).toBe(true);
    const claims = JSON.parse(new TextDecoder().decode(dec(c)));
    expect(claims).toMatchObject({ iss: "svc@p.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/firebase.messaging", iat: 1000, exp: 4600 });
  });
  it("drops tokens from another Firebase project", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => String(url).includes("oauth2")
      ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }))
      : new Response('{"error":{"code":403,"details":[{"errorCode":"SENDER_ID_MISMATCH"}]}}', { status: 403 })) as typeof fetch;
    try {
      const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]);
      const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
      const sa = { project_id: "p", client_email: "a@p", private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----` };
      const m = buildMessage("tok", { title: "t", message: "m", link: null, notification_type: "new_order", severity: "info" });
      expect(await sendPush(sa, m)).toBe("invalid");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
