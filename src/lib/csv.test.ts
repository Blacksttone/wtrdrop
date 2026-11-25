import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";

describe("csv export", () => {
  it("escapes quotes, commas and newlines", () => {
    expect(toCsv(["a", "b"], [["x,y", 'say "hi"'], ["line\nbreak", 3]])).toBe('a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",3');
  });
  it("neutralises spreadsheet formulas but keeps negative numbers", () => {
    expect(toCsv(["v"], [["=HYPERLINK(1)"], ["-5"], ["@cmd"]])).toBe("v\r\n'=HYPERLINK(1)\r\n-5\r\n'@cmd");
  });
});
