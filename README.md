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

The crawler, tree/graph UI, scripted login, per-node ignore rules, and live simulation are the next milestones. See [PLANNER.md](./PLANNER.md).

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
```

Run against a local app:

```bash
pnpm canopy scan http://127.0.0.1:3000
```

Run the built-in smoke test (uses the fixture site and system Chrome when available):

```bash
pnpm smoke
```

## Commands

```bash
pnpm canopy scan <url>          # scan one page
pnpm canopy scan <url> --json   # machine-readable run manifest
pnpm canopy doctor              # check Node + browser setup
pnpm canopy init                # write canopy.config.json
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

Exit codes: `0` clean, `1` issues at or above `--fail-on`, `2` runtime error, `3` auth expired (reserved), `4` cancelled.

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
    "allowFileUrls": false
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

## Run artifacts

Every scan writes a run under `.canopy/runs/<timestamp>-<host>/`:

```
summary.json     # run manifest, scores, issues
axe.json         # raw axe-core result
keyboard.json    # tab order, focus state, findings
page.html        # rendered DOM snapshot
screenshot.png   # full-page screenshot
```

## Safety

- HTTP/HTTPS only.
- Cloud metadata addresses are always blocked.
- Private-network targets require `--allow-private`; loopback is allowed for local development.
- Redirects are re-checked against the same target-safety rules.
- Cookies and authorization headers are redacted from stored headers.
- No telemetry, no external assets, no cloud calls.

Only scan sites you own or are authorized to test. Automated findings are indicators, not legal ADA certification.

## License

MIT © 2026 Praveen Kumar
