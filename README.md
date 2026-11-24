**English** · [Português](README.pt-BR.md)

# auto-curator-kit

A reusable engine for running **AI-curated social media profiles**. It reads sources (RSS, Google News, Google Trends, links you send), triages with a cheap model and curates with a better one, prepares the media and sends each post to you for approval on Telegram. Only after your ✅ is the post scheduled on Buffer or handed to you to publish by hand.

Current version: **0.4.0** (no release published yet).

A profile is a configuration folder (`profile.json`, `style-guide.md` and optional prompts), not code. Creating a new profile does not require editing the engine.

```text
 Sources: RSS · Google News · Google Trends · /add · browser (optional)
   │
   ▼  ingest (every 30 min) + pre-filter without AI (duplicates, old items, blocked patterns)
 Triage (cheap LLM)                   score 0–100; below triageMinScore becomes skipped
   │
   ▼
 Curation (better LLM)                Draft: verdict, headline, body, hashtags, riskFlags
   │                                  the profile's policy applies the rules in code
   ▼                                  per-destination character limit (one retry)
 Media (render | original | none)     ready state
   │
   ▼
 Approval on Telegram  ◄───────────── nothing leaves here without your ✅
   │
   ├──► Buffer (draft, queue or now)
   └──► manual (the bot sends the final text and you publish it, then tap "Published")
```

## Principles

- **Nothing is published without human approval.** Every item goes through Telegram. The bot only answers chat ids listed in `TELEGRAM_ALLOWED_CHAT_IDS`.
- **Text over the limit cannot be approved.** If the final text for a destination is over its character limit (e.g. Threads, 500), the draft becomes `needs_human`, with no ✅ Approve button. You can redo (🔁), edit or reject it.
- **One process per profile.** Each profile has its own bot, SQLite database, AI spending cap and `.env`.
- **A profile is configuration, not code.** Sources, destinations, limits and editorial rules live in `profile.json`. Voice, audience and topics live in `style-guide.md` and the prompts.

## Requirements

| Tool | Required? | Used for |
|---|---|---|
| Node 22.13.0+ (`^22.13.0 \|\| >=23.4.0`) | yes | runtime (the database uses `node:sqlite`) |
| bun 1.3.13 | yes | installing dependencies and running scripts (`packageManager`: bun@1.3.13) |
| ffmpeg | no | rendered video (`render` strategy with video) |
| yt-dlp | no | downloading third-party video (video sources) |
| Google Chrome | no | browser sources (`x-feed`, `instagram-profile`); the helper script is for macOS |

## Quick start

```bash
bun install

# 1. creates profiles/<id>/ from a template (news-card or thought-leader)
bun run create my-profile --template news-card --name "My Profile"

# 2. edit profiles/my-profile/profile.json (sources and destinations) and fill in style-guide.md

# 3. profile secrets
cp profiles/my-profile/.env.example profiles/my-profile/.env   # fill in token, chat ids and AI keys

# 4. checks everything (❌ must be fixed; ⚠️ is a warning)
bun run doctor --profile my-profile

# 5. reads the sources once, without AI, and shows what passes the pre-filter
bun run scan --profile my-profile

# 6. (optional, spends AI) runs the Curator's regression cases
bun run eval --profile my-profile

# 7. starts the bot and the scheduler (keeps running; Ctrl+C to stop)
bun run start --profile my-profile
```

To test the whole pipeline without network and without AI, run `bun run dry-run` (with or without `--profile`).

Details for each step: [docs/PERFIL.md](docs/PERFIL.md). To keep it running on a Mac or in Docker: [docs/DEPLOY.md](docs/DEPLOY.md).

## Repository layout

| Path | Contents |
|---|---|
| `packages/contracts` | Types and zod schemas: `profile.json`, `models.json`, template, `Item` and states, `Draft`, ports (interfaces). No runtime dependencies. |
| `packages/engine` | Loading of profile and `.env`, SQLite database with migrations, LLM client (fallback and monthly cap), prompts, policy (veto and editorial rules), pipeline jobs, scheduler. |
| `packages/telegram` | Long-polling bot, approval card layout, buttons, commands and pt-BR texts. |
| `packages/sources` | Source registry (`registerSource`) and the built-in sources; browser reader over CDP. |
| `packages/media` | Media preparers (`none`, `original`, `render`), yt-dlp download, card and video rendering. |
| `packages/publishers` | Publishing through Buffer (GraphQL), media hosting (R2 or imgBB) for Buffer, and the Buffer quota counter (see Limitations). |
| `packages/cli` | Commands (`create`, `doctor`, `scan`, `dry-run`, `eval`, `start`, `status`), profile resolution and application wiring. |
| `templates/` | Profile templates: `news-card` and `thought-leader`. They include prompts, `models.json`, defaults and evals. |
| `profiles/` | Local profiles (examples and yours). `.env` files are never committed. |
| `deploy/` | LaunchAgent (`install-launchd.sh`, plist template), `compose.yaml` and `Dockerfile`. |
| `scripts/` | `chrome-reader.sh`: opens the dedicated reading Chrome. |
| `docs/` | Documentation: profile, sources, architecture, deployment and the project plan. |

## CLI commands

The root scripts call `packages/cli/src/main.ts`. The profile comes from `--profile <id or path>` or from the `CURADOR_PROFILE` variable.

| Command | What it does | Options |
|---|---|---|
| `bun run create <id>` | Creates `profiles/<id>/` (profile.json, style-guide.md, .env.example, evals/) | `--template news-card` (default) or `thought-leader`; `--name "Name"` |
| `bun run doctor` | Checks configuration, prompts, API keys, monthly spend, the Telegram bot, sources, Chrome, Buffer, ffmpeg, yt-dlp and the data folder. Exits with code 1 if there is a ❌. | `--offline` (makes no network calls) |
| `bun run scan` | Reads the sources once, without AI, and shows each item and why it was filtered. Without `--dry`, it stores the new items in the database. | `--dry` (display only) |
| `bun run dry-run` | Runs ingestion, triage, curation, media, the approval card and approve/reject with fake data, in a temporary folder. Without `--profile`, uses a synthetic profile. | — |
| `bun run eval` | Runs the cases in `templates/<template>/evals/cases.json` and `profiles/<id>/evals/cases.json` against the real model. Spends AI. | `--case <name>` (filter by name) |
| `bun run start` | Starts the Telegram bot and the scheduler (ingestion and pipeline). Single-instance lock per profile. | — |
| `bun run status --profile <id>` | Shows counts per state, monthly spend, limits and the latest runs. | — |

All of them accept `--profile` (or `-p`) and `--help` (or `-h`). Unknown options are an error.

## Telegram bot commands

Commands are in Portuguese. The English aliases also work. Messages from chats outside `TELEGRAM_ALLOWED_CHAT_IDS` are ignored and get no reply. If `TELEGRAM_ALLOWED_USER_IDS` is set, the sender must also be on that list.

| Command | Alias | What it does |
|---|---|---|
| `/add <link or text>` | — | Creates an item now. Sending only the link also works. |
| `/ler` | `/scan` | Runs the sources now. |
| `/pendentes` | `/pending` | Lists what is waiting for your approval. |
| `/fila` | `/queue` | Everything in progress, grouped by state. |
| `/agenda` | `/schedule` | What is scheduled on Buffer. |
| `/refazer <id> <instruction>` | — | Redoes the text of a pending item, or of an approved item that has nothing in the send queue yet. Refuses items already queued and items already published. |
| `/furar <id>` | `/bump` | Puts the item at the front of the queue. |
| `/desfurar <id>` | `/unbump` | Removes the item's priority. |
| `/status` | — | Counts, AI spend, daily limit and the waiting reason, if any. |
| `/pausar` | `/pause` | Pauses scheduled ingestion and pipeline. `/ler` and `/add` keep working. |
| `/retomar` | `/resume` | Resumes generation. |
| `/config` | `/configs` | Shows the settings that can be changed from Telegram, with their current values. |
| `/definir <key> <value>` | `/set` | Changes a profile setting (e.g. `/definir aprovacoes_dia 5`). Takes effect after restarting the app. Secrets (`.env`) cannot be changed from chat. |
| `/cancelar` | `/cancel` | Cancels the edit in progress. |
| `/ajuda` | `/help`, `/start` | Lists the commands. |

During a 🔁 Redo, the reply `/igual` tries again without an instruction.

### Approval card

Each post arrives before anything is published, with the prepared media and the buttons below. This is an illustrative example of the format:

```text
⚠️ Revisar · i_9c1e4b7a2f10 · Telescópio detecta atmosfera em planeta do tamanho da Terra
📊 Confiança 82% · 🎯 Instagram · 🛡 Riscos: single_source
❓ Dúvida: só uma fonte confirmou; checar o comunicado original.
🔗 Fonte: https://www.example.com/noticia  ·  ✍️ Crédito: Fonte: Portal Exemplo
─────────
<final text, exactly as it will be published>

[✅ Aprovar]        [❌ Rejeitar]
[✏️ Editar texto]   [🏷 Editar título]
[🔁 Refazer]
```

- ⚠️ **Revisar** (review) appears when the verdict is `needs_human` or there are risk flags. 🆕 **Novo** (new) appears in the other cases.
- **`needs_human` card** (text over the limit of some destination): has no ✅ Approve button. It shows the warning with the count (e.g. `threads: 512/500 caracteres, acima do limite`) and the reject, edit and 🔁 Redo buttons.
- **Reject** asks for a reason (the profile's list, in `telegram.rejectReasons`) and records it in the database.
- **Redo** asks the Curator for an instruction, or `/igual` to try again.
- For manual destinations, approval sends the final media and the text to copy, with the **Abrir** (Open, if there is a `composeUrl`) and **Publiquei** (Published) buttons.

## Per-destination limits and daily cap

- **Character limit (`maxChars`).** Each destination can have a limit for the final text (body, hashtags and credit). Without the field, Threads through Buffer uses 500 for compatibility. When the text is over the limit, the Curator receives the number and tries once; if it is still over, the draft becomes `needs_human` (see the card above). The text is never cut in the middle.
- **Daily cap (`dailyCap`).** When a destination has already reached its daily maximum, the item is deferred to the first slot with room, respecting the window (`window`) and the minimum interval (`minIntervalMinutes`). Deferral goes up to `maxDeferDays` days (default 7). If there is no room within that period, the item goes to manual sending, with a note in the record.

## Documentation

- [docs/PERFIL.md](docs/PERFIL.md): creating and adjusting a profile, `profile.json` reference, prompts, veto, evals and environment variables.
- [docs/FONTES.md](docs/FONTES.md): each source type, options, deduplication key and examples; how to write and register a new source.
- [docs/ARQUITETURA.md](docs/ARQUITETURA.md): packages, item state machine, ports, database tables and the LLM client.
- [docs/DEPLOY.md](docs/DEPLOY.md): LaunchAgent per profile, Docker Compose, dedicated Chrome and several profiles on the same Mac.
- [docs/PLANO.md](docs/PLANO.md): diagnosis, decisions and phases of the migration.

## Development

```bash
bun run test        # vitest (packages/*/test)
bun run typecheck   # tsc --noEmit
```

Continuous integration runs typecheck and tests on Node 22.13.0 and Node 26 (see `.github/workflows/ci.yml`). To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Known limitations

- **Browser sources (X and Instagram) violate those networks' Terms of Use.** Use a secondary reading account, keep the volume low (the sources' limits exist for that reason) and treat them as optional. They require a dedicated Chrome that is open and logged in.
- **Automatic publishing exists only through Buffer.** There is no direct integration with LinkedIn, Instagram or TikTok. For those networks, use Buffer or the `manual` mode.
- **Buffer quota not yet wired to the publisher.** The `publishers` package already has the shared per-organization quota counter and the full-queue check (limit of scheduled posts per channel, on the Free plan), but the publisher does not use those checks yet. Until they are wired, the only cap is the destination's `dailyCap`.
- **One Buffer channel per platform.** Set `BUFFER_CHANNEL_<PLATFORM>` or `channelEnv` on the destination. Without the variable, the channel is only discovered if exactly one is connected to the account.
- **Buffer media needs public hosting.** Configure `IMGBB_API_KEY` or the `R2_*` variables. Without them, Buffer receives only the text and the destination loses its media.
- **Third-party video depends on yt-dlp.** Without it, only images are used.
- **Docker does not serve browser sources.** `BROWSER_CDP_URL` only accepts `127.0.0.1` (Chrome must be on the same machine and network namespace). For those profiles, use the LaunchAgent.
- **Bot authorization is per chat.** Use a private chat; in a group, set `TELEGRAM_ALLOWED_USER_IDS`.
- **The `publish` and `metrics` intervals are not scheduled.** Only `ingest` and `pipeline` run as jobs.

## License

To be decided. This repository does not yet have a license file: use, copying and redistribution are not authorized until a license is published.
