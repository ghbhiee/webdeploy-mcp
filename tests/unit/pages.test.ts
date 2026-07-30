import { describe, expect, it } from "vitest";
import {
  assertSafePagePath,
  isValidPageSlug,
  pageSafeChild,
  pageSitePublicUrl,
  slugifyPageName,
} from "../../packages/core/src/pages";

describe("pages path and slug safety", () => {
  it.each(["site", "my-page-1", "a", "0abc"])("accepts slug %s", (slug) => {
    expect(isValidPageSlug(slug)).toBe(true);
  });

  it.each(["", "-lead", "trail-", "UPPER", "with.dot", "a/b", "a".repeat(49)])(
    "rejects slug %s",
    (slug) => expect(isValidPageSlug(slug)).toBe(false),
  );

  it("slugifies display names", () => {
    expect(slugifyPageName("My Report (2026)!")).toBe("my-report-2026");
    expect(slugifyPageName("--")).toBe("");
  });

  it("normalizes safe file paths", () => {
    expect(assertSafePagePath("./reports/index.html")).toBe("reports/index.html");
    expect(assertSafePagePath("a\\b\\c.txt")).toBe("a/b/c.txt");
    expect(assertSafePagePath("dir/")).toBe("dir");
  });

  it.each(["", "/etc/passwd", "../up", "ok/../../bad", "C:\\x", "a//b", "a/./b", "nul\0"])(
    "rejects unsafe file path %s",
    (path) => expect(() => assertSafePagePath(path)).toThrow(),
  );

  it("keeps resolved paths below the pages root", () => {
    expect(pageSafeChild("/data/pages", "site", "index.html")).toBe("/data/pages/site/index.html");
    expect(() => pageSafeChild("/data/pages", "..", "outside")).toThrow(/escapes/);
  });

  it("builds public site URLs below the installation path", () => {
    expect(pageSitePublicUrl("https://host.example/webdeploy", "demo")).toBe(
      "https://host.example/webdeploy/pages/demo/",
    );
    expect(pageSitePublicUrl("https://host.example/", "demo")).toBe(
      "https://host.example/pages/demo/",
    );
  });
});
