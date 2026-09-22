import { describe, expect, it } from "vitest";
import { extractArticle } from "./article-extractor.js";

describe("extractArticle", () => {
  it("extracts metadata and sanitizes hostile readable markup", () => {
    const article = extractArticle(
      `<!doctype html><html><head>
        <title>Readable title</title>
        <meta name="description" content="A useful description">
        <meta property="article:published_time" content="2026-01-02T03:04:05Z">
        <link rel="canonical" href="/canonical">
      </head><body><article>
        <h1>Readable title</h1>
        <p>${"Useful article sentence. ".repeat(30)}</p>
        <script>alert(1)</script>
        <p onclick="alert(2)">Safe paragraph</p>
        <a href="javascript:alert(3)">unsafe link</a>
        <iframe src="https://evil.example"></iframe>
        <form><input name="secret"></form>
      </article></body></html>`,
      new URL("https://example.com/article"),
    );

    expect(article.title).toBe("Readable title");
    expect(article.canonicalUrl).toBe("https://example.com/canonical");
    expect(article.description).toBe("A useful description");
    expect(article.wordCount).toBeGreaterThan(50);
    expect(article.contentHtml).not.toMatch(
      /script|onclick|javascript:|iframe|form|input/i,
    );
    expect(article.contentHtml).toContain("Safe paragraph");
  });
});
