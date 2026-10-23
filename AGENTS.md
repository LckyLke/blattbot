# AGENTS.md

Instructions for coding agents working in this repository. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md), which has the same facts in more detail.

## What this is

BlattBot is a local app for agentic LaTeX editing on Overleaf projects, run with `npx blattbot`. npm workspaces:

- `server/`: the published `blattbot` package. Fastify + TypeScript, ESM, `NodeNext` imports (write `./foo.js` for `foo.ts`). `server/src/index.ts` only bootstraps the app; HTTP routes live in `server/src/routes/` (one module per area, each exporting `registerXRoutes(app)`) and `server/src/research/routes.ts`. The agent-turn pipeline is `server/src/turn-runner.ts`. Agent harnesses are in `server/src/backends/`; every model tool is defined once in `server/src/backends/tools.ts`. Overleaf sync and push are in `server/src/sync.ts` and `server/src/overleaf/`; server-side three-way merges go through `server/src/merge.ts`. The CLI is `server/bin/blattbot.js` (plain JS over the compiled `server/dist/`).
- `web/`: React + Vite frontend, served by the server.
- `server/test/`: all unit tests, including web tests (`server/test/*.tsx` import from `web/src`).
- `server/scripts/`: browser verify scripts, `mock-overleaf.ts` (in-memory Overleaf CE), e2e scripts.
- `docs/`: the website (GitHub Pages). `scripts/`: release tooling.

Node 22.13+ is required (`node:sqlite`).

## Commands

```bash
npm ci
npm run check                 # typecheck + lint + unit tests; run before you finish
npm run typecheck             # server, web, server/test/*.tsx, server/scripts
npm run lint                  # Biome, lint only; formatting is not enforced
npm test                      # vitest (server workspace)
npx vitest run test/chats.test.ts   # one file, from server/
npm run build                 # web + server
npm run build --workspace=web && npm run verify:ui   # browser checks, no model, no TeX
```

`npm run verify:ui` needs Chrome/Chromium; set `BLATTBOT_BROWSER_EXECUTABLE` if it is not at `/usr/bin/chromium` or `/usr/bin/google-chrome`. Do not run `server/scripts/e2e.ts` or `ui-e2e.ts` unless asked: they make real model calls.

## Rules

- Tests never touch the real data dir. Use a temp dir per test with `vi.stubEnv("BLATTBOT_DATA_DIR", dir)` and `vi.resetModules()` in `beforeEach`, then `await import("../src/…")`; `vi.unstubAllEnvs()` and `rmSync(dir, { recursive: true, force: true, maxRetries: 10 })` in `afterEach`. Route tests also stub `BLATTBOT_PORT` and import `../src/index.js`.
- Verify scripts get ports from `freePort()` (`server/scripts/free-port.ts`), never fixed numbers.
- Keep it portable: unit tests run on Ubuntu, macOS and Windows. Use `join`/`resolve` for paths; symlinks may fail on Windows (catch, or copy instead); fake executables need a `.js` + `.cmd` shim on Windows; spawn `process.execPath` with `--import tsx` rather than `npx`.
- Every user-visible change gets a bullet under `## Unreleased` in `CHANGELOG.md`.
- Keep the diff focused. Do not reformat files you are not changing (Biome's formatter is off on purpose).
- Never commit `.claude/settings.local.json` or other personal settings.
- Keep the Overleaf promises: nothing reaches Overleaf without the user's approval, a push never overwrites a co-author's edit silently (merge line by line or refuse), and existing documents are edited in place so comments and tracked changes survive. `server/test/sync-safety.test.ts` and the mock in `server/scripts/mock-overleaf.ts` cover these; extend them when you touch sync or push.
