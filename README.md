# Canopy

Local, black-box site tree and accessibility auditor.

Point Canopy at a URL — remote or `localhost` — and it renders the page with a real browser, audits it against WCAG 2.2 AA / Section 508-style rules, probes keyboard navigation, and stores everything locally. The crawler builds a same-origin tree/graph of the whole site, and every node can be inspected, ignored, or put into a reversible "disabled accessibility" simulation.

No source code from the target is read. No cloud service. No telemetry.

## Status

**M0 — foundation is in place.** The CLI can:

- `scan` a single URL with Playwright + axe-core
- probe keyboard tab order and focus visibility
- save screenshots, DOM snapshots, raw axe output, keyboard data, and a run manifest
- `doctor` the local browser setup
- `init` a project config

**M1 — crawl + tree is in place.** The CLI can also:

- `crawl` a same-origin site with static-first discovery and rendered audits
- respect `robots.txt`, sitemaps, redirects, depth/page limits, and a destructive-route denylist
- build a path tree and a link graph, and write a self-contained `viewer.html`
- store every run in a local SQLite database (`canopy.db`)

**M2 — auth + rendered discovery is in place.** The CLI can also:

- run a scripted login recipe (YAML/JSON) and save a `0600` Playwright session state
- capture a session manually for MFA/captcha (`canopy auth capture`)
- crawl authenticated same-origin pages and stop with exit code `3` if the session expires
- discover links inside open and nested shadow roots during rendered audits

**M3 — audit profiles, highlights, and richer detail is in place.** The CLI can also:

- choose axe profiles (`--profile ada|wcag22aa|best-practice`) and toggle best-practice rules
- control the keyboard probe depth with `--max-tabs`
- capture per-node bounding boxes and render screenshot highlights in `viewer.html`
- inspect richer findings: rule source/tags, node HTML snippets, selectors, positions, and ADA/keyboard/overall scores

**M4 — ignore rules and simulation (core) is in place.** The CLI can also:

- manage per-node ignore rules in SQLite (`ignore add/list/remove`) by URL/path glob and category (`ada`, `keyboard`, `all`)
- apply ignore rules to existing crawl manifests (`ignore apply`)
- auto-apply stored ignore rules to new crawl runs (scores/notices/viewer reflect active findings)
- open a headed browser and apply reversible ADA/keyboard simulation with before/after screenshots (`simulate`)

An interactive local API/UI for toggling ignores and a full React UI remain future work. See [PLANNER.md](./PLANNER.md).

## Requirements

- Node.js 20+
- One of:
  - Playwright Chromium: `pnpm exec playwright install chromium`
  - Google Chrome installed locally (Canopy falls back to it automatically)

## Quickstart

```bash
pnpm install
pnpm exec playwright install chromium   # or rely on system Chrome
pnpm doctor
pnpm canopy scan https://example.com
pnpm canopy crawl https://example.com     # whole same-origin site
```

Run against a local app:

```bash
pnpm canopy scan http://127.0.0.1:3000
pnpm canopy crawl http://127.0.0.1:3000 --allow-private
```

Run the built-in smoke test (uses the fixture site and system Chrome when available):

```bash
pnpm smoke
```

## Commands

```bash
pnpm canopy scan <url>          # scan one page
pnpm canopy crawl <url>         # crawl a same-origin site
pnpm canopy auth test --recipe auth.yml
pnpm canopy auth capture --url <login-url>
pnpm canopy ignore add "/legacy/*" --category ada --reason "third-party"
pnpm canopy ignore list
pnpm canopy ignore apply .canopy/runs/<id>/crawl.json
pnpm canopy simulate https://example.com --mode both
pnpm canopy doctor
pnpm canopy init
```

Useful scan flags:

```bash
--browser chromium|chrome|msedge
--headed
--viewport 1440x900
--timeout 30000
--ignore-https-errors
--allow-private
--no-screenshot
--no-dom
--fail-on critical|serious|moderate|minor
--out .canopy
--config canopy.config.json
```

Crawl adds:

```bash
--max-pages 500
--max-depth 5
--concurrency 2
--rps 1
--no-audit          # map links only; skip rendered audits
--ignore-robots     # only for sites you own
--fail-on critical|serious|moderate|minor
```

Authentication (scan/crawl):

```bash
--auth auth.yml           # scripted login recipe (YAML or JSON)
--auth-state session.json # reuse a saved Playwright storage state
--auth-login-url <url>    # login URL used to detect an expired session
```

`scan` and `crawl` share browser, timeout, viewport, output, auth, audit
profile/best-practices/max-tabs, and `--fail-on` flags where applicable.

Exit codes: `0` clean, `1` issues at or above `--fail-on`, `2` runtime error, `3` auth expired, `4` cancelled.

## Configuration

`canopy init` writes `canopy.config.json` with the defaults:

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
  },
  "auth": {
    "recipe": null,
    "statePath": null,
    "loginUrl": null
  }
}
```

An auth recipe resolves `${ENV_VAR}` placeholders at run time and never stores
secrets in the recipe:

```yaml
login:
  url: https://example.com/login
  steps:
    - fill: { selector: "#email", value: "${CANOPY_USER}" }
    - fill: { selector: "#password", value: "${CANOPY_PASS}" }
    - click: { selector: "button[type=submit]" }
  success:
    waitForUrl: /dashboard
```

## Run artifacts

Every scan writes a run under `.canopy/runs/<timestamp>-<host>/`:

```
summary.json     # run manifest, scores, issues
axe.json         # raw axe-core result
keyboard.json    # tab order, focus state, findings
page.html        # rendered DOM snapshot
screenshot.png   # full-page screenshot
```

Every crawl writes a run in the same place:

```
crawl.json       # crawl manifest: pages, edges, scores, notices
tree.json        # path tree
graph.json       # link-graph nodes and edges
viewer.html      # self-contained offline tree + graph viewer
pages/<slug>/    # per-page screenshot, DOM, axe, and keyboard artifacts
```

Crawl runs are also upserted into `<out>/canopy.db` (SQLite) with `runs`,
`pages`, `edges`, `issues`, and `ignore_rules` tables. Open `viewer.html` in
any browser — it has no external assets and works from `file://`.

## Safety

- HTTP/HTTPS only.
- Cloud metadata addresses are always blocked.
- Private-network targets require `--allow-private`; loopback is allowed for local development.
- Redirects are re-checked against the same target-safety rules.
- Cookies and authorization headers are redacted from stored headers.
- Auth recipes read secrets from environment variables at run time; saved session state is written with `0600` permissions.
- No telemetry, no external assets, no cloud calls.

Only scan sites you own or are authorized to test. Automated findings are indicators, not legal ADA certification.

## License

MIT © 2026 Praveen Kumar
