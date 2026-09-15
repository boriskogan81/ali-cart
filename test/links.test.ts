import { describe, expect, it } from "vitest";
import { classifyUrl, redirectFromHtml } from "../src/links.js";

describe("classifyUrl", () => {
  it("recognises item pages", () => {
    expect(classifyUrl("https://www.aliexpress.com/item/4001320190567.html")).toMatchObject({ kind: "item", itemId: "4001320190567" });
    expect(classifyUrl("https://he.aliexpress.com/item/1005009737753210.html?x=1")).toMatchObject({ kind: "item", itemId: "1005009737753210" });
  });
  it("turns wholesale/af slugs into queries", () => {
    expect(classifyUrl("https://www.aliexpress.com/w/wholesale-holybro-kakute-tekko32-65a-stack.html")).toMatchObject({
      kind: "search",
      query: "holybro kakute tekko32 65a stack",
    });
    expect(classifyUrl("https://he.aliexpress.com/w/wholesale-source-one-v5-frame.html?aff=1")).toMatchObject({ kind: "search", query: "source one v5 frame" });
    expect(classifyUrl("https://www.aliexpress.com/af/emax-eco-ii-2207-motor.html")).toMatchObject({ kind: "search", query: "emax eco ii 2207 motor" });
  });
  it("reads SearchText from the legacy search url", () => {
    expect(classifyUrl("https://www.aliexpress.com/wholesale?catId=0&SearchText=source+one+v5+frame")).toMatchObject({
      kind: "search",
      query: "source one v5 frame",
    });
  });
  it("flags non-aliexpress links as external", () => {
    expect(classifyUrl("https://betaflight.com")).toMatchObject({ kind: "external" });
  });
});

describe("redirectFromHtml", () => {
  it("finds meta refresh and script redirects", () => {
    expect(redirectFromHtml('<meta http-equiv="refresh" content="0;url=https://www.aliexpress.com/item/1.html">')).toBe("https://www.aliexpress.com/item/1.html");
    expect(redirectFromHtml('<script>window.location.href = "https://www.aliexpress.com/w/wholesale-x.html";</script>')).toBe("https://www.aliexpress.com/w/wholesale-x.html");
    expect(redirectFromHtml("<html><body>nothing</body></html>")).toBeNull();
  });
});
