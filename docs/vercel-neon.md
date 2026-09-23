# Vercel + Neon deployment

This is the no-card, no-cost deployment path for the university project. Keep
the API on Vercel Hobby and its PostgreSQL database on Neon Free. The
`vercel.json` pins the function to Washington, DC (`iad1`), matching the
US East region of the Neon database provisioned through Vercel Marketplace.
Do not connect an existing database.

Current API: `https://simpandulu-api.vercel.app`.

## Setup

1. Add a Neon Free resource to the Vercel project through Marketplace. The
   integration injects the pooled `DATABASE_URL` and unpooled
   `DATABASE_URL_UNPOOLED` into the project. Keep these values in Vercel's
   environment settings, never in Git or a frontend bundle.
2. Apply the repository migrations once to the new Neon database using its
   unpooled `DATABASE_URL_UNPOOLED` as `DATABASE_URL` for the migration command
   (`node dist/db/migrate.js`). Confirm `/health/ready` only after migration.
   Do not seed demo data into a database used by real users.
3. Create a Vercel Hobby project from this repository, or deploy it with the
   Vercel CLI. Use Node.js 24 and the Other framework preset. The
   `api/index.js` entry exports the compiled API as one Vercel Function.
4. Set a new random `ACCESS_TOKEN_SECRET` of at least 32 characters,
   `NODE_OPTIONS=--experimental-require-module`, and `CORS_ORIGIN` to the exact
   frontend origin. Vercel sets `NODE_ENV=production`. Set
   `DATABASE_MAX_CONNECTIONS=2` to keep connection usage low across function
   instances. Other settings can use the defaults in
   `.env.production.example`. Configure secrets for Production only unless you
   intentionally create an isolated Preview database.
5. Deploy from source with `vercel deploy --prod` (not a local Mac prebuild) and
   verify `/health/live` and `/health/ready` over HTTPS. Register a
   user, log in, submit a public article, poll its detail endpoint until it is
   `completed`, then refresh the session and log out. Check Vercel function
   logs and Neon usage after the test.

There is no always-running worker on Vercel. Submitting or retrying an article
schedules one durable PostgreSQL job with Vercel's request-scoped background
work. Polling a pending or processing article schedules another attempt, so a
job can recover if a function was interrupted. A stale claim is eligible again
after `EXTRACTION_STALE_LOCK_MS` (five minutes by default). The frontend must
poll while it needs a result; idle jobs do not advance until another relevant
request arrives. This is a free-tier trade-off, not an uptime guarantee.

The refresh token is an HTTP-only `Secure`, `SameSite=Lax` cookie. When the
frontend is on another site, direct browser requests to the API cannot rely on
that cookie for refresh. Proxy `/api` through the frontend's own origin and use
relative `/api/v1/...` URLs in browser code. The frontend's Vercel project can
use a rewrite for `/api/:path*` to this API's HTTPS URL; preserve the same path.
For local development, use the frontend dev server's equivalent proxy. Do not
change the cookie to a cross-site setting simply to avoid a proxy.

Until the frontend has a URL, `CORS_ORIGIN` is set to the API's own origin.
Update it to the exact frontend origin once that exists; the same-origin proxy
above also avoids browser CORS and refresh-cookie problems. In Vite, for
example, configure the dev server to proxy `/api` to
`https://simpandulu-api.vercel.app`, then call `/api/v1/...` from the browser.

Vercel Hobby and Neon Free can enforce usage limits. Monitor both dashboards
and export important data regularly; free hosting is not a backup strategy.
