# Product Requirements Document SimpanDulu

Language: English. Bahasa Indonesia version: [SimpanDulu PRD ID](./SimpanDulu_PRD_ID.md).

## Document Status

- Product: SimpanDulu
- Version: 1.0 consolidated draft
- Audience: product, design, frontend, backend, and QA
- Source: project proposal and 32 page-level frontend PRDs
- Purpose: provide one authoritative product definition and implementation contract

This document replaces the page-by-page PRDs as the product source of truth. Figma remains the visual reference. When a page-level file conflicts with this document, this document takes precedence.

## 1 Product Summary

SimpanDulu is a private read-it-later web application for students and digital professionals. A user saves a URL, and SimpanDulu retrieves the page, extracts its metadata and readable content, and stores a clean copy in the user's library. The user can then read the article inside the application, track reading progress, organize it with tags, create highlights and notes, and find it again through full-text search.

The product addresses four recurring problems:

1. Saved links lose their context and become difficult to rediscover.
2. Browser bookmarks preserve an address but not the article content.
3. Users cannot reliably track what is unread, in progress, or finished.
4. Searching by title alone does not find concepts mentioned inside an article.

## 2 Product Goals

The MVP must allow a user to:

- create and secure a personal account;
- save an article from a public HTTP or HTTPS URL;
- see whether extraction is pending, successful, or failed;
- retain a sanitized readable copy of the article;
- browse, filter, sort, favorite, archive, and tag saved articles;
- read an article in light or dark mode and resume from the last position;
- mark an article as unread, reading, or finished;
- highlight article text and attach a note;
- search article titles, descriptions, and extracted text;
- save the current browser page through a bookmarklet flow.

## 3 Non Goals for MVP

The following are outside the MVP unless the team explicitly approves a scope change:

- social feeds, public profiles, sharing, comments, or collaborative libraries;
- AI summaries, recommendations, embeddings, or semantic search;
- browser extensions or native mobile applications;
- offline synchronization across devices;
- importing entire bookmark archives;
- subscriptions, billing, or paid plans;
- Elasticsearch or an external search service;
- per-device session management UI;
- Collections.

Collections appeared in several page-level PRDs but are not part of the original approved project scope. Tags already cover MVP organization. Collections may be reconsidered after the MVP is complete.

## 4 Users and Access

### 4.1 User

A user can access and modify only their own profile, articles, tags, reading progress, highlights, and notes. Ownership must be enforced by the backend on every request and must not depend on frontend filtering.

### 4.2 Administrator

An administrator can manage blocked domains and may activate or deactivate user accounts. An administrator does not automatically receive access to private article content.

## 5 Core Product Rules

- All saved content is private to its owner.
- A normalized URL may be saved once per user. Saving it again returns the existing article instead of creating an invisible duplicate.
- Article status is one of `unread`, `reading`, or `finished`.
- A new successfully extracted article starts as `unread`.
- Opening or progressing an unread article changes it to `reading`.
- Marking an article finished sets its progress to 100 percent.
- Favorite and archive are independent flags. Archiving does not delete content.
- Deleting an article also deletes its tag associations, highlights, notes, and extraction records.
- Tag names are unique per user after trimming and case normalization.
- Reader theme is a presentation preference, not a separate page or article record.
- Extraction failure must not silently discard the submitted URL. The failed record remains visible with a reason and retry action.

## 6 Primary User Flows

### 6.1 Registration and Login

1. A visitor registers with name, email, password, and password confirmation.
2. The system validates the input and creates the account.
3. The user signs in and is redirected to the library.
4. Protected routes redirect an unauthenticated visitor to login and preserve the intended destination.
5. Logout invalidates the active refresh session.

### 6.2 Save and Extract an Article

1. The user submits a URL and optional tags.
2. The frontend performs basic URL validation; the backend performs authoritative security validation.
3. The API creates an article with extraction status `pending` and returns immediately.
4. The extraction worker fetches the page, follows only validated redirects, and accepts an HTML response within configured size and time limits.
5. The system extracts canonical URL, title, description, site name, author when available, publication date when available, image, readable HTML, and plain text.
6. The system sanitizes readable HTML, calculates word count and estimated reading time, updates the full-text search vector, and marks extraction `completed`.
7. If extraction fails, the system marks it `failed`, stores a safe error code, and allows a retry.

### 6.3 Browse and Manage the Library

1. The user opens the library.
2. The user may switch between grid and list presentation without changing the underlying route or dataset.
3. The user may filter by reading status, tag, favorite, and archive state.
4. The user may sort by saved date, updated date, title, or reading progress.
5. Filter, sort, view, and pagination state are represented in URL search parameters when useful.
6. Quick actions update favorite, archive, reading status, or tags without a full page reload.

### 6.4 Search

1. The user enters a search query.
2. Search matches title, description, and extracted article text.
3. Results are ranked with title matches weighted above body matches.
4. Each result may show a safe highlighted snippet.
5. Search supports the same status, tag, favorite, and archive filters as the library.
6. An empty query returns the normal library view rather than executing an unrestricted full-text query.

### 6.5 Read and Resume

1. The user opens a completed article.
2. The reader renders sanitized readable HTML using the application typography.
3. The reader restores the last recorded position.
4. Progress is saved at a throttled interval and when the reader closes or loses visibility.
5. The user may change theme and typography preferences without changing the article URL.
6. The user may open the original source in a new tab.

### 6.6 Highlight and Note

1. The user selects text in the reader.
2. The user creates a highlight and optionally enters a note.
3. The application stores the selected quote and enough surrounding context to relocate it after rendering changes.
4. The user can edit or delete the note and browse all highlights from a single highlights page.

### 6.7 Bookmarklet

1. The user installs the bookmarklet from settings.
2. Activating it opens the SimpanDulu save route with the current page URL prefilled.
3. The user confirms the save while authenticated in SimpanDulu.
4. The bookmarklet must not contain a long-lived access token or password.

## 7 Information Architecture and Routes

Visual variants and filters are states of a page, not separate products or duplicate implementation routes.

### 7.1 Public Routes

| Route | Purpose |
| --- | --- |
| `/` | Product landing page |
| `/login` | Existing-user authentication |
| `/register` | Account creation |

### 7.2 Authenticated Routes

| Route | Purpose |
| --- | --- |
| `/library` | Grid or list library; filters cover unread, reading, finished, favorite, and archive |
| `/articles/new` | Save an article and optionally assign tags |
| `/articles/:articleId` | Clean reader; light and dark are theme states |
| `/articles/:articleId/edit` | Edit user-controlled metadata, reading state, favorite, archive, and tags |
| `/search` | Full-text search and filters |
| `/tags` | Tag directory |
| `/tags/:tagId` | Articles associated with one tag |
| `/highlights` | Highlights and notes across articles |
| `/settings/profile` | Name and profile settings |
| `/settings/appearance` | Application and reader presentation preferences |
| `/settings/security` | Change password and logout controls |
| `/settings/bookmarklet` | Bookmarklet installation and verification |

The extraction state is shown on the save result or article page. It does not require a permanent `/articles/extract/:jobId` product route.

## 8 Functional Requirements

### 8.1 Authentication and Profile

- Register with name, email, password, and password confirmation.
- Login with email and password.
- Refresh an authenticated session without asking for credentials again.
- Logout and revoke the current refresh session.
- View and update name and supported profile fields.
- Change password only after verifying the current password.
- Normalize email addresses and enforce uniqueness.
- Apply rate limits to registration, login, refresh, and password changes.
- Do not reveal whether an email exists through inconsistent authentication errors.

### 8.2 Article Ingestion

- Accept only absolute HTTP and HTTPS URLs.
- Reject embedded credentials, unsupported ports when configured, localhost, private networks, link-local ranges, and blocked domains.
- Revalidate DNS results and every redirect target to prevent SSRF and DNS rebinding attacks.
- Limit redirects, response bytes, and total request time.
- Accept only supported HTML responses.
- Use article extraction rather than arbitrary DOM scraping for readable content.
- Sanitize stored HTML using an explicit allowlist.
- Preserve plain text separately for search and accessibility.
- Calculate word count and reading time using a documented words-per-minute value.
- Report stable error codes such as `URL_BLOCKED`, `FETCH_TIMEOUT`, `RESPONSE_TOO_LARGE`, `UNSUPPORTED_CONTENT`, and `EXTRACTION_FAILED`.

### 8.3 Articles and Library

- List only the authenticated user's articles.
- Support pagination with a consistent response envelope.
- Support `status`, `tagId`, `favorite`, `archived`, `sort`, and `query` filters.
- Return extraction status with every article summary where relevant.
- Allow updates only to user-controlled fields. Extracted fields are read-only unless explicitly designed for manual override.
- Use optimistic frontend updates only for reversible actions such as favorite or reading status.
- Require confirmation before permanent deletion.

### 8.4 Tags

- Create, rename, list, and delete tags owned by the user.
- Attach and detach tags from an owned article.
- Reject duplicate normalized names for the same user.
- Deleting a tag removes associations but does not delete articles.

### 8.5 Reader and Progress

- Render only sanitized content.
- Persist a normalized progress percentage and an optional stable content anchor.
- Throttle progress writes to avoid sending a request for every scroll event.
- Restore progress on the next visit.
- Store appearance preferences on the user profile only when cross-device synchronization is required; otherwise store them locally in the browser.

### 8.6 Highlights

- Store the exact quote, prefix context, suffix context, optional note, and creation time.
- Associate each highlight with both its owner and article.
- Reject highlight operations when the article is not owned by the user.
- Allow listing by article and across the full library.
- A simple MVP may omit colored highlights unless the design makes color meaningful.

### 8.7 Full Text Search

- Use PostgreSQL full-text search.
- Search the authenticated user's content only.
- Weight title above description and body content.
- Use a GIN index on the search vector.
- Generate snippets from plain text and escape or sanitize marked results before rendering.
- Define the supported language configuration. Use `simple` initially if the library contains mixed Indonesian and English content.

### 8.8 Administration

- Administrators can list, add, update, and remove blocked domains.
- Domain rules match normalized hostnames and documented subdomain behavior.
- Admin endpoints require explicit role authorization.
- Admin activity should be logged without recording private article content.

## 9 API Contract

All endpoints use `/api/v1`. Requests and responses use JSON except health checks. Errors use one envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request could not be processed.",
    "fields": {
      "url": "Enter a valid HTTP or HTTPS URL."
    }
  }
}
```

Paginated collections use one envelope:

```json
{
  "data": [],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 0,
    "totalPages": 0
  }
}
```

### 9.1 Authentication and Profile Endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/auth/register` | Create account |
| `POST` | `/auth/login` | Create authenticated session |
| `POST` | `/auth/refresh` | Rotate refresh token and issue access token |
| `POST` | `/auth/logout` | Revoke current refresh session |
| `GET` | `/me` | Get current profile |
| `PATCH` | `/me` | Update current profile |
| `PUT` | `/me/password` | Change password |

### 9.2 Article Endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/articles` | Submit URL and optional tag IDs |
| `GET` | `/articles` | Paginated library and filters |
| `GET` | `/articles/:articleId` | Article metadata and reader content |
| `PATCH` | `/articles/:articleId` | Update user-controlled fields |
| `DELETE` | `/articles/:articleId` | Permanently delete article |
| `POST` | `/articles/:articleId/retry` | Retry failed extraction |
| `PUT` | `/articles/:articleId/progress` | Save progress and anchor |

Creating an article returns HTTP `202 Accepted` when extraction is queued. The response includes the article ID and extraction status. The frontend polls the article with bounded backoff until it becomes `completed` or `failed`. Real-time sockets are unnecessary for the MVP.

### 9.3 Tag and Highlight Endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/tags` | List owned tags |
| `POST` | `/tags` | Create tag |
| `PATCH` | `/tags/:tagId` | Rename tag |
| `DELETE` | `/tags/:tagId` | Delete tag |
| `PUT` | `/articles/:articleId/tags/:tagId` | Attach tag |
| `DELETE` | `/articles/:articleId/tags/:tagId` | Detach tag |
| `GET` | `/highlights` | List highlights across the library |
| `GET` | `/articles/:articleId/highlights` | List highlights for an article |
| `POST` | `/articles/:articleId/highlights` | Create highlight and optional note |
| `PATCH` | `/highlights/:highlightId` | Update note or supported fields |
| `DELETE` | `/highlights/:highlightId` | Delete highlight |

### 9.4 Administrative Endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/admin/blocked-domains` | List domain rules |
| `POST` | `/admin/blocked-domains` | Add domain rule |
| `PATCH` | `/admin/blocked-domains/:domainId` | Update domain rule |
| `DELETE` | `/admin/blocked-domains/:domainId` | Delete domain rule |

## 10 Data Model

### 10.1 User

- `id`
- `email`
- `passwordHash`
- `name`
- `role`: `user` or `admin`
- `isActive`
- `createdAt`
- `updatedAt`

### 10.2 Session

- `id`
- `userId`
- `refreshTokenHash`
- `expiresAt`
- `revokedAt`
- `createdAt`

### 10.3 Article

- `id`
- `userId`
- `submittedUrl`
- `canonicalUrl`
- `title`
- `description`
- `siteName`
- `author`
- `publishedAt`
- `imageUrl`
- `contentHtml`
- `contentText`
- `wordCount`
- `estimatedReadingMinutes`
- `readingStatus`
- `readingProgress`
- `readingAnchor`
- `isFavorite`
- `isArchived`
- `extractionStatus`: `pending`, `processing`, `completed`, or `failed`
- `extractionErrorCode`
- `searchVector`
- `createdAt`
- `updatedAt`
- `finishedAt`

### 10.4 Tag and Article Tag

Tag contains `id`, `userId`, `name`, `normalizedName`, `createdAt`, and `updatedAt`. Article Tag contains `articleId` and `tagId` with a unique composite constraint.

### 10.5 Highlight

- `id`
- `userId`
- `articleId`
- `quote`
- `prefix`
- `suffix`
- `startOffset` and `endOffset` when available
- `note`
- `createdAt`
- `updatedAt`

### 10.6 Blocked Domain

- `id`
- `hostname`
- `includeSubdomains`
- `reason`
- `createdByUserId`
- `createdAt`
- `updatedAt`

## 11 Technical Direction

### 11.1 Frontend

- React with Vite and TypeScript
- React Router DOM
- Tailwind CSS, shadcn UI, and Tailwind Typography
- TanStack Query for server state
- Zod for form and response-boundary validation where useful

TanStack Markdown may render Markdown content, but it does not fetch or parse source websites. The current product should store sanitized HTML and plain text because Mozilla Readability produces HTML and article structure is more faithfully preserved. Converting sanitized HTML to Markdown is optional and should be justified by a concrete requirement rather than added as another representation by default.

### 11.2 Backend

- Node.js, Express, and TypeScript
- PostgreSQL
- Drizzle ORM and Drizzle Kit
- Mozilla Readability with JSDOM for readable article extraction
- Cheerio only when lightweight metadata extraction or DOM inspection is still needed
- Sanitized HTML allowlist before storage and rendering
- Zod for environment and request validation
- JWT access tokens with rotating refresh sessions
- bcrypt for password hashing to match the approved proposal
- Structured logging and request correlation IDs

Cheerio is not a reader or Markdown renderer. It is a server-side HTML parser with a jQuery-like query API. If Readability plus direct DOM APIs can extract all required metadata, Cheerio can be omitted. Do not keep both libraries unless each has a specific responsibility.

### 11.3 Deployment

- Docker images for frontend and API
- PostgreSQL service
- Docker Compose for local development and demonstration
- A durable extraction worker may run inside the API process for the project demo, but extraction jobs must be persisted in PostgreSQL so queued work is not represented only in memory.

## 12 Security and Privacy Requirements

- Hash passwords using a reviewed bcrypt cost.
- Store refresh tokens as hashes, rotate them, and revoke reused or logged-out sessions.
- Prefer secure, HTTP-only, same-site cookies for refresh tokens.
- Do not place long-lived credentials in local storage or bookmarklet source.
- Enforce authorization in backend queries by both resource ID and authenticated user ID.
- Validate article fetch destinations after DNS resolution and after every redirect.
- Block IPv4 and IPv6 private, loopback, link-local, multicast, unspecified, and reserved destinations.
- Sanitize article HTML with an allowlist; remove scripts, event attributes, forms, iframes unless explicitly supported, and unsafe URLs.
- Restrict CORS to approved frontend origins.
- Apply secure HTTP headers and production HTTPS.
- Avoid logging passwords, tokens, complete article bodies, or sensitive query parameters.
- Return generic internal errors while logging diagnostic detail privately.

## 13 Experience and Design Requirements

### 13.1 Shared Visual Language

- Editorial character with generous whitespace and restrained borders.
- Cream and neutral surfaces with accessible text contrast.
- Serif headings and readable sans-serif interface text.
- Reader line length and line height optimized for sustained reading.
- Border radius between 0 and 4 pixels where consistent with Figma.
- No decorative gradients, glassmorphism, neon, or heavy shadows unless the approved design changes.

### 13.2 Responsive Behavior

- Desktop uses persistent or stable application navigation.
- Tablet may collapse navigation and wrap toolbars.
- Mobile uses a single content column and moves complex filters into a drawer or sheet.
- Interactive targets should be approximately 44 by 44 pixels where practical.
- The main layout must not require horizontal scrolling.

### 13.3 Accessibility

- Use semantic landmarks, headings, lists, articles, forms, and buttons.
- Give every form input a visible label.
- Give icon-only buttons accessible names.
- Preserve a visible keyboard focus indicator.
- Trap and restore focus correctly in dialogs.
- Announce asynchronous extraction and save results through an appropriate live region.
- Never use color as the only status indicator.
- Respect reduced-motion preferences.
- Ensure the reader supports keyboard selection and highlight creation.

### 13.4 UI States

Every data-backed feature must define loading, empty, success, recoverable error, and unrecoverable error behavior. Loading skeletons should preserve the page shell. Error messages must identify what failed and offer retry only when retry is safe.

## 14 Performance and Reliability

- Paginate library, search, tags, and highlights.
- Do not return full article HTML in list endpoints.
- Lazy-load images and provide dimensions when known.
- Debounce search input and cancel obsolete requests.
- Throttle reading progress writes.
- Use database indexes for user ownership filters, reading status, archive and favorite flags, normalized tags, canonical URLs, and full-text search.
- Make extraction retries idempotent.
- Record extraction timestamps and errors for diagnosis.
- Provide `/health/live` and `/health/ready` endpoints.

## 15 Acceptance Criteria for MVP

The MVP is acceptable when all of the following are true:

- A user can register, log in, refresh a session, change a password, and log out.
- One user cannot read or mutate another user's resources, including by guessing identifiers.
- A valid public article URL creates an article and eventually yields sanitized readable content.
- Local, private, blocked, oversized, timed-out, redirected-to-private, and unsupported URLs fail safely.
- Extraction status and safe failure reasons are visible to the user, and failed extraction can be retried.
- Library filters, sorting, pagination, favorite, archive, reading status, and tags work together.
- Search finds terms from both titles and article bodies and never returns another user's content.
- Reader progress survives a new session and finished articles show 100 percent progress.
- Light and dark reader presentation use the same article and route.
- Highlights and notes can be created, edited, listed, reopened in context, and deleted.
- The bookmarklet handoff pre-fills a URL without exposing permanent credentials.
- Core keyboard, focus, labeling, contrast, and reduced-motion checks pass.
- Focused API integration tests cover authentication, ownership, extraction security, article lifecycle, search isolation, tags, highlights, and progress.

## 16 Delivery Plan

### Phase 1 Foundation

Repository setup, Docker Compose, configuration validation, health checks, database schema, migrations, seed data, logging, and test harness.

### Phase 2 Identity

Registration, login, refresh rotation, logout, profile, password changes, authentication middleware, and ownership authorization.

### Phase 3 Article Pipeline

Secure URL validation, persisted extraction jobs, metadata and readable-content extraction, sanitization, error handling, and retry.

### Phase 4 Library

Article list and detail endpoints, filters, pagination, reading states, favorite, archive, tags, and article editing.

### Phase 5 Reader and Knowledge Capture

Reader rendering, progress persistence, appearance preferences, highlights, and notes.

### Phase 6 Search and Bookmarklet

PostgreSQL full-text search, ranked snippets, combined filters, and the credential-safe bookmarklet handoff.

### Phase 7 Hardening and Demonstration

Authorization tests, SSRF cases, stored-XSS tests, accessibility checks, responsive verification, operational documentation, deployment, and demo seed data.

## 17 Open Product Decisions

The team must resolve these before the affected feature is implemented:

1. Whether manually editing extracted title, description, and cover creates overrides or replaces extracted values.
2. Whether appearance preferences must synchronize across devices or remain browser-local.
3. Whether deleting an account is required for the course deliverable.
4. Which article languages must receive stemming. Mixed Indonesian and English content favors PostgreSQL's `simple` configuration for the MVP.
5. Whether Collections should become a post-MVP feature. If approved, define whether an article belongs to one or many collections before changing the schema.
6. The exact Figma file URL and final node mapping to treat as the design authority.

## 18 Consolidation Audit

The 32 source files were useful as screen inventories but were not suitable as independent PRDs for these reasons:

- Shared design, accessibility, motion, technology, and code-style content was repeated in every file.
- Duplicate screens represented the same product capability: editorial and standard library, editorial and standard search, editorial and standard reading, grid and list library, and light and dark reader.
- Template code such as a reading-status filter handler appeared on unrelated pages including login and settings.
- The repeated frontend data contract defined only generic TanStack Query guidance and a `PageState` type, not real API payloads.
- Routes were over-segmented by visual variant instead of modeling variants as state.
- Collections expanded the original approved scope without an explicit product decision.
- Backend ownership, extraction lifecycle, SSRF controls, content sanitization, pagination behavior, and error contracts were insufficiently specified.
- Acceptance criteria focused on individual screens rather than end-to-end product outcomes.

The consolidation resolves these issues by defining one scope, one information architecture, shared cross-cutting requirements, one API direction, one data model, and end-to-end acceptance criteria.

## 19 Source Screen Mapping

The consolidated routes retain the intent of the original Figma screens:

- Library: nodes `11:2`, `11:891`, and `11:1347`
- Search: nodes `11:308` and `11:2079`
- Reading queue and status filters: nodes `11:640`, `11:3282`, `11:3629`, `11:4050`, `11:4502`, and `11:5935`
- Save and extraction: nodes `11:2530` and `11:1794`
- Reader and highlights: nodes `11:5716`, `11:8555`, `11:8919`, `11:9305`, and `11:10263`
- Tags: nodes `11:6990`, `11:7499`, and `11:7889`
- Article editing: node `11:9882`
- Profile, appearance, security, and bookmarklet settings: nodes `11:10598`, `11:10910`, `11:11838`, and `11:12315`
- Landing, login, and registration: nodes `11:11276`, `28:2`, and `28:84`
- Deferred Collections screens: nodes `11:6268`, `11:6663`, and `11:8201`
