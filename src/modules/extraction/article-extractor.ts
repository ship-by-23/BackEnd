import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import sanitizeHtml from "sanitize-html";
import { ExtractionError } from "./extraction.errors.js";
import { normalizeArticleUrl } from "./url-policy.js";

export type ExtractedArticle = {
  canonicalUrl: string;
  title: string;
  description: string | null;
  siteName: string | null;
  author: string | null;
  publishedAt: Date | null;
  imageUrl: string | null;
  contentHtml: string;
  contentText: string;
  wordCount: number;
  estimatedReadingMinutes: number;
};

const allowedTags = [
  "a",
  "abbr",
  "blockquote",
  "br",
  "code",
  "del",
  "div",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "section",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
];

function meta(document: Document, selectors: string[]): string | null {
  for (const selector of selectors) {
    const content = document
      .querySelector<HTMLMetaElement>(selector)
      ?.content.trim();
    if (content) return content;
  }
  return null;
}

function optionalUrl(value: string | null, baseUrl: URL): string | null {
  if (!value) return null;
  try {
    return normalizeArticleUrl(
      new URL(value, baseUrl).toString(),
      true,
    ).toString();
  } catch {
    return null;
  }
}

function optionalDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (trimmed === "") return null;
  return trimmed ?? null;
}

export function extractArticle(html: string, finalUrl: URL): ExtractedArticle {
  const dom = new JSDOM(html, { url: finalUrl.toString() });
  const sourceDocument = dom.window.document;
  const canonicalUrl =
    optionalUrl(
      sourceDocument.querySelector<HTMLLinkElement>('link[rel="canonical"]')
        ?.href ?? meta(sourceDocument, ['meta[property="og:url"]']),
      finalUrl,
    ) ?? finalUrl.toString();
  const description = meta(sourceDocument, [
    'meta[name="description"]',
    'meta[property="og:description"]',
  ]);
  const imageUrl = optionalUrl(
    meta(sourceDocument, [
      'meta[property="og:image"]',
      'meta[name="twitter:image"]',
    ]),
    finalUrl,
  );
  const publishedAt = optionalDate(
    meta(sourceDocument, [
      'meta[property="article:published_time"]',
      'meta[name="date"]',
      'meta[name="pubdate"]',
    ]),
  );
  const article = new Readability(
    sourceDocument.cloneNode(true) as Document,
  ).parse();
  if (
    !article?.content ||
    !article.textContent?.trim() ||
    !article.title?.trim()
  ) {
    throw new ExtractionError(
      "EXTRACTION_FAILED",
      "Readable article content could not be extracted.",
    );
  }

  const contentHtml = sanitizeHtml(article.content, {
    allowedTags,
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title", "width", "height", "loading"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan", "scope"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https"] },
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", {
        rel: "nofollow noopener noreferrer",
      }),
    },
  });
  const contentText = new JSDOM(contentHtml).window.document.body.textContent
    .replace(/\s+/gu, " ")
    .trim();
  if (!contentText) {
    throw new ExtractionError(
      "EXTRACTION_FAILED",
      "Readable article content could not be extracted.",
    );
  }
  const wordCount =
    contentText.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;

  return {
    canonicalUrl,
    title: article.title.trim(),
    description: description ?? article.excerpt?.trim() ?? null,
    siteName: trimmedOrNull(article.siteName),
    author: trimmedOrNull(article.byline),
    publishedAt,
    imageUrl,
    contentHtml,
    contentText,
    wordCount,
    estimatedReadingMinutes: Math.max(1, Math.ceil(wordCount / 200)),
  };
}
