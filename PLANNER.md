# Canopy — Implementation Plan

> Local, open-source, black-box site tree and accessibility auditor.
> Working name: **Canopy**. Repo: `canopy/`.

## 1. Decisions locked in

| Area | Choice |
|---|---|
| Per-node action | Both: ignore checks and simulate the disabled experience |
| Crawl | Rendered, same-origin, static-first with rendered fallback |
| Delivery | CLI + local UI |
| Stack | TypeScript / Node |
| Auth | Scripted login, with manual session capture as fallback |
| AI | None — deterministic, offline |

## 2. What we are building

Canopy is a local, open-source, black-box accessibility and keyboard-navigation auditor.

You give it a URL — remote or `localhost` — and it:

1. Crawls the site using only HTTP + a real browser, never the target's source code.
2. Builds a tree/graph of every same-origin page it can reach.
3. Audits each page for WCAG 2.2 AA / Section 508-style issues and keyboard navigability.
4. Lets you select a node and either **ignore** those checks for that page or **simulate a broken experience** by stripping accessibility and keyboard behaviour.
5. Stores everything locally and exports a report.

### Non-goals

- Legal ADA certification.
- Replacing manual screen-reader testing.
- Source-code static analysis.
- Load testing or penetration testing.
- A cloud service, accounts, or telemetry.

## 3. Architecture

```text
CLI (canopy scan / ui / report / diff)
        |
        v
Job queue --> Crawler (Playwright + static-first pass)
        |           |
        |           +-- Auth recipe / storageState
        |           +-- Scope + URL normalizer + robots.txt
        |           +-- Artifacts: screenshots, DOM snapshots, headers
        v
SQLite (runs, pages, edges, issues, focusables, ignores)
        |
        +--> Tree/graph builder
        +--> axe-core audit
        +--> Keyboard probe
        +--> Simulation controller (live headed Chromium)
        v
Local UI (React + React Flow) --> HTML/JSON/CSV report
```

Runtime is fully local. The only outbound traffic is to the target site you choose. First install needs network for npm and the Playwright Chromium download; after that it works offline.

## 4. Target repository layout

```text
canopy/
├─ apps/
│  ├─ cli/            # commander commands, exit codes, CI mode
│  ├─ server/         # Fastify API, SSE progress, live-browser controller
│  └─ web/            # React + Vite + React Flow + TanStack Query
├─ packages/
│  ├─ core/           # crawler, auth, a11y, keyboard, graph, simulate, storage
│  ├─ config/         # zod schemas + defaults
│  └─ shared/         # types, constants, report schema
├─ fixtures/          # static, SPA, auth, intentionally inaccessible sites
├─ docs/              # architecture, threat model, usage
└─ .github/           # CI, issue templates, release workflow
```

**M0 note:** the first implementation is a single package with clear internal module boundaries (`src/core`, `src/cli`) so the scanner works end-to-end before the workspace split. When the server and web app land in M1/M4, the core moves into `packages/core` without changing behaviour.

## 5. Stack

- Node 22 target, Node 20 minimum (current machine: Node 20)
- pnpm workspaces (when the workspace split happens)
- TypeScript, ESM, NodeNext resolution
- Playwright Chromium (system Chrome fallback)
- axe-core
- Fastify + SSE for the local API
- React 19 + Vite + `@xyflow/react` + TanStack Query + Zustand
- better-sqlite3 + Drizzle ORM
- Zod for config and report schemas
- Commander for the CLI
- pino for structured logs
- Vitest + Playwright Test
- Changesets for releases

## 6. Core components

### 6.1 Crawler

- **Scope:** same origin by default (`scheme + host + port`). Optional `includeSubdomains`.
- **URL normalizer:** lowercase host, strip default ports and fragments, resolve relative paths, sort query params, strip tracking params (`utm_*`, `fbclid`, `gclid`), configurable trailing-slash policy.
- **Queue:** BFS with `maxPages`, `maxDepth`, `concurrency: 2`, `requestsPerSecond: 1`, jitter, exponential backoff, `Retry-After` support.
- **Two-tier fetch:** static request first to extract links and status; if the HTML looks like a JS shell (empty root, framework markers, low content-to-markup ratio) or the site is a detected SPA, render with Playwright. Every page that gets audited is rendered so axe and the keyboard probe see the real DOM.
- **Discovery sources:** anchor/area links, GET form actions, same-origin iframes, `sitemap.xml`, redirect targets.
- **Safety:** re-check `robots.txt` every 50 pages or 5 minutes during long runs; abort on `429` with backoff; never submit forms; never follow logout/delete/unsubscribe patterns by default.
- **Resilience:** retries for 5xx/network errors, no retries for 4xx, checkpointed queue and `--resume`, graceful `SIGINT`.
- **Limits:** closed shadow roots, cross-origin iframes, canvas/WebGL, DRM video and captchas are reported as "limited / manual review," not silently scored.

### 6.2 Scripted login

Recipe in YAML/JSON:

```yaml
login:
  url: https://example.com/login
  steps:
    - fill: { selector: "#email", value: "${CANOPY_USER}" }
    - fill: { selector: "#password", value: "${CANOPY_PASS}" }
    - click: { selector: "button[type=submit]" }
  success:
    waitForUrl: "/dashboard"
```

- Secrets come from env vars or an OS keychain, never the recipe file.
- Session state saved as Playwright `storageState` with `0600` permissions; optional passphrase encryption.
- Detect expiry (redirect to login, 401/403 on protected pages) and pause the run rather than scoring the login page as content.
- Manual fallback: `canopy auth capture --url ...` opens a headed browser so you can log in, then saves the session. This covers MFA and captchas without bypassing them.
- Scope after login is still same-origin; logout and account-deletion routes are denied.

### 6.3 Tree + graph

- **Node identity:** normalized URL.
- **Path tree:** `/products/123/reviews` becomes nested nodes; numeric/UUID/slug segments cluster into `:id` templates with a "raw URLs" toggle.
- **Graph view:** real link edges, redirect chains, external links as ghost nodes.
- **Flags:** orphan pages, dead ends, redirect loops, non-200s, duplicate titles, depth, in/out link counts.
- Selecting a node in either view highlights the other and opens the detail panel.

### 6.4 Accessibility audit

- Inject the local `axe-core` bundle into the page; run WCAG 2.2 A/AA + Section 508 tags, with best-practice rules optional.
- Map every violation to severity, WCAG criterion, help URL, CSS selector, HTML snippet, and bounding box.
- Highlight violation boxes on the stored screenshot.
- Separate **ADA score** and **keyboard score** per page and per run.
- Clearly label findings as automated evidence, not legal compliance.

### 6.5 Keyboard probe

Per page:

- Enumerate focusables in DOM order.
- Press `Tab` up to `maxTabs` (default 100), recording the focused element, computed outline/box-shadow, `:focus-visible` match, and bounding box.
- Detect missing focus indicator, focus traps, focus lost to `<body>`, hidden-but-focusable elements, positive `tabindex`, skip-link presence and target, focus order vs visual order, and interactive elements that are never reached.
- Optionally inspect click listeners via CDP for "mouse-only" controls.
- Findings are labelled heuristic — automated keyboard testing is not a substitute for manual testing.

### 6.6 Ignore + simulate

**Ignore (per node):**

- Toggles for `ada` and `keyboard` checks per page, stored as URL-pattern rules on the project.
- Applies to current and future runs; report shows "ignored — reason."
- CLI: `canopy ignore add "/legacy/*" --category ada --reason "third-party page"`.

**Simulate (per node):**

- **ADA patch:** strip `role`/`aria-*`, alt text, labels, landmarks, `lang`, and skip links; hide semantic structure.
- **Keyboard patch:** remove focus styles, set `tabindex="-1"`, block `Tab`/`Shift+Tab`/`Enter`/`Space`/arrow defaults, remove skip links.
- Applied to a **controlled headed Chromium** launched by `canopy ui`, not an iframe. The UI sends `navigate` / `simulate on` / `simulate off` / `screenshot` commands to the server over WebSocket.
- "Follow selection" mode navigates the live browser to the selected node automatically.
- Patches are reversible; a floating in-page **Restore** button plus the UI button restore the page (reload is the exact fallback).
- Patches re-apply after SPA navigation.
- Before/after screenshots are saved for reports.
- Snapshot-only mode (for reports/CI) renders the stored DOM in a sandboxed iframe with scripts disabled; live mode is the accurate interactive experience.

### 6.7 Storage

SQLite per project under a local data directory (`~/.canopy` or `--data-dir`), plus an artifacts folder:

```text
runs/<run-id>/
  screenshots/
  dom/
  headers/
  report.html
```

Tables: `projects`, `runs`, `pages`, `edges`, `issues`, `focusables`, `ignore_rules`, `artifacts`, `settings`. Config snapshot is stored with each run so results are reproducible.

### 6.8 Local UI

- Left: collapsible tree + filters/search.
- Center: graph view with colour-coded nodes.
- Right: detail drawer — Overview / ADA / Keyboard / Simulation / Links.
- Top bar: run switcher, progress, export, "open live browser."
- Bulk select for ignore/simulate.
- UI itself is keyboard accessible and tested with axe in CI.
- No CDNs, no external fonts, no telemetry.

### 6.9 CLI

```bash
canopy init
canopy scan https://example.com --max-pages 200
canopy scan --config canopy.config.json --ui
canopy ui --open
canopy report <run-id> --format html
canopy diff <run-a> <run-b>
canopy ignore add "/legacy/*" --category ada --reason "..."
canopy auth test --recipe auth.yml
canopy auth capture --url https://example.com/login
canopy doctor
```

Exit codes: `0` clean, `1` issues above threshold, `2` runtime error, `3` auth expired, `4` cancelled.

## 7. Security and privacy model

| Threat | Mitigation |
|---|---|
| SSRF / scanning your LAN | Block link-local and cloud metadata IPs; private ranges require `--allow-private`; validate every redirect hop |
| Malicious page JS | Chromium sandbox on, fresh context per run, no downloads, no file access, no Node bridge except controlled commands |
| Cookie/session theft | `storageState` `0600`, optional encryption, secrets from env/keychain, redacted logs |
| Local UI hijack / DNS rebinding | Bind `127.0.0.1` only, random port, `Host`/`Origin` checks, per-session token, strict CSP |
| Supply chain | Lockfile, pinned Playwright, `pnpm audit` in CI, Dependabot, no untrusted postinstall builds |
| Data leakage | No telemetry, no cloud, no external fonts/assets, user-controlled retention and deletion |
| Target abuse | Rate limits, page/depth caps, robots.txt respected by default, destructive-route denylist |

"100% local" means analysis and storage stay on your machine. Crawling inherently makes network requests to the target you choose.

## 8. Ethics and legal guardrails

- Explicit "I own or am authorized to test this site" acknowledgement in the UI and `--yes-authorized` for CI.
- `robots.txt` obeyed by default; overriding requires `--ignore-robots`.
- Identifiable user agent: `CanopyBot/0.1 (+repo URL)`.
- No bypassing authentication, captchas, paywalls, or rate limits.
- No destructive requests; dry-run mode for anything ambiguous.
- Clear disclaimer: WCAG 2.2 AA findings are indicators, not ADA legal certification.

## 9. Default configuration

```json
{
  "crawl": {
    "maxPages": 500,
    "maxDepth": 5,
    "concurrency": 2,
    "requestsPerSecond": 1,
    "respectRobots": true,
    "includeSubdomains": false,
    "allowPrivateNetworks": false,
    "allowFileUrls": false,
    "auditPages": true
  },
  "audit": {
    "profile": "ada",
    "includeBestPractices": true,
    "maxTabs": 100
  },
  "browser": {
    "name": "chromium",
    "headless": true,
    "viewport": { "width": 1440, "height": 900 },
    "ignoreHTTPSErrors": false,
    "timeoutMs": 30000,
    "settleMs": 400
  },
  "output": {
    "dir": ".canopy",
    "screenshots": true,
    "domSnapshots": true
  }
}
```

## 10. Milestones

| Milestone | Deliverable | Acceptance |
|---|---|---|
| **M0 — Foundation** (3–5 days) | Workspace, CLI skeleton, config schema, `canopy doctor`, single-URL scan with axe + screenshot + JSON | `canopy scan http://localhost:3000` produces a one-page run; tests pass |
| **M1 — Crawl + tree** (≈1 week) | Normalizer, scope, robots, queue, static-first/rendered fallback, SQLite, tree/graph UI | 30-page fixture fully crawled; zero out-of-scope requests; robots respected |
| **M2 — Auth + SPA** (≈1 week) | Scripted login, session expiry handling, manual capture, shadow-DOM link extraction | Auth fixture crawls protected pages; SPA fixture finds all routes |
| **M3 — Audit + keyboard** (≈1 week) | axe profiles, keyboard probe, scoring, detail panel, screenshot highlights | Fixture violations and keyboard findings match expectations |
| **M4 — Ignore + simulate** (≈1 week) | Per-node ignoring, live browser control, reversible patches, before/after screenshots | Toggle removes focus/ARIA/tab order; restore is exact; ignore persists |
| **M5 — Report + release** (≈1 week) | HTML/JSON/CSV export, run diff, baseline mode, docs, packaging, SECURITY.md, CI | `npx canopy` works on macOS/Linux/Windows; report is self-contained |

Roughly 5–6 focused weeks for one developer.

## 11. Testing and release

- **Fixtures:** static site with broken links/redirects, SPA with client routing, auth site, and an intentionally inaccessible site (missing alt, low contrast, unlabeled inputs, div-onclick buttons, focus trap, no focus style, positive tabindex).
- **Unit:** URL normalization, scope, robots parsing, tree building, ignore rules, scoring, config validation.
- **Integration:** crawl → graph → audit against fixtures; assert page/edge counts and rule IDs.
- **E2E:** CLI commands and local UI with Playwright Test; axe + keyboard tests on the UI itself.
- **CI:** macOS/Linux/Windows, lint, typecheck, unit, integration, build, `pnpm audit`.
- **Release:** Changesets, npm package, GitHub releases, docs site, `SECURITY.md`, `CONTRIBUTING.md`, Code of Conduct, threat-model doc.

## 12. Main risks

| Risk | Mitigation |
|---|---|
| SPA routes only reachable by clicking | Anchor-based discovery first; optional interaction crawl later; user-supplied route list |
| Keyboard automation false positives | Label findings heuristic; CDP listener inspection; manual-review category |
| Auth flows fragile (MFA/captcha) | Manual session capture, pause/resume, expiry detection |
| Large sites | Page/depth caps, resumable queue, sampling, artifact compression |
| Simulation fidelity | Live headed browser is the primary mode; snapshots for reports only |
| Legal misuse | Authorization gate, robots.txt, rate limits, destructive-route denylist, docs |

## 13. Assumptions

1. Repo lives at `canopy/` inside the current workspace.
2. License: MIT.
3. `file://` support: off by default; enable with `--allow-file-urls` for local HTML folders.
4. "Same domain" means same origin by default; subdomains opt-in.
5. Desktop-only viewport for v1; mobile/responsive profiles later.
6. No Docker image in v1; local Node install only.

## 14. Implementation status

### M0 — done

- TypeScript ESM package, strict config, Vitest
- CLI: `scan`, `doctor`, `init`
- URL normalization and target-safety checks (loopback allowed, metadata blocked, private ranges opt-in)
- Playwright browser launch with system Chrome fallback
- Single-page render, screenshot, DOM snapshot, redacted headers
- axe-core audit with WCAG 2.2 / Section 508-style tags
- Keyboard tab probe: focus order, focus visibility, positive tabindex, unreached interactive elements, focus traps
- Local run artifacts + `summary.json`
- Fixture site + smoke test
- 40 unit tests covering URL normalization, target safety, config validation, and scoring
- Verified: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm smoke`, `canopy doctor`, and CLI exit codes 0/1/2

### M1 — done

- `canopy crawl <url>` with BFS queue, `maxPages`, `maxDepth`, `concurrency`, and `requestsPerSecond`
- Static-first link discovery from anchors, areas, same-origin iframes, GET form actions, sitemaps, and redirects
- Same-origin scope by default (`includeSubdomains` opt-in), fragment stripping, tracking-param removal, sorted query params
- `robots.txt` parsing (longest match wins, Allow ties, wildcards, `$` anchors, `Crawl-delay`, sitemaps) and enforcement
- Redirect following with per-hop target-safety checks; destructive-looking routes skipped by default
- Rendered audit of every HTML page through the shared `auditLoadedPage` path (same findings as `scan`)
- Per-page artifacts under `pages/<slug>/`; crawl manifest, tree, graph, and self-contained `viewer.html`
- SQLite storage at `<out>/canopy.db` with `runs`, `pages`, `edges`, `issues`, and `ignore_rules` tables
- Self-contained viewer: searchable path tree, depth-layered SVG link graph, keyboard-operable nodes, per-page findings
- 61 tests, including a 30-page fixture crawl (robots, depth, maxPages, redirects, SQLite, viewer) and a rendered-audit smoke test
- Verified: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm smoke`, and `canopy crawl` against a local static server

### M2 — done

- Scripted login recipes (YAML/JSON) with `${ENV_VAR}` interpolation, `fill`/`click`/`press`/`waitFor`/`goto`/`delay` steps, and a configurable success condition
- `canopy auth test --recipe auth.yml` logs in and saves a Playwright session state with `0600` permissions
- `canopy auth capture --url ...` opens a headed browser for manual login (MFA/captcha), then saves session state
- `scan` and `crawl` accept `--auth`, `--auth-state`, and `--auth-login-url`; authenticated crawls reuse the session and use the same-origin request context for static fetches
- Session-expiry detection (redirect to login / 401 / 403) stops the run and returns exit code `3` instead of auditing the login page as content
- Rendered link discovery walks open and nested shadow roots during browser audits and merges results into crawl discovery
- Crawl manifests record `auth { enabled, loginUrl, statePath, expired }`; the viewer shows an auth chip when enabled
- 76 tests across 9 files, including scripted-login crawl and shadow-DOM discovery fixtures
- Verified individually: `pnpm typecheck`, targeted vitest suites, `pnpm build`, `pnpm smoke`, and CLI help for `auth test`/`auth capture`

### M3 — done

- Axe profile controls exposed through config and CLI: `--profile ada|wcag22aa|best-practice`, `--best-practices/--no-best-practices`
- Keyboard probe depth controllable with `--max-tabs` (scan/crawl)
- Per-issue node bounding boxes captured after audits (best-effort, document-relative) and stored with findings
- `viewer.html` shows per-page ADA/keyboard/overall scores, screenshot with highlight overlays, and richer finding detail (source, WCAG tags, guidance, selectors, positions, failure summaries, node HTML snippets)
- 83 tests across 11 files (added axe tag/profile and viewer rendering regressions)
- Verified: `pnpm typecheck`, `pnpm vitest run test/axe.test.ts test/viewer.test.ts` and fast suites, `pnpm build`

Next: M4 — per-node ignore rules, a local detail API/UI workflow for ignores, and live simulation controls.

## 15. Prior art and community notes

- [How We Automate Accessibility Testing with Playwright and Axe](https://dev.to/subito/how-we-automate-accessibility-testing-with-playwright-and-axe-3ok5) — per-page axe pipeline in Playwright.
- [Building a Fast Web Scraper Without Puppeteer](https://dev.to/dilutedev/building-a-fast-web-scraper-without-puppeteer-a-live-coding-challenge-2apg) — static-first discovery.
- [Scraped 300 pages successfully. Site updated robots.txt at page 187 and blocked me.](https://dev.to/nicodev__/scraped-300-pages-successfully-site-updated-robotstxt-at-page-187-and-blocked-me-28k) — re-check robots.txt during long runs.
- [The Waterfall Pattern: A Tiered Strategy for Reliable Data Extraction](https://dev.to/withatte/the-waterfall-pattern-a-tiered-strategy-for-reliable-data-extraction-295k) — tiered fetch fallbacks.
- [How We Catch UI Bugs Early with Visual Regression Testing and Playwright](https://dev.to/subito/how-we-catch-ui-bugs-early-with-visual-regression-testing-and-playwright-5h2a) — screenshot-based before/after comparison.
