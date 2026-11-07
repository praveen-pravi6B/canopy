# Contributing to Canopy

Thanks for helping improve Canopy. Keep changes focused, local-first, and safe
by default.

## Development setup

```bash
pnpm install
pnpm exec playwright install chromium   # optional if system Chrome is available
pnpm doctor
pnpm typecheck
pnpm test
pnpm build
```

Useful commands:

```bash
pnpm canopy --help
pnpm smoke
```

## Guidelines

- **Black-box only.** Do not read or depend on target application source code.
- **Local-first.** No telemetry, accounts, or cloud services.
- **Safe by default.** Preserve target-safety checks, robots defaults, rate
  limits, and destructive-route protections. Any bypass must be explicit.
- **Secrets.** Never log, commit, or store raw credentials. Auth recipes should
  use environment variables; session state should remain local and restricted.
- **Tests.** Add or update tests for behavior changes. Keep fast unit tests fast;
  browser/integration tests should be deterministic and scoped.
- **Docs.** Update `README.md` and/or `PLANNER.md` when CLI flags, output, or
  milestones change.

## Pull requests

- Describe the problem, approach, and verification.
- Include exact commands run (`typecheck`, `test`, `build`, `smoke` as relevant).
- Avoid unrelated refactors.
- For security issues, follow `SECURITY.md` instead of opening a public issue.

## License

By contributing, you agree that your contributions are licensed under the MIT
License.
