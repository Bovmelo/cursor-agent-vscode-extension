# Changelog

## Unreleased

- Background jobs in **ready to apply** state list pending files in the Workspace tree and Run Center; click a file to open the baseline ↔ worktree diff before apply/discard

## 0.2.0 - 2026-07-20

- Added a goal-first Ask / Change / Delegate / Review entry point and Safe / Balanced / Automation execution presets (Settings schema + status-bar / chat footer discoverability)
- Added a Workspace Run Center that unifies plan, progress, changes, verification, errors, and recovery actions across chat, Supervisor, and background runs
- Run Center change rows open session or Supervisor diffs; Japanese sidebar labels; chat error banners and desktop notifications link to Retry / Export diagnostics / Open Run Center
- Added redacted diagnostic export (including background jobs, Run Center, Supervisor, shared-audit health, and profile match), log/retry actions for failed runs, and visible shared-audit write health
- Versioned and bounded conversation persistence with serialized debounced writes, migration, pruning, and shutdown flush
- Hardened attachments with file/count/batch limits, dangerous-type and symlink rejection, exact managed-root recovery/deletion, and retained orphan cleanup
- Replaced fixed background polling with an adaptive one-shot scheduler, durable repository boundary, and pure fail-closed state machine
- Extracted Webview CSS/client assets, introduced a shared typed message contract, and strengthened keyboard focus/live-region validation
- Added a provider-neutral Agent backend boundary with Cursor SDK capability negotiation (test-only `MockAgentBackend`)
- Extracted chat send/queue, conversation UI, setup checklist, Run Center host snapshot, and diagnostics collect helpers from `extension.ts`
- Added lint, formatting, coverage, dependency-audit, Webview accessibility, and cross-platform quality gates
- Replaced the vulnerable transitive `undici@5` production path with a pinned `undici@7.28.0` override and removed all temporary audit exceptions
- Hardened Extension Host E2E coverage (setup checklist, Run Center, diagnostics dry-run, retry probe), Workspace Trust gates, and API-key handling paths
- Expanded CI to include macOS validate + darwin-arm64 package smoke; Extension Host E2E stays Linux/Windows-only
- Fixed release workflow Marketplace publish predictability (concurrency, skip warning when `VSCE_PAT` unset, publish preflight)
- Added a first-run setup checklist in the Agent sidebar with dismiss/completion persisted in workspace state
- Extracted `githubIssues.ts` / `taskPipeline.ts` helpers; PATH-shim integration tests for `gitWorkflow` create/retry PR paths
- Untrusted E2E asserts trust gates for Create PR, Task Pipeline, and Supervisor GitHub scan (not only background agents)

## 0.1.19 - 2026-07-18

- Enforce Workspace Trust at every privileged execution boundary, including hooks, verification, Supervisor/background agents, and SDK sandbox fallback paths
- Persist detached worker process identity and hard-stop terminal cancellations so orphan recovery cannot revive or leave background work running
- Add accessible webview controls and status semantics, plus real VS Code 1.101 Extension Host E2E coverage on Windows and Linux CI
- Keep isolated-worktree file identity checks compatible with Node 22 on Windows while retaining symlink, junction, and hard-link rejection
- Unlink agent-created worktree symlinks and junctions before Git cleanup so external targets cannot be traversed or deleted
- Show `/orchestrate` detail as a visual flow: Plan → parallel subtasks → always-visible Synthesis (parallel bar ordered the same way)
- Collapse the chat Working/処理中 progress accordion by default while a run is in progress; users can still expand it to inspect steps
- Hand off truncated prior chat history into the `/orchestrate` planning prompt (`orchestrateHandoffConversation`, default on) so the planner can embed needed context into standalone subtask instructions
- Make the PARALLEL AGENTS bar more compact so more chat space stays available above the composer
- Restore chat input focus synchronously when Typeless hands control back, preventing its text from arriving before the prompt caret is ready
- Prevent chat runs from remaining on "Preparing the run" indefinitely by showing connection phases, allowing cancellation before a Run handle exists, and discarding stalled SDK runs after a configurable timeout
- Feed `/orchestrate` subtask summaries and changed files into the synthesis prompt so the final pass reconciles real results instead of rediscovering work
- Run `/compare` candidate verification inside each isolated worktree, auto-select a winner from verification and quality signals (`bestOfNAutoSelect`), and break ties with an optional plan-mode AI judge (`bestOfNAutoJudge`)
- Default `bestOfNAutoJudge` to off so tied `/compare` scores do not spend plan quota on an AI judge unless explicitly enabled
- Weight `/compare` auto-select toward candidates with isolated change artifacts, and offer apply/PR actions only when the winner has one
- Keep Rules/Skills/MCP toggles sibling-safe across same-named multi-root folders while still honoring and migrating legacy disabled IDs
- Bound chat run cleanup to `runPreparationTimeoutSeconds` with a 60s floor so slow cancel/dispose is less likely to prompt a false reload, and delay orphan worktree removal behind a live-lease check plus a 10-minute grace period
- When PR creation fails after a successful branch commit, preserve the commit and offer checkout / retry-PR recovery actions with stage-aware guidance (push vs `gh pr create`)
- Scope automatic repair prompts to the failing verification output and the session's edited files

## 0.1.18 - 2026-07-18

- Merge the five sidebar tree views into one **Workspace** tree (Sessions / Inbox / Rules / Background / Audit) so the Agent chat view can use more vertical space
- Let queued follow-ups launch as additional parallel agents (same slot limit), and requeue messages that fail before a run is reserved
- Harden remaining safety gaps: run hooks/verification via `execFile` (no shell), symlink-aware path containment, transactional isolated apply with rollback, shared chat/Supervisor apply queue and file ownership, unified sensitive-path defaults, and skip baseline backups for excluded paths
- Scrub secret-like files from isolated worktrees before agents run, run pre-edit hooks for Supervisor/background worktrees, and drop background-worker API key copies after agent creation
- Route Windows `.cmd` hooks through `cmd.exe`, and tighten chat UI with compact sessions and a collapsible sandbox banner

## 0.1.17 - 2026-07-18

- Show `/orchestrate` phase and agent board on the home view, group parallel-bar chips by experiment, and label SDK subagent names in tool progress
- Surface live tool/file activity on each `/orchestrate` agent row and parallel-bar chip so stages show where they are working
- Add in-conversation text search (find bar with highlight and prev/next, Ctrl/Cmd+F and Cursor: Find in Chat command)

## 0.1.16 - 2026-07-17

- Add Supervisor TODO(ai) and failed-test triggers, task priority ordering, and an optional AI review gate before apply
- Add **Cursor: Run Task Pipeline** (GitHub Issue / TODO(ai) / free text → Autopilot → verify → optional auto PR)
- Add `/orchestrate` planning, parallel subtask fan-out, and synthesis
- Add daily token budget warnings, AI audit-log export, Workspace Trust restrictions, and a Rules/Skills/MCP management view
- Promote inline completions to a production-ready path with configurable limits, in-flight deduplication, project rules, token/cost guards, and acceptance metrics
- Run dependency-aware Supervisor tasks concurrently in isolated worktrees, reserve file ownership, and serialize safe automatic apply
- Detect failed GitHub CI checks and actionable PR feedback through `gh`, with optional trusted-workspace polling
- Show build/lint/test/E2E verification gates, compare change-session file sets, and support configurable Keep-all/Restore-all review policies
- Turn Plan-profile artifacts into sequential executable steps with an independent change-session checkpoint for every step
- Keep `/compare` candidates isolated, then apply only the selected winner or create a PR from it
- Add monthly token and user-priced estimated-cost guardrails alongside the daily budget
- Add explicit file ownership and a FIFO merge queue for normal parallel chat agents
- Add detached background agents that survive VS Code restarts, keep edits isolated, and expose apply/cancel/discard controls
- Persist repair budgets in change sessions and visualize repairing, success, and exhaustion states
- Persist per-session result content and open real file diffs between adjacent sessions
- Add an interactive AI audit timeline and an optional team-shared workspace JSONL log

## 0.1.15

- Recover orphaned Safe/parallel chat worktrees after crashes and clean up partially prepared worktrees
- Run pre-edit hooks before capturing isolated-worktree baselines so hook output is not attributed to the agent
- Validate real Git worktree creation, junction/symlink linking, failure cleanup, and orphan recovery on Windows and Ubuntu CI
- Document local retention, Cursor transmission, MCP/command execution, and telemetry behavior in English and Japanese
- Align Node.js type definitions with the supported Node 22.13 runtime and tighten the Marketplace parallel-agent screenshot

## 0.1.14

- Persist each chat's workspace folder in multi-root workspaces, and let the footer label pick a different root
- Automatically three-way merge non-overlapping parallel-agent edits, with confirmed AI-assisted resolution for overlapping text conflicts
- Default and migrate Windows to Safe worktree mode, require a first-run sandbox warning acknowledgement, and keep a non-dismissible warning visible during direct-workspace modes

## 0.1.13

- Show token usage on the chat home view (today, last 7 days, chat vs Supervisor, conversation totals)
- Track daily usage for chat and AI Supervisor runs in private workspace storage
- Add conversation search, pin/unpin, and Markdown export from the history list
- Load Cursor-style slash commands from `.cursor/commands/*.md` and `~/.cursor/commands/*.md`
- Add a composer chip to include or exclude project memory for the next send
- Add `/compare` best-of-N parallel runs with side-by-side comparison and winner selection
- Show a pre-send context preview with a rough token estimate
- Offer branch + pull request creation via `gh` after successful verification, plus **Cursor: Create Branch and Pull Request**
- Resolve chat/Supervisor cwd from the active editor workspace folder when possible
- Index files, Skills, MCP servers, and project commands across multi-root workspace folders
- Add configurable `preEditCommands` / `postEditCommands` hooks around AI edit sessions
- Make Supervisor safe auto-apply globs configurable
- Add unit tests for usage, best-of-N, context estimate, multi-root path helpers, and pure utilities

## 0.1.12

- Add an AI Supervisor inbox with Observe and Autonomous modes for saved diagnostics and manual goals
- Run Supervisor tasks in isolated Git worktrees without committing dirty workspace baselines
- Add per-file and bulk apply/discard with concurrent-edit conflict detection
- Add file, changed-line, time, hourly-run, excluded-path, and safe-auto-apply budgets
- Stop restoring chat focus when the user has moved to another editor or view
- Keep Supervisor worktrees on a short path so Cursor SDK SQLite storage opens on Windows, and show failure reasons in the inbox
- Give AI Supervisor an independent agent runner so normal chat remains available during background work
- Record a reason for every Supervisor file change and show it in the inbox and diff editor
- Keep the current Supervisor mode visible in the inbox header, mode row, and status bar
- Run normal chat agents concurrently across conversations with per-conversation runs, queues, cancellation, and live state
- Track concurrent AI change sessions by session ID and show running conversations in history
- Add a persistent parallel-agent bar for switching tasks, stopping one agent at a time, and retaining completed parallel tasks until they are opened and left
- Add a prominent Start parallel agent button with parallel-limit feedback
- Add a master switch and individual settings for every AI-native editor feature, with a settings shortcut in the chat header
- Add Autopilot change sessions with a task-oriented progress view and safe session revert
- Add post-run Keep/Restore review per Autopilot-edited file and defer verification until decisions are complete
- Keep the latest 20 AI change sessions and preserve dirty working-tree baselines in private checkpoints
- Preview generated inline edits in a diff before applying them
- Add AI Quick Fix actions for editor diagnostics and line-level AI review findings in Problems
- Automatically detect and run project verification commands after agent edits, with optional bounded self-repair
- Add project-memory refresh, debug-context analysis, and experimental quota-aware inline completions

## 0.1.11

- Restore the prompt caret after Typeless or another dictation tool temporarily takes focus
- Add an in-chat setting for enabling or disabling run completion notifications
- Apply sound setting changes immediately while an agent run is in progress
- Finalize completed runs even when the SDK event stream is slow to close, and recover stale active runs
- Keep the chat prompt focused when Typeless returns text after briefly taking system focus
- Show a persistent hint that file drag-and-drop requires holding Shift
- Restore the prompt even when Typeless moves focus outside the webview after inserting text

## 0.1.10

- Add in-chat toggles for running, completion, and error sounds
- Keep sound preferences synchronized with VS Code settings across platforms

## 0.1.9

- Keep chat from auto-scrolling away while reading older messages
- Prefer plain-text paste so voice tools like Typeless can insert into the prompt
- Do not treat IME / dictation confirmation Enter as send

## 0.1.8

- Play a distinct alert when an agent run fails
- Improve drag/drop and paste file attachments in chat

## 0.1.7

- Improve Marketplace Details (README overview)

## 0.1.6

- Show extension version in the chat footer
- Configurable agent sound cues
- Marketplace packaging: extension icon, publisher metadata

## 0.1.0

- Initial local release of Cursor Agent chat for VS Code
