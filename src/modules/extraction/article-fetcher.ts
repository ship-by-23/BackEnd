import { Agent, request } from "undici";
import type { AppConfig } from "../../config/env.js";
import { ExtractionError } from "./extraction.errors.js";
import type { ValidatedDestination } from "./url-policy.js";

type FetcherConfig = Pick<
  AppConfig,
  "EXTRACTION_TIMEOUT_MS" | "EXTRACTION_MAX_BYTES" | "EXTRACTION_MAX_REDIRECTS"
>;

export type FetchedPage = {
  finalUrl: URL;
  html: string;
};

type ValidateDestination = (url: URL) => Promise<ValidatedDestination>;

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function discardBody(body: {
  on(event: "error", listener: (error: Error) => void): unknown;
  destroy(): void;
}): void {
  body.on("error", () => undefined);
  body.destroy();
}

export class ArticleFetcher {
  constructor(
    private readonly config: FetcherConfig,
    private readonly validateDestination: ValidateDestination,
  ) {}

  async fetch(initialUrl: URL): Promise<FetchedPage> {
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      this.config.EXTRACTION_TIMEOUT_MS,
    );
    timeout.unref();

    try {
      let currentUrl = initialUrl;
      for (let redirectCount = 0; ; redirectCount += 1) {
        const destination = await this.validateDestination(currentUrl);
        const dispatcher = new Agent({
          connect: {
            lookup: (_hostname, _options, callback) => {
              callback(null, [
                { address: destination.address, family: destination.family },
              ]);
            },
          },
        });

        try {
          const response = await request(destination.url, {
            dispatcher,
            method: "GET",
            headersTimeout: this.config.EXTRACTION_TIMEOUT_MS,
            bodyTimeout: this.config.EXTRACTION_TIMEOUT_MS,
            signal: abortController.signal,
            headers: {
              accept: "text/html,application/xhtml+xml",
              "accept-encoding": "identity",
              "user-agent": "SimpanDulu/1.0 (+https://simpandulu.local)",
            },
          });

          if (response.statusCode >= 300 && response.statusCode < 400) {
            discardBody(response.body);
            const location = headerValue(response.headers.location);
            if (
              !location ||
              redirectCount >= this.config.EXTRACTION_MAX_REDIRECTS
            ) {
              throw new ExtractionError(
                "EXTRACTION_FAILED",
                "The destination redirected too many times.",
              );
            }
            currentUrl = new URL(location, destination.url);
            continue;
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            discardBody(response.body);
            throw new ExtractionError(
              "EXTRACTION_FAILED",
              "The destination returned an unsuccessful response.",
            );
          }

          const contentType =
            headerValue(response.headers["content-type"])?.toLowerCase() ?? "";
          if (
            !contentType.startsWith("text/html") &&
            !contentType.startsWith("application/xhtml+xml")
          ) {
            discardBody(response.body);
            throw new ExtractionError(
              "UNSUPPORTED_CONTENT",
              "The destination is not an HTML document.",
            );
          }
          const contentLength = Number(
            headerValue(response.headers["content-length"]),
          );
          if (
            Number.isFinite(contentLength) &&
            contentLength > this.config.EXTRACTION_MAX_BYTES
          ) {
            discardBody(response.body);
            throw new ExtractionError(
              "RESPONSE_TOO_LARGE",
              "The destination response is too large.",
            );
          }

          const chunks: Buffer[] = [];
          let bytes = 0;
          const responseBody: AsyncIterable<Uint8Array> = response.body;
          for await (const chunk of responseBody) {
            bytes += chunk.byteLength;
            if (bytes > this.config.EXTRACTION_MAX_BYTES) {
              discardBody(response.body);
              throw new ExtractionError(
                "RESPONSE_TOO_LARGE",
                "The destination response is too large.",
              );
            }
            chunks.push(Buffer.from(chunk));
          }
          return {
            finalUrl: destination.url,
            html: Buffer.concat(chunks).toString("utf8"),
          };
        } finally {
          await dispatcher.close();
        }
      }
    } catch (error) {
      if (error instanceof ExtractionError) throw error;
      if (abortController.signal.aborted) {
        throw new ExtractionError(
          "FETCH_TIMEOUT",
          "The destination did not respond in time.",
        );
      }
      throw new ExtractionError(
        "EXTRACTION_FAILED",
        "The destination could not be fetched.",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
