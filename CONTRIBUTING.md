# Contributing to My DB Mate

Thanks for your interest. This is a self-hosted, single-user project maintained by [phuc-nt](https://github.com/phuc-nt).

## License of contributions

My DB Mate is released under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). By submitting a contribution (pull request, patch, or suggestion), you agree that your contribution is licensed under the same terms, and you grant the author the right to relicense the project — including your contribution — for commercial licensing arrangements.

If you do not agree to this, please do not submit contributions.

## Reporting bugs & requesting features

Open a GitHub issue with:

- what you did, what you expected, what happened
- the engine (PostgreSQL / MySQL / SQLite / D1) and app version
- relevant logs (redact any credentials or connection strings)

**Never paste secrets** — connection strings, API keys, `.env` contents, or database credentials — into an issue or PR.

## Development

See the [README](README.md) for setup, and `docs/user-guide.md` (Vietnamese) for a feature walkthrough.

```bash
./setup.sh
docker compose up -d app-db
npm install
export $(grep -v '^#' .env | xargs)
npm run db:migrate
npm run dev
npm run smoke:llm      # sanity-check the model connection
```

Before opening a PR:

- `npx tsc --noEmit` type-checks clean
- `npm run lint` and `npm test` pass (CI enforces both — the test suite includes the adversarial safety gate)
- keep changes scoped; match existing patterns and file conventions
- the safety model (read-only enforcement, credential encryption, audit log) is non-negotiable — do not weaken it

## Commercial licensing

For any commercial use, contact **phucnt0@gmail.com**.
