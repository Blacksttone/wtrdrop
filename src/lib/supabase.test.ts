import { describe, expect, it } from "vitest";
import { cleanConfigValue } from "./supabase";

describe("cleanConfigValue", () => {
  it("strips invisible and smart characters from pasted keys", () => {
    expect(cleanConfigValue("​eyJabc.def \n")).toBe("eyJabc.def");
    expect(cleanConfigValue("“https://x.supabase.co”")).toBe("https://x.supabase.co");
    expect(cleanConfigValue('"eyJ.a.b"')).toBe("eyJ.a.b");
    expect(cleanConfigValue("  ")).toBeUndefined();
    expect(cleanConfigValue(undefined)).toBeUndefined();
  });
  it("leaves clean values unchanged", () => {
    expect(cleanConfigValue("https://abc.supabase.co")).toBe("https://abc.supabase.co");
  });
});
