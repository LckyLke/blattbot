# Contributing to BlattBot

Thanks for helping. This page covers the repository layout, the commands you need, and what a pull request should contain. Security problems go through private reporting, see [SECURITY.md](SECURITY.md#reporting).

## Setup

You need Node 22.13 or newer (Node 24 recommended) and git.

```bash
git clone https://github.com/LckyLke/blattbot.git
cd blattbot
npm ci
npm run dev        # builds the web app once, then the server on http://127.0.0.1:4560
npm run dev:web    # optional: Vite dev server with live reload on :4561
```

## Layout

npm workspaces: `server/` is the published `blattbot` package, `web/` is the app it serves.

| Path | What lives there |
| --- | --- |
| `server/src/` | Fastify + TypeScript server. `index.ts` only bootstraps the app; HTTP routes live in `server/src/routes/`, one module per area (Research routes in `server/src/research/routes.ts`). The agent-turn pipeline is `turn-runner.ts`; model tools are defined once in `backends/tools.ts`; Overleaf sync and push are in `sync.ts` and `overleaf/`. |
| `server/src/backends/` | Agent harnesses: Codex (default), Claude Agent SDK, OpenAI-compatible. |
| `server/src/overleaf/` | Overleaf cookie sync, browser cookie discovery, realtime (OT) client. |
| `server/src/research/` | Research workspace: library, citation graph, evidence checks. |
| `server/bin/blattbot.js` | The `npx blattbot` CLI: plain Node ESM over the compiled `server/dist/`. |
| `server/test/` | Vitest suites for the server **and** the web app (`*.tsx` files render real `web/src` components with `react-dom/server`). `web/` has no test runner of its own. |
| `server/scripts/` | Browser verify scripts, the mock Overleaf server, end-to-end scripts, website demo recording. |
| `web/src/` | React + Vite frontend. |
| `docs/` | The website (GitHub Pages, blattbot.com). See `server/scripts/SITE_DEMOS.md`. |
| `scripts/` | Release tooling (`release.mjs`, `release-pack.mjs`, `release-notes.mjs`). |

## Checks

```bash
npm run check          # typecheck + lint + unit tests: what CI runs on every OS
npm run typecheck      # server, web, server/test/*.tsx and server/scripts
npm run lint           # Biome, lint only (formatting is not enforced)
npm test               # unit tests (vitest, in server/)
npm run coverage --workspace=server   # unit tests with a V8 coverage report in server/coverage/
npm run build          # web bundle + compiled server
npm run release:pack   # the npm tarball, exactly as published
```

### Writing tests

Tests must never touch your real data dir (`~/.local/share/blattbot`). Modules read `BLATTBOT_DATA_DIR` when they load, so point it at a temp dir and reload modules in every test:

```ts
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blattbot-example-"));
  vi.stubEnv("BLATTBOT_DATA_DIR", dir);
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
// then: const config = await import("../src/config.js");
```

Route tests also stub `BLATTBOT_PORT` and `await import("../src/index.js")`, which boots the real server in-process.

### Mock Overleaf and browser checks

`server/scripts/mock-overleaf.ts` is an in-memory Overleaf Community Edition with the endpoints cookie sync uses (dashboard, zip download, uploads, compile, and the socket.io realtime/OT protocol). The browser verify scripts in `server/scripts/*-verify.ts` boot an isolated server and data dir against it, then drive the real UI with Playwright. They pick free ports at runtime.

```bash
npm run build --workspace=web
npm run verify:ui                        # every check that needs no real model and no TeX
npm run verify:ui -- sync-ui refs-cleanup-ui   # a subset
npm run test:ui --workspace=server       # the big UI walkthrough; compiles real LaTeX
```

- `BLATTBOT_BROWSER_EXECUTABLE`: Chrome/Chromium to use when it is not at `/usr/bin/chromium` or `/usr/bin/google-chrome`.
- `BLATTBOT_VERIFY_TECTONIC`: tectonic binary for `test:ui` when no TeX engine is on PATH.
- `UI_SHOTS_DIR`: where most scripts save screenshots (default: a folder under `/tmp`).

`server/scripts/e2e.ts` and `ui-e2e.ts` run real agent turns and cost model usage; run them only on purpose.

## Windows pitfalls

CI runs the unit tests on Windows, so keep code and tests portable:

- Build paths with `join`/`resolve`. A POSIX literal like `"/proj"` is not absolute on Windows; use `resolve("/proj")`.
- Symlinks need Developer Mode or admin rights. Tests that create one must catch the failure (or use a `"junction"` for directories); scripts should copy files instead.
- Extensionless scripts with a shebang do not run. Fake executables need a `.js` file plus a `.cmd` shim.
- `npx` and other `.cmd` shims cannot be spawned without a shell. Spawn `process.execPath` with `--import tsx` instead.
- POSIX file modes do not exist (`chmod` is a no-op), and open files block `rmSync`; pass `maxRetries`.

## Pull requests

- Keep changes focused, and run `npm run check` before pushing.
- Every user-visible change needs an entry under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md).
- Do not commit personal settings (`.claude/settings.local.json` is ignored).

## Releases (maintainers)

```bash
npm run release -- 0.5.0 --dry-run   # show the plan
npm run release -- 0.5.0             # bump versions, date the CHANGELOG section, commit, tag v0.5.0
git push origin main v0.5.0          # the tag starts .github/workflows/release.yml
```

The script never pushes or publishes. The Release workflow reruns the full CI and attaches the npm tarball to a GitHub Release; `npm publish` stays manual.
