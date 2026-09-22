import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArticleFetcher } from "./article-fetcher.js";
import { ExtractionError } from "./extraction.errors.js";

describe("ArticleFetcher", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/article" }).end();
        return;
      }
      if (request.url === "/loop") {
        response.writeHead(302, { location: "/loop" }).end();
        return;
      }
      if (request.url === "/blocked-redirect") {
        response
          .writeHead(302, { location: "http://blocked.test/article" })
          .end();
        return;
      }
      if (request.url === "/large") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("x".repeat(2_000));
        return;
      }
      if (request.url === "/json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      if (request.url === "/slow") {
        setTimeout(() => {
          response.writeHead(200, { "content-type": "text/html" });
          response.end("<article>slow</article>");
        }, 200);
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<article><h1>Fixture</h1><p>Readable fixture</p></article>",
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected fixture server address");
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function fetcher(
    overrides: {
      timeout?: number;
      maxBytes?: number;
      maxRedirects?: number;
    } = {},
  ) {
    return new ArticleFetcher(
      {
        EXTRACTION_TIMEOUT_MS: overrides.timeout ?? 1_000,
        EXTRACTION_MAX_BYTES: overrides.maxBytes ?? 1_000,
        EXTRACTION_MAX_REDIRECTS: overrides.maxRedirects ?? 2,
      },
      (url) => {
        if (url.hostname === "blocked.test") {
          return Promise.reject(
            new ExtractionError("URL_BLOCKED", "Blocked test destination"),
          );
        }
        return Promise.resolve({ url, address: "127.0.0.1", family: 4 });
      },
    );
  }

  function fixtureUrl(path: string): URL {
    return new URL(`http://fixture.test:${String(port)}${path}`);
  }

  it("pins the destination and follows a validated redirect", async () => {
    const page = await fetcher().fetch(fixtureUrl("/redirect"));
    expect(page.finalUrl.pathname).toBe("/article");
    expect(page.html).toContain("Readable fixture");
  });

  it("revalidates redirect destinations", async () => {
    await expect(
      fetcher().fetch(fixtureUrl("/blocked-redirect")),
    ).rejects.toMatchObject({
      code: "URL_BLOCKED",
    });
  });

  it("rejects redirect loops, unsupported content, oversized bodies, and timeouts", async () => {
    await expect(
      fetcher({ maxRedirects: 1 }).fetch(fixtureUrl("/loop")),
    ).rejects.toMatchObject({
      code: "EXTRACTION_FAILED",
    });
    await expect(fetcher().fetch(fixtureUrl("/json"))).rejects.toMatchObject({
      code: "UNSUPPORTED_CONTENT",
    });
    await expect(
      fetcher({ maxBytes: 100 }).fetch(fixtureUrl("/large")),
    ).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
    await expect(
      fetcher({ timeout: 50 }).fetch(fixtureUrl("/slow")),
    ).rejects.toMatchObject({
      code: "FETCH_TIMEOUT",
    });
  });
});
