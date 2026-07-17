# Project rules — cursor-subscription-for-vscode

Unofficial VS Code extension that runs Cursor agents via `@cursor/sdk`. Not affiliated with Anysphere / Cursor.

## Before changing code

1. Read `.cursor/project-memory.md` when present for architecture and caution areas.
2. Prefer small, focused diffs. Match existing naming, imports (`./foo.js` ESM), and patterns.
3. Do not commit unless the user asks. Never put secrets, API keys, or `.env` contents into the repo or into `.cursor/project-memory.md`.

## Language and UX

- Keep **English and Japanese** UI strings in sync:
  - Command/setting titles: `package.nls.json` and `package.nls.ja.json`
  - Runtime `localize(english, japanese)` helpers and webview `ui` dictionaries in `webviewController.ts`
- Follow the VS Code display language; do not hardcode one locale in user-visible paths.
- README and Marketplace copy are bilingual; update both sides when user-facing behavior changes.

## Architecture constraints

- **`extension.ts` is the orchestration hub** (activation, chat send path, Supervisor/pipeline wiring). Extract pure logic into modules; avoid growing god-paths without need.
- **Webview HTML/CSS/JS lives inside `webviewController.ts`** as a template literal. After HTML/CSP/script changes, run `npm run validate:webview`.
- Chat and Supervisor must remain **independent runners** (`ChatRuntime` / `SupervisorAgentRunner`). Do not block chat on Supervisor or share one mutable agent across conversations.
- Isolated Git worktrees (`isolatedWorktree.ts`, `worktreeLifecycle.ts`) are the safety backbone on Windows and for parallel/Supervisor/background runs. Preserve conflict checks, baseline restore, and sensitive-path scrubbing.
- Hooks and verification must stay on **`execFile` / no shell** (`shellCommand.ts`, `hooks.ts`). Do not reintroduce shell interpolation for configured commands.
- File apply paths must respect **ownership + FIFO apply queue** (`parallelOwnership.ts`) and sensitive/excluded globs (`sensitivePaths.ts`, `sensitivePathMatch.ts`).

## Safety and privacy (non-negotiable)

- Store the Cursor API key only in **VS Code SecretStorage**. Never log it, never write it into job JSON, settings, transcripts, audit logs, or project memory.
- Background worker (`backgroundWorker.ts`): API key arrives on stdin only; drop the in-memory copy after agent creation.
- Do not weaken Workspace Trust gates that limit autonomous Supervisor, auto-repair, keep-all review, and background agents.
- Windows has no local SDK sandbox: default remains **Safe worktree**; direct-workspace modes need explicit confirmation UX.
- Prefer transactional apply with rollback for isolated changes; never apply if the live workspace file drifted from the baseline.

## TypeScript / packaging

- Target: Node16 ESM, `strict: true`, compile `src/` → `out/`.
- Extension entry: `package.json` `"main": "./out/extension.js"`.
- Tests import compiled `../out/*.js` with `node:test`. Pure helpers belong in small modules with unit tests.
- Do not hand-edit `out/`; change `src/` and compile.
- Avoid drive-by refactors in `extension.ts` / `webviewController.ts` unless the task requires it.

## Validation

Before claiming a change is done, run what applies:

```bash
npm run validate
```

That runs `tsc`, webview template validation, and `test/*.test.mjs`. For narrower work: `npm run compile`, `npm run test`, or `npm run validate:webview`.

## Docs and release surface

- User-visible features: update `README.md` (EN + JA) and `CHANGELOG.md` under Unreleased or the next version section.
- Setting/command IDs use the `cursorSubscription.*` prefix; keep `package.json` contributes aligned with handlers in `extension.ts`.
- Marketplace packaging uses `vsce`; do not ship secrets or local-only paths in the VSIX.

## Product positioning

- This extension uses the **public Cursor TypeScript SDK** and a **user API key**. Do not claim official Cursor affiliation or rely on Cursor desktop login session APIs.
- SDK is beta; prefer defensive handling of resume/create failures and sandbox-unavailable errors.
