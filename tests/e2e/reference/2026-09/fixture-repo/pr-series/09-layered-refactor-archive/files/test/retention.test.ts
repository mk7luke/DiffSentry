import { describe, expect, it } from "vitest";
import { isWithinRetention } from "../src/retention.js";

describe("isWithinRetention", () => {
  it("is true well within the window", () => {
    expect(isWithinRetention(1000, 1500, 60_000)).toBe(true);
  });

  it("is false once the window has fully elapsed", () => {
    expect(isWithinRetention(1000, 100_000, 60_000)).toBe(false);
  });

  it("is false exactly at the boundary", () => {
    expect(isWithinRetention(0, 1000, 1000)).toBe(false);
  });
});
