import { describe, expect, it } from "vitest";
import { directionsUrl, formatAccuracy } from "./location";

describe("location helpers", () => {
  it("builds a Google Maps directions link", () => {
    expect(directionsUrl(13.0850123, 80.2101)).toBe("https://www.google.com/maps/dir/?api=1&destination=13.085012,80.210100");
  });
  it("formats accuracy", () => {
    expect(formatAccuracy(12.4)).toBe("±12 m");
    expect(formatAccuracy(2500)).toBe("±2.5 km");
    expect(formatAccuracy(null)).toBe("");
  });
});
