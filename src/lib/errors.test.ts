import { describe, expect, it } from "vitest";
import { errorMessage } from "./errors";

describe("errorMessage", () => {
  it("explains email problems in plain words", () => {
    expect(errorMessage({ message: "Error sending confirmation email" })).toMatch(/couldn't send the verification email/);
    expect(errorMessage({ message: "email rate limit exceeded" })).toMatch(/try again in an hour/);
    expect(errorMessage({ message: "For security purposes, you can only request this after 42 seconds." })).toMatch(/wait a minute/);
    expect(errorMessage({ message: "Email not confirmed" })).toMatch(/confirmation email/);
  });
  it("falls back to the original message", () => {
    expect(errorMessage({ message: "Something odd" })).toBe("Something odd");
    expect(errorMessage(null)).toBe("Something went wrong");
  });
});
