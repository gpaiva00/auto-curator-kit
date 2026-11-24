# Contributing

Thanks for helping. This project is a reusable engine for AI-curated social profiles, so small, focused changes are easiest to review.

## Setup

```bash
bun install
bun run test        # vitest
bun run typecheck   # tsc --noEmit
```

Node 22.13.0 or later is required; CI runs the checks on Node 22.13.0 and Node 26.

## Before you open a pull request

- Run `bun run typecheck` and `bun run test` and make sure both pass on Node 22.13.0 and Node 26.
- Keep the change small: one behavior per pull request. Do not add abstractions or unrelated cleanup.
- Add or update tests for the behavior you change. Tests use fakes and do not touch the network.
- If the change alters behavior or a public contract (`packages/contracts`, the exports in `entries/`), regenerate `api/report.txt` with the kit tool and describe the change in `CHANGELOG.md`.
- Keep the Portuguese (`README.pt-BR.md`) and English (`README.md`) READMEs equivalent when you change one of them.

## Style

- TypeScript with strict types; prefer the schemas in `packages/contracts` over ad hoc types.
- Messages shown to the user in the Telegram bot are in Portuguese (pt-BR), like the existing ones.
- No secrets, tokens, personal paths or personal e-mails in code, tests, fixtures or docs. Use placeholders.
- Never commit `.env` files or files under `profiles/` that contain real credentials.

## Pull requests

- Describe the problem and the approach in two or three sentences.
- Say how you tested it (commands and Node versions).
- Link the related issue, if there is one.

## Reporting security problems

Do not use public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
