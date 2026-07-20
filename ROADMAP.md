# Roadmap — cursor-subscription-for-vscode

**Marketplace id:** `ark4ez.cursor-subscription-for-vscode`

**Unofficial** community extension. Not affiliated with Anysphere / Cursor. Built on the public [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript) (**beta**; APIs may change). Usage follows **your** Cursor plan and user API key (SecretStorage only — never committed or logged).

日本語は下の [日本語](#日本語) を参照してください。

## Chosen growth direction: stabilize toward 0.2.x

The next product line is **hardening and operability for a trustworthy 0.2.x**, not a wave of new Supervisor or automation surfaces. Existing chat, Safe worktree, Supervisor, pipeline, and parallel-agent behavior should become easier to verify, ship, and onboard before we expand those systems further.

**Out of scope for this phase:** net-new Supervisor modes, broader automation product features, or large capability bets that grow the orchestration surface before the foundation below lands.

### Priority themes (in order)

1. **E2E / trust / API-key hardening** — largely landed
   Extension Host E2E covers Restricted Mode gates for background agents, Create PR, Task Pipeline, and Supervisor GitHub scan. Keep API-key handling defensive (SecretStorage, stdin-only worker paths, no key material in job files, logs, or docs). Continue deepening privileged-path coverage as new automation lands.

2. **CI including macOS + predictable Marketplace publish** — largely landed
   `validate` runs on Linux / Windows / **macOS**; `package-smoke` packages `darwin-arm64` on PRs. Extension Host E2E stays Linux/Windows-only (headless Electron). Release concurrency, Marketplace skip warnings, and publish preflight improve tag→VSIX→Marketplace predictability.

3. **Extract chat send/queue helpers from the `extension.ts` monolith** — initial extract done (`chatSendQueue.ts`)
   Continue extracting pure helpers where tests need them; controllers and VS Code/SDK I/O stay where they belong.

4. **First-run onboarding checklist** — done
   Agent sidebar checklist covers API key, trust, Git, permission mode, and optional `gh`.

5. **Mocked integration tests for GitHub / pipeline paths** — largely landed
   Supervisor GitHub scan unit + wiring contracts; `githubIssues` / `taskPipeline` mocked and pure tests. Optional next: deeper `gitWorkflow` PATH-shim create/retry sequences.

### Positioning we will keep honest

- Unofficial; not Cursor desktop session login.
- SDK is beta — defensive resume/create and sandbox-unavailable handling stay required.
- On Windows, **Safe worktree** reduces accidental workspace edits; it is **not** an OS security boundary. Direct-workspace modes still need explicit confirmation.

### Implemented 0.2 foundation

- Goal-first Ask / Change / Delegate / Review entry point and Safe / Balanced / Automation presets
- Run Center for plan, progress, changes, verification, error detail, and recovery across chat, Supervisor, and background work
- Versioned bounded persistence, managed attachment retention, adaptive background recovery, and redacted diagnostics
- Extracted Webview assets and message contract, backend capability boundary, and expanded quality / accessibility gates

**0.2.0 cut (2026-07-20):** foundation above is released. Follow-up work should validate recovery success and time-to-first-success with real users, continue `extension.ts` decomposition, and deepen E2E before adding new autonomous modes. In-run SDK steering remains blocked until Cursor exposes a public API (cancel + priority resend stays the interrupt model).

See also: [README](./README.md), [Changelog](./CHANGELOG.md).

---

## 日本語

**Marketplace ID:** `ark4ez.cursor-subscription-for-vscode`

Anysphere / Cursor 非提携の**非公式**拡張機能です。公開 [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript)（**ベータ**。API は変わり得ます）を使い、ユーザー API キー（VS Code SecretStorage のみ。リポジトリやログへは書きません）とご自身のプランで動作します。

## 成長方針: 0.2.x に向けた安定化

次の製品ラインは、Supervisor / 自動化の**新機能追加**ではなく、**信頼できる 0.2.x のための硬化と運用性**です。既存のチャット、安全 worktree、Supervisor、パイプライン、並列 Agent を検証・配布・初回導線の面で固めてから、それらの拡張に進みます。

**このフェーズの対象外:** 新しい Supervisor モードや、基盤が固まる前にオーケストレーション面を広げる大規模な自動化機能。

### 優先テーマ（順）

1. **E2E / Trust / APIキーの硬化** — おおむね完了
   Restricted Mode で background / Create PR / Task Pipeline / Supervisor GitHub スキャンの Trust ゲートを E2E 検証。APIキーは SecretStorage + ワーカー stdin のみ。新自動化追加時も特権経路のカバーを続ける。

2. **macOS を含む CI と予測可能な Marketplace 公開** — おおむね完了
   `validate` は Linux / Windows / **macOS**。PR で `darwin-arm64` の `package-smoke`。E2E は Linux/Windows のみ。リリースの concurrency・Marketplace スキップ警告・preflight で公開手順を予測可能に。

3. **`extension.ts` モノリスからのチャット送信 / キュー補助の抽出** — 初期抽出済み（`chatSendQueue.ts`）。必要なら追加の純粋ロジック切り出しを続ける。

4. **初回オンボーディングチェックリスト** — 実装済み。

5. **GitHub / パイプライン経路のモック統合テスト** — おおむね完了
   Supervisor GitHub 検出ユニット + wiring、`githubIssues` / `taskPipeline` のモック・純粋テスト。任意の次: `gitWorkflow` の create/retry PATH シム統合。

### 正直に保つ位置づけ

- 非公式。Cursor デスクトップのログインセッションは使わない。
- SDK はベータ — resume / create 失敗やサンドボックス不可への防御的扱いを維持する。
- Windows の**安全 worktree**は意図しないワークスペース編集を抑えるが、**OS のセキュリティ境界ではない**。ワークスペース直接実行モードには明示確認が必要。

### 実装済みの0.2基盤

- 質問 / 変更 / 委譲 / 確認・適用の目的別入口と、安全重視 / バランス / 自動化重視プリセット
- チャット・Supervisor・バックグラウンド実行の計画、進捗、変更、検証、エラー、復旧を統合するRun Center
- バージョン付き容量制限保存、管理対象添付の保持、適応型バックグラウンド復旧、機密情報除外済み診断
- Webview資産とmessage契約の分離、backend capability境界、品質・アクセシビリティゲート

**0.2.0 カット（2026-07-20）:** 上記基盤をリリース済み。次は実利用での復旧成功率と初回成功までの時間の検証、`extension.ts` 分割の継続、E2E の深化を優先し、新しい自律モードは後回しにします。実行中の SDK ステアリングは公開 API 待ち（現状は cancel + 優先再送）。

関連: [README](./README.md)、[Changelog](./CHANGELOG.md)。
