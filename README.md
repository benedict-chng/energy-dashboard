# Home Energy Dashboard

A single-page React dashboard for Ben's home-energy server (`https://energy.ahbeng.xyz`,
FastAPI + TimescaleDB behind a Cloudflare Tunnel). It shows a live "Now" view plus 24-hour
and 7-day grid-vs-solar charts, with 60-second auto-refresh.

**Security model:** the browser only ever calls **same-origin** `/api/...` paths. A
Cloudflare Pages Function (`functions/api/[[path]].ts`) forwards those GETs to the real API
and attaches the `X-API-Key` header from the Pages environment variable `QUERY_API_KEY`.
The key is never present in frontend code, the JS bundle, or the browser.

- Stack: Vite + React 18 + TypeScript + Recharts (no UI framework)
- Charts: `GET /api/v1/energy/overview` — kWh bars + grid/solar watt lines
- Now tiles: `GET /api/v1/readings/latest`, `GET /api/v1/solar/readings/latest`
- Response types in `src/types.ts` mirror the server's Pydantic schemas exactly
  (`app/schemas/energy.py`, `app/schemas/reading.py`, `app/schemas/solar.py`)

---

## Architecture

```
                        Browser (dashboard SPA)
                                │
              fetch("/api/v1/energy/overview?bucket=5m")
                                │  same-origin only
                                ▼
┌───────────────────────── Cloudflare Pages ─────────────────────────┐
│                                                                    │
│   energy-dashboard.ahbeng.xyz          home-energy-dashboard.pages.dev    │
│        │                                 │                         │
│        └────────────┬────────────────────┘                         │
│                     ▼                                              │
│   ┌───────────────────────────┐     ┌───────────────────────────┐  │
│   │  Static assets (dist/)    │     │ functions/api/[[path]].ts │  │
│   │  React SPA (Vite build)   │     │ Pages Function — GET only │  │
│   └───────────────────────────┘     └────────────┬──────────────┘  │
│                                                  │                 │
│                              X-API-Key: QUERY_API_KEY (Pages env │
│                              var / .dev.vars) — never in bundle  │
└──────────────────────────────────────────────────┼─────────────────┘
                                                   ▼
                                   https://energy.ahbeng.xyz/api/v1/...
                                   FastAPI + TimescaleDB
                                   (home-energy-server, Cloudflare Tunnel)
```

Request flow:

1. `GET /api/<path>?<query>` hits the Pages Function (anything under `/api/`).
2. Non-GET → `405`. Missing `QUERY_API_KEY` → `500` (nothing leaves Cloudflare).
3. The Function rewrites the URL to `https://energy.ahbeng.xyz/<path>?<query>`
   (the `/api` prefix is stripped), adds `X-API-Key`, and streams the upstream
   response back **with its original status code and JSON error body**.
4. `502` if the upstream is unreachable (e.g. tunnel down).

---

## Local development

Prerequisites: Node.js ≥ 20 and npm.

```bash
npm install

# 1. Copy the env example and put the QUERY key from the server's .env in it
cp .dev.vars.example .dev.vars
$EDITOR .dev.vars          # QUERY_API_KEY=<value of QUERY_API_KEY from the server>

# 2. Run Vite + the Pages Function together
npm run dev
# → open http://localhost:8788
```

`npm run dev` runs `wrangler pages dev`, which serves the Function (reading
`.dev.vars`) in front of the Vite dev server — the browser talks same-origin
`/api` exactly like in production. The API key in `.dev.vars` must match
`QUERY_API_KEY` in the server's `.env`.

Other scripts:

| Script             | What it does                                              |
| ------------------ | --------------------------------------------------------- |
| `npm run build`    | Type-checks (app + functions) and builds `dist/`          |
| `npm run pages:dev`| Builds, then serves `dist/` + Function via wrangler        |
| `npm run dev:ui`   | Vite only — `/api` calls will 404 (no Function)            |
| `npm test`         | No-network unit checks of the Function's path-mapping and guards (Node ≥ 23.6; older Node: `node --experimental-strip-types scripts/verify-upstream.ts`) |

`.dev.vars` is gitignored — never commit a real key.

---

## Deploy to Cloudflare Pages (dashboard)

Suggested project name: **`home-energy-dashboard`**
(→ `https://home-energy-dashboard.pages.dev`)

1. **Get the code into Git.** Push this directory to a GitHub/GitLab repo
   (production branch `main`). Direct-upload via the dashboard does not compile
   Functions; alternatively use `npx wrangler pages deploy dist` after
   `npm run build`, but Git-connect is the recommended path below.
2. **Create the project.** Cloudflare dashboard → **Workers & Pages** →
   **Create application** → **Pages** tab → **Connect to Git** → authorise and
   pick the repo → **Begin setup**:
   - Project name: `home-energy-dashboard`
   - Production branch: `main`
   - Framework preset: **Vite** (fills in build command `npm run build`,
     build output directory `dist`)
   → **Save and Deploy** (first deploy may fail-ish warn on missing env var;
     finish steps 3–4, then redeploy).
3. **Set the API key.** Project → **Settings** → **Variables and Secrets** →
   **Add variable**:
   - Name: `QUERY_API_KEY`
   - Value: the `QUERY_API_KEY` value from the home-energy-server's `.env`
   - Type: **Secret** (encrypted) — scope it to **Production**
   Then **Deployments** → latest deployment → **Retry deployment** so the new
   variable is picked up.
4. **Custom domain.** Project → **Custom domains** → **Set up a custom domain**
   → enter `energy-dashboard.ahbeng.xyz` → **Continue** → **Activate domain**.
   (Requires the `ahbeng.xyz` zone in the same Cloudflare account; Cloudflare
   creates the CNAME to the pages.dev project automatically.)
5. **Disable preview deployments.** Project → **Settings** → **Builds &
   deployments** → **Preview deployments** → **Disable**. Only production
   builds (pushes to `main`) deploy.

---

## Cloudflare Access (both hostnames — do not skip one)

The dashboard is protected by **two** Access gates, because it is reachable on
two hostnames:

1. `energy-dashboard.ahbeng.xyz` (custom domain)
2. `home-energy-dashboard.pages.dev` (the Pages project's own hostname — anyone
   who guesses it otherwise bypasses the custom-domain gate)

**Option A — second Zero Trust app (always available):**

For each hostname above, repeat:

1. Zero Trust dashboard → **Access** → **Applications** → **Add an application**
   → **Self-hosted**.
2. Application name: e.g. `Home Energy Dashboard (custom domain)` and
   `Home Energy Dashboard (pages.dev)`.
3. Application domain: enter the hostname (`energy-dashboard.ahbeng.xyz`, then
   `home-energy-dashboard.pages.dev`), path left empty.
4. Add a policy: name `allow-ben`, Action **Allow**, Include → Selector
   **Emails** → `benedict_chng@yahoo.com`.
5. Save. First visit triggers an email-OTP login.

**Option B — the Pages project's Access policy setting:** some accounts show a
Cloudflare Access section on the Pages project itself (Pages project →
**Settings** → Access policy / "Limit access to your Pages project"). You can
enable it there for the `*.pages.dev` hostname with the same Allow email policy
`benedict_chng@yahoo.com` and keep only the custom domain as a separate
Zero Trust app (Option A step for `energy-dashboard.ahbeng.xyz` only).

Either way, the end state is: **both** hostnames require Access, and only
`benedict_chng@yahoo.com` is allowed.

---

## Troubleshooting

- **`401 {"detail":"invalid or missing API key"}`** — the `QUERY_API_KEY`
  env var is missing on the Pages project or doesn't match the server's key.
  Fix: compare with the server's `.env`, re-add the variable (Settings →
  Variables and Secrets), then redeploy. Locally, check `.dev.vars`.
- **CORS errors should never appear.** The browser only talks to its own
  origin; the Function does the upstream call server-side. If you ever see a
  CORS error, the frontend is calling `https://energy.ahbeng.xyz` directly —
  check that the app was served from this project's build (`/api/...` paths in
  the network tab, no `energy.ahbeng.xyz` in the browser's requests).
- **`405 Method not allowed`** — non-GET requests are rejected by design.
- **`404 no readings stored yet`** — the database has no data yet (the Now
  tiles show "—"); not an error.
- **`422` with a timestamp message** — `from`/`to` must be ISO 8601 *with a
  UTC offset*. The dashboard always sends `Z` timestamps; this only bites when
  crafting manual queries.
- **`502 Upstream unreachable`** — the Cloudflare Tunnel to the server is
  down; check the server/tunnel, not the Pages project.
- **Charts empty but no error** — no data in the selected window yet.
- **Local port clashes** — `npm run dev` uses 8788 (wrangler) and 5173 (Vite,
  `--strictPort`); free the port or change the flags in `package.json`.

---

## Project layout

```
home-energy-dashboard/
├── functions/
│   └── api/
│       ├── [[path]].ts      # Pages Function: same-origin /api proxy (GET only)
│       └── _upstream.ts     # pure URL-mapping helpers (unit-tested, not routed)
├── scripts/
│   └── verify-upstream.ts   # npm test — no-network Function logic checks
├── src/
│   ├── api/client.ts        # typed same-origin /api client
│   ├── components/
│   │   ├── ErrorBanner.tsx  # API error text + retry
│   │   ├── NowPanel.tsx     # "Now" tiles (latest grid + solar readings)
│   │   └── OverviewChart.tsx# Recharts composed chart (kWh bars + W lines)
│   ├── lib/format.ts        # en-AU number/time formatting
│   ├── types.ts             # wire models mirroring the server schemas
│   ├── App.tsx              # state, range selector, 60 s auto-refresh
│   ├── main.tsx
│   └── styles.css           # dark theme, responsive
├── index.html
├── package.json
├── tsconfig.app.json        # type-checks src/
├── tsconfig.functions.json  # type-checks functions/ + scripts/ + vite.config
├── vite.config.ts
├── .dev.vars.example        # copy to .dev.vars (gitignored)
└── .gitignore               # node_modules, dist, .dev.vars
```
