# Security Policy

## Scope

Canopy is a local, open-source, black-box accessibility auditor. It runs on your
machine, stores data locally, and makes network requests only to targets you
choose to scan or crawl.

## Reporting a vulnerability

Please do **not** open a public issue for security-sensitive reports.

- Preferred: use GitHub's private vulnerability reporting for this repository.
- If that is unavailable, contact the maintainer through a private channel
  listed on the repository/profile and include reproduction steps, impact, and
  affected versions/commits.

I will acknowledge reports when possible and work on a fix or mitigation.
Timelines depend on severity and maintainer availability.

## Security model highlights

- **Target safety:** HTTP/HTTPS only. Cloud metadata addresses are blocked.
  Private-network targets require explicit opt-in. Redirect hops are rechecked.
- **Local storage:** run artifacts and SQLite data are stored locally. Saved
  session state is written with restrictive permissions (`0600`) where supported.
- **Secrets:** auth recipes resolve `${ENV_VAR}` placeholders at run time; do not
  commit secrets to recipes or config files.
- **Supply chain:** prefer pinned dependencies/lockfiles and review install
  scripts. Run `pnpm audit` and keep Playwright/browsers up to date.
- **Authorization:** only scan/crawl sites you own or are explicitly authorized
  to test. Respect applicable laws and terms.

## Out of scope

- Issues caused by scanning targets without authorization.
- Vulnerabilities in third-party sites you scan.
- Findings that require compromising your local machine outside Canopy's normal
  usage model, unless there is a realistic path from Canopy behavior.
