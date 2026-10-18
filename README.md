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
- Live view: Powerpal-style radial dial ("now using" + est. $/h), last-hour petal fan
  (1-min buckets), ToU cost strips — see "Live view" below
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
│   energy-dashboard.ahbeng.xyz          ben-energy-dashboard.pages.dev     │
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
3. The Function rewrites the URL to `https://energy.ahbeng.xyz/api/<path>?<query>`
   (the FastAPI server mounts all routes under `/api/v1/...`, so the
   dashboard-facing `/api` prefix is re-added), adds `X-API-Key`, and streams
   the upstream response back **with its original status code and JSON error
   body**.
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

## Live view (Powerpal-style dial — added 2026-10-18)

The header tabs switch between **Charts** (the original view, untouched) and **Live**:

- **Dial** — current grid import (W) + estimated $/h, colour-coded (< 500 W green,
  500–3000 W amber, ≥ 3000 W red) on a sqrt-compressed 0–8 kW ring. Petals = the last
  hour of 1-minute grid buckets, oldest at 12 o'clock.
- **Freshness** — the Pi ingests once per minute; latest readings poll every 10 s,
  history + cost strips every 60 s. The "grid reading" chip shows data age and turns
  red after 10 min of ingest silence.
- **Solar** — shown separately (gold chip): the meter reads net grid import, so with
  solar covering the house the dial sits at 0 W — that energy is just free.
- **Costs** — time-of-use tariff from `src/lib/tariff.ts`:
  **8 c/kWh 00:00–06:00 · 27 c/kWh 06:00–24:00 Melbourne time** (evaluated via ICU, so
  it stays correct regardless of device timezone). Dollars are estimates: grid import
  only (solar self-consumption is free); supply/network charges excluded. Edit
  `TARIFF_WINDOWS` if the plan changes — `npm test` covers the boundary maths.
- **Monthly bars** — calendar-month ToU totals; the first recorded month (Oct 2026) is
  partial, since data begins 12 Oct.

---

## Deployment (wrangler CLI — deployed 2026-10-17)

> The old dashboard click-path (Workers & Pages → Connect to Git) died in the
> 2026 Cloudflare dashboard revamp; deploys are CLI-only now.

Live: **https://energy-dashboard.ahbeng.xyz** (custom domain) and
**https://ben-energy-dashboard.pages.dev**. The project is named
`ben-energy-dashboard` — `home-energy-dashboard.pages.dev` is squatted by an
unrelated account, so the original name was unavailable.

Both hostnames are **Cloudflare Access-gated** (see next section).

To redeploy (token needs Pages · Edit):

```bash
export CLOUDFLARE_API_TOKEN=<token>
export CLOUDFLARE_ACCOUNT_ID=3ff9c0b4999a44d641159ab46b34bde1
npm run build
npx wrangler pages deploy dist --project-name=ben-energy-dashboard --branch=main
```

Production-only: deploys are always `--branch=main`, so there are no preview
deployments to disable.

**Secret** `QUERY_API_KEY` is already set (value pulled from the server's
`.env`). To rotate it:

```bash
printf '%s' '<new-key>' | npx wrangler pages secret put QUERY_API_KEY \
  --project-name=ben-energy-dashboard
npx wrangler pages deploy dist --project-name=ben-energy-dashboard --branch=main
```

**Custom domain** `energy-dashboard.ahbeng.xyz` is attached to the Pages
project via the Pages API, backed by a proxied CNAME
`energy-dashboard → ben-energy-dashboard.pages.dev` in the `ahbeng.xyz` zone
(DNS · Edit needed to touch that record).

---

## Cloudflare Access (both hostnames — configured 2026-10-17)

Both hostnames sit behind **three** Cloudflare Access self-hosted apps
(account `Benedict_chng@yahoo.com's Account`), created via the Access API:

1. `Energy Dashboard (custom domain)` → `energy-dashboard.ahbeng.xyz`
2. `Energy Dashboard (pages.dev)` → `ben-energy-dashboard.pages.dev`
3. `Energy Dashboard (pages.dev deployments)` → `*.ben-energy-dashboard.pages.dev`

App 3 matters: every `wrangler pages deploy` also publishes the deployment under a
unique `<hash>.ben-energy-dashboard.pages.dev` URL, which hostname-specific apps do
NOT cover (confirmed exploitable 2026-10-18 — a hash URL served the SPA + API proxy
unauthenticated; 30 min exposure window). The wildcard app gates all of them.

Each has one Allow policy: email `benedict_chng@yahoo.com`. Session length:
**720 h (30 days)** after each login.

The tenant's only login method is **One-time PIN** (email OTP, IdP id
`df9db038-06fd-4b4c-a687-58c939866a1d`), and both apps are pinned to it
(`allowed_idps`) — no other sign-in method can ever appear.

**Logging in:** open either hostname → you get redirected to
`raspy-dew-2e27.cloudflareaccess.com` → enter your Yahoo email → One-Time PIN
arrives by email → in. No password, and nobody else can reach the app.

Verified 2026-10-17: unauthenticated requests to both hostnames (SPA *and*
`/api/*`) return `302` to the Access login — nothing is exposed.

To change the policy later, manage these two apps in the Zero Trust dashboard
(Access → Applications) or via the Access API.

---

## Troubleshooting

- **`401 {"detail":"invalid or missing API key"}`** — the `QUERY_API_KEY`
  secret is missing on the Pages project or doesn't match the server's key.
  Fix: re-run `wrangler pages secret put QUERY_API_KEY` with the server's
  value, then redeploy. Locally, check `.dev.vars`.
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
