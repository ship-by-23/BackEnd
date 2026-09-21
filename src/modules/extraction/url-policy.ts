import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import type { Database } from "../../db/client.js";
import { blockedDomains } from "../../db/schema.js";
import { ExtractionError } from "./extraction.errors.js";

export type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export type ValidatedDestination = {
  url: URL;
  address: string;
  family: 4 | 6;
};

export type ResolveHostname = (hostname: string) => Promise<ResolvedAddress[]>;

export type DestinationPolicyOptions = {
  resolveHostname?: ResolveHostname;
  allowPrivateNetworks?: boolean;
  allowNonStandardPorts?: boolean;
};

function isIpv6(address: ipaddr.IPv4 | ipaddr.IPv6): address is ipaddr.IPv6 {
  return address.kind() === "ipv6";
}

function normalizedHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function normalizeArticleUrl(
  value: string,
  allowNonStandardPorts = false,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ExtractionError("URL_BLOCKED", "The URL is not valid.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ExtractionError(
      "URL_BLOCKED",
      "Only HTTP and HTTPS URLs are supported.",
    );
  }
  if (url.username || url.password) {
    throw new ExtractionError(
      "URL_BLOCKED",
      "URLs with embedded credentials are not supported.",
    );
  }
  if (!allowNonStandardPorts && url.port) {
    throw new ExtractionError(
      "URL_BLOCKED",
      "The URL uses an unsupported port.",
    );
  }

  if (url.hostname.endsWith(".") && !url.hostname.endsWith("].")) {
    url.hostname = url.hostname.slice(0, -1);
  }
  url.hash = "";
  return url;
}

export function isPublicAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(normalizedHostname(address));
  } catch {
    return false;
  }

  if (isIpv6(parsed) && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }
  return parsed.range() === "unicast";
}

async function defaultResolver(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = await lookup(normalizedHostname(hostname), {
    all: true,
    verbatim: true,
  });
  return addresses.flatMap(({ address, family }) =>
    family === 4 || family === 6 ? [{ address, family }] : [],
  );
}

export function createDestinationPolicy(
  database: Database,
  options: DestinationPolicyOptions = {},
): (url: URL) => Promise<ValidatedDestination> {
  const resolveHostname = options.resolveHostname ?? defaultResolver;

  return async (url) => {
    const normalizedUrl = normalizeArticleUrl(
      url.toString(),
      options.allowNonStandardPorts,
    );
    const hostname = normalizedHostname(normalizedUrl.hostname).toLowerCase();
    const rules = await database
      .select({
        hostname: blockedDomains.hostname,
        includeSubdomains: blockedDomains.includeSubdomains,
      })
      .from(blockedDomains);
    const blocked = rules.some(
      (rule) =>
        hostname === rule.hostname ||
        (rule.includeSubdomains && hostname.endsWith(`.${rule.hostname}`)),
    );
    if (blocked)
      throw new ExtractionError("URL_BLOCKED", "The destination is blocked.");

    let addresses: ResolvedAddress[];
    try {
      addresses = await resolveHostname(hostname);
    } catch {
      throw new ExtractionError(
        "EXTRACTION_FAILED",
        "The destination could not be resolved.",
      );
    }
    if (addresses.length === 0) {
      throw new ExtractionError(
        "EXTRACTION_FAILED",
        "The destination could not be resolved.",
      );
    }
    if (
      !options.allowPrivateNetworks &&
      addresses.some(({ address }) => !isPublicAddress(address))
    ) {
      throw new ExtractionError(
        "URL_BLOCKED",
        "The destination resolves to a blocked network.",
      );
    }

    const destination = addresses[0];
    if (!destination) {
      throw new ExtractionError(
        "EXTRACTION_FAILED",
        "The destination could not be resolved.",
      );
    }
    return { url: normalizedUrl, ...destination };
  };
}
