# Project memory — cursor-subscription-for-vscode

Evidence-based notes for agents. No secrets. Refresh with **Cursor: Refresh Project Memory** when architecture drifts.

## What this is

- Marketplace id: `ark4ez.cursor-subscription-for-vscode`
- VS Code extension (`engines.vscode`: `^1.101.0`) that runs **local Cursor agents** with a user API key via `@cursor/sdk` (beta)
- Depends on built-in `vscode.git`; GitHub CLI (`gh`) for PR / Task Pipeline / Supervisor GitHub scans
- Node runtime expectation: **22.13+** (SDK local agent)

## Layout

| Path | Role |
| --- | --- |
| `src/extension.ts` | Activation, commands, chat send/queue, Autopilot, pipeline, orchestrate/compare wiring (~7k lines) |
| `src/webviewController.ts` | Agent sidebar webview: HTML/CSS/client JS template (~6k lines) |
| `src/agentFactory.ts` | SDK `Agent.create` / `resume`, sandbox fallback, built-in subagents |
| `src/chatRuntime.ts` | Per-conversation mutable run state |
| `src/chatSendQueue.ts` | Pure chat enqueue / interrupt / parallel-slot helpers (wired from `extension.ts`; re-exported via `safety.ts` where needed) |
| `src/chatTypes.ts` | Conversation / queue / profile types |
| `src/conversationStore.ts` | Persist/restore transcripts in workspace state |
| `src/safety.ts` | Approval modes, path/baseline apply guards, webview message parse (queue helpers re-exported from `chatSendQueue.ts`) |
| `src/isolatedWorktree.ts` | Prepare/collect/apply/cleanup isolated edits + AI conflict resolution |
| `src/worktreeLifecycle.ts` | Managed worktree create/remove, node_modules link, orphan cleanup |
| `src/parallelOwnership.ts` | File ownership leases + FIFO apply queue |
| `src/threeWayMerge.ts` | Non-overlapping parallel edit merge |
| `src/supervisor.ts` / `supervisorRunner.ts` / `supervisorScheduling.ts` | Inbox, modes, budgets, dependency-aware parallel tasks |
| `src/aiNative.ts` | Change sessions, verification, review findings, code actions |
| `src/backgroundJobs.ts` / `backgroundWorker.ts` / `backgroundJobTypes.ts` | Detached workers that outlive the window |
| `src/orchestrator.ts` / `bestOfN.ts` / `executionPlan.ts` | `/orchestrate`, `/compare`, Plan→checkpoint steps |
| `src/workspaceSidebar.ts` | Single Workspace tree (Sessions / Inbox / Rules / Background / Audit) |
| `src/integrationCatalog*.ts` / `integrationToggles.ts` | Rules, Skills, MCP, commands listing + enable/disable |
| `src/hooks.ts` / `shellCommand.ts` | pre/post-edit and verification via `execFile` |
| `src/sensitivePaths.ts` / `sensitivePathMatch.ts` | Exclude/scrub globs for apply and worktree secret content |
| `src/gitWorkflow.ts` / `gitWorkflowPure.ts` / `githubTriggers.ts` / `githubIssues.ts` / `gitApi.ts` | PR creation, CI/PR feedback, `gh issue list` |
| `src/taskPipeline.ts` | Pure Task Pipeline goal / pending-PR / prompt helpers (wired from `extension.ts`) |
| `src/runCenter.ts` / `runCenterCoordinator.ts` / `runCenterModel.ts` / `runCenterSnapshot.ts` | Workspace Run Center tree + host snapshot → state |
| `src/workflowController.ts` / `workflowRecipes.ts` / `executionProfiles.ts` | Goal-first entry + Safe/Balanced/Automation presets |
| `src/diagnosticsBundle.ts` / `diagnosticsCollectors.ts` / `diagnosticsCollect.ts` / `diagnosticsController.ts` | Redacted diagnostics export |
| `src/conversationUi.ts` / `setupChecklistState.ts` / `chatSendQueue.ts` | Pure chat UI / checklist / queue helpers |
| `src/agentBackend.ts` | Provider-neutral Agent backend; production `CursorSdkBackend` |
| `src/inlineCompletion.ts` | Opt-in completions helpers (limits, sanitize, acceptance rate) |
| `src/usageStats.ts` / `auditLog.ts` / `auditTimeline.ts` | Token budgets and audit UI/log |
| `media/webview.css` / `media/webview.js` | Extracted Agent webview assets (host in `webviewController.ts`) |
| `package.json` + `package.nls*.json` | Contributes, settings, i18n |
| `test/*.test.mjs` | Node test runner against compiled `out/` |
| `scripts/validate-webview.mjs` | Ensures webview HTML template still evaluates |
| `out/` | **Generated** TypeScript emit (gitignored) |

## Runtime topology

```
VS Code host
├── Cursor Activity Bar
│   ├── Agent view → WebviewController ↔ extension chat path → AgentFactory → @cursor/sdk
│   └── Workspace tree → sessions / supervisor inbox / integrations / background / audit
├── AiSupervisorController → SupervisorAgentRunner (separate from chat agents)
├── BackgroundJobsController → spawned backgroundWorker (stdin API key, job file status)
└── SecretStorage: cursorSubscription.apiKey
```

- One **SDK agent + run per conversation**; parallel chats use separate conversations and a slot limit (`cursorSubscription.maxParallelChatAgents`).
- Permission modes: `safe-worktree` | `auto-review` | `full-access`. Windows defaults to safe-worktree (no local SDK sandbox).
- Project guidance injection: when enabled, prompts tell the agent to read `.cursor/rules.md` and/or `.cursor/project-memory.md` (respect integration toggles + `includeProjectMemory`).

## Validation commands

```bash
npm run compile          # tsc → out/
npm run validate:webview # webview template smoke check
npm run test             # compile + node --test test/*.test.mjs
npm run validate         # compile + webview + tests (also vscode:prepublish)
npm run package          # vsce package
```

Default verification discovery (change sessions): npm scripts named `validate`, `compile`, `lint`, or `test` unless `cursorSubscription.verificationCommands` overrides.

## Conventions

- ESM TypeScript: import sibling modules with **`.js` extensions** (`import { X } from "./foo.js"`).
- Pure/state-machine logic → small modules + tests; VS Code API and SDK I/O stay in controllers/`extension.ts`.
- Setting/command namespace: `cursorSubscription.*`.
- Webview ↔ host messages: parse through `parseWebviewMessage` in `safety.ts` rather than trusting raw shapes.
- i18n: keep EN/JA pairs together when adding strings.

## Generated / local-only (do not treat as source of truth)

- `out/**` — compile output
- `*.vsix` — packages
- `node_modules/`
- VS Code SecretStorage, workspaceState, and extension-private globalStorage (conversations, checkpoints, supervisor tasks, background job status, attachment copies)
- Optional team audit file: `.cursor/ai-audit-log.jsonl` when `auditSharedLogEnabled` is on

## Caution areas

1. **`extension.ts` / `webviewController.ts` size** — easy to regress chat queue, parallel bar, or CSP; prefer surgical edits and run `validate`.
2. **Apply / restore correctness** — baseline hash checks, dirty-file protection, three-way merge conflict markers, ownership races between chat/Supervisor/background.
3. **Windows paths** — short managed worktree paths (SDK SQLite), junctions/symlinks for `node_modules`, path containment must stay symlink-aware (`safety.ts` resolved helpers).
4. **Secret material** — never persist API keys in job files or logs; scrub `DEFAULT_SECRET_CONTENT_GLOBS` from isolated worktrees before agents run.
5. **Workspace Trust** — untrusted workspaces must keep autonomous automation limited (`package.json` `untrustedWorkspaces`).
6. **SDK beta** — resume may fail; sandbox-unavailable paths must fall back without stranding conversations.
7. **Quota** — chat, Supervisor, repair, inline completions, and parallel runs can consume plan quota concurrently; avoid accidental double-sends in tests/docs examples.
8. **Lockfiles / env** — default sensitive globs exclude lockfiles and secret-like names from auto-apply; do not “helpfully” apply `.env*` from AI diffs.

## Useful entry points for common tasks

| Task | Start here |
| --- | --- |
| New chat command / send behavior | `extension.ts` (`enqueueMessage` / `send`), `chatSendQueue.ts` |
| Task Pipeline / GitHub issues | `extension.ts` (`runTaskPipeline`), `taskPipeline.ts`, `githubIssues.ts` |
| Chat UI / setup checklist | `webviewController.ts` (sidebar checklist + host `setupChecklistState`) |
| Approval / safe worktree policy | `safety.ts` (`shouldUseIsolatedWorktree`, modes) |
| Worktree apply | `isolatedWorktree.ts`, `parallelOwnership.ts` |
| Supervisor inbox | `supervisor.ts`, `supervisorScheduling.ts` |
| Slash `/orchestrate` or `/compare` | `orchestrator.ts` (plan may get truncated source-chat handoff via `orchestrateHandoffConversation`; synthesis gets subtask summaries/files), `bestOfN.ts` (isolated verify + auto-select/judge), `autoRepair.ts`, wired from `extension.ts` |
| Settings / feature flags | `package.json` `contributes.configuration`, gated via `enableAiNativeFeatures` and per-feature keys |
| Rules/Skills/MCP toggles | `integrationCatalog.ts`, `integrationToggles.ts` |
| Commit message from SCM | `generateCommitMessage.ts` |
