import { describe, expect, it } from "vitest";
import { isPublicAddress, normalizeArticleUrl } from "./url-policy.js";

describe("URL normalization", () => {
  it("normalizes host casing, default ports, and fragments", () => {
    expect(
      normalizeArticleUrl(
        "HTTPS://Example.COM:443/path?q=1#section",
      ).toString(),
    ).toBe("https://example.com/path?q=1");
  });

  it.each([
    "ftp://example.com/file",
    "http://user:password@example.com",
    "http://example.com:8080",
    "not a url",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => normalizeArticleUrl(url)).toThrow();
  });
});

describe("IP policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.1.1",
    "100.64.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "224.0.0.1",
    "0.0.0.0",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
  expect(normalizeArticleUrl("https://example.com./article").hostname).toBe(
    "example.com",
  );
});
