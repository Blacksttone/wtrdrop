import { describe, expect, it } from "vitest";
import { parseSupplierQr } from "./qr";

describe("supplier QR parsing", () => {
  it("reads supplier code links", () => {
    expect(parseSupplierQr("https://wtrdrop.example.dev/join?code=w9bpzkdf")).toEqual({ code: "W9BPZKDF" });
  });
  it("reads private invite links", () => {
    expect(parseSupplierQr("https://wtrdrop.example.dev/join/0123456789abcdef0123456789abcdef")).toEqual({
      token: "0123456789abcdef0123456789abcdef",
    });
  });
  it("reads a plain code", () => {
    expect(parseSupplierQr("  abcd2345 ")).toEqual({ code: "ABCD2345" });
  });
  it("rejects unrelated QR codes", () => {
    expect(parseSupplierQr("https://example.com/menu")).toBeNull();
    expect(parseSupplierQr("upi://pay?pa=x@upi")).toBeNull();
    expect(parseSupplierQr("hello world")).toBeNull();
  });
});

import { suggestedDailyCans } from "./household";
describe("household usage suggestion", () => {
  it("suggests about one can per four people", () => {
    expect(suggestedDailyCans(1)).toBe(1);
    expect(suggestedDailyCans(4)).toBe(1);
    expect(suggestedDailyCans(8)).toBe(2);
    expect(suggestedDailyCans(0)).toBe(0);
  });
});

import { familyInviteUrl, parseFamilyQr } from "./qr";

describe("family invite QR", () => {
  it("round-trips the invite link", () => {
    const url = familyInviteUrl("https://waterdrop.example/", "k7m2qx9p");
    expect(url).toBe("https://waterdrop.example/onboarding/customer?family=k7m2qx9p");
    expect(parseFamilyQr(url)).toBe("K7M2QX9P");
  });
  it("accepts a plain code and rejects others", () => {
    expect(parseFamilyQr(" abcd2345 ")).toBe("ABCD2345");
    expect(parseFamilyQr("https://x.in/join?code=ABCD2345")).toBeNull();
    expect(parseFamilyQr("hello")).toBeNull();
  });
  it("is not mistaken for a supplier code", () => {
    expect(parseSupplierQr(familyInviteUrl("https://x.in", "ABCD2345"))).toBeNull();
  });
});
