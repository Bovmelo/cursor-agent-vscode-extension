# Roadmap — cursor-subscription-for-vscode

**Marketplace id:** `ark4ez.cursor-subscription-for-vscode`

**Unofficial** community extension. Not affiliated with Anysphere / Cursor. Built on the public [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript) (**beta**; APIs may change). Usage follows **your** Cursor plan and user API key (SecretStorage only — never committed or logged).

日本語は下の [日本語](#日本語) を参照してください。

## Chosen growth direction: stabilize toward 0.2.x

The next product line is **hardening and operability for a trustworthy 0.2.x**, not a wave of new Supervisor or automation surfaces. Existing chat, Safe worktree, Supervisor, pipeline, and parallel-agent behavior should become easier to verify, ship, and onboard before we expand those systems further.

**Out of scope for this phase:** net-new Supervisor modes, broader automation product features, or large capability bets that grow the orchestration surface before the foundation below lands.

### Priority themes (in order)

1. **E2E / trust / API-key hardening**  
   Strengthen Extension Host E2E coverage, keep Workspace Trust gates at privileged boundaries, and keep API-key handling defensive (SecretStorage, stdin-only worker paths, no key material in job files, logs, or docs).

2. **CI including macOS + predictable Marketplace publish**  
   Extend continuous validation beyond the current Linux/Windows matrix to include **macOS**, and make release → VSIX → Marketplace publish steps more predictable and repeatable.

3. **Extract chat send/queue helpers from the `extension.ts` monolith**  
   Move pure send/queue orchestration helpers out of the activation hub so chat behavior is testable without growing the god-path further. Controllers and VS Code/SDK I/O stay where they belong; extract logic, do not rewrite the product.

4. **First-run onboarding checklist**  
   Guide new installs through API key, trust, Git / Safe worktree expectations (especially on Windows, where the local SDK sandbox is unavailable and **Safe worktree** remains the default), and optional `gh` setup — without claiming OS-level isolation.

5. **Mocked integration tests for GitHub / pipeline paths**  
   Cover Task Pipeline, PR, and Supervisor GitHub-scan flows with mocked `gh` / integration boundaries so regressions are caught without live network or credentials.

### Positioning we will keep honest

- Unofficial; not Cursor desktop session login.
- SDK is beta — defensive resume/create and sandbox-unavailable handling stay required.
- On Windows, **Safe worktree** reduces accidental workspace edits; it is **not** an OS security boundary. Direct-workspace modes still need explicit confirmation.

See also: [README](./README.md), [Changelog](./CHANGELOG.md).

---

## 日本語

**Marketplace ID:** `ark4ez.cursor-subscription-for-vscode`

Anysphere / Cursor 非提携の**非公式**拡張機能です。公開 [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript)（**ベータ**。API は変わり得ます）を使い、ユーザー API キー（VS Code SecretStorage のみ。リポジトリやログへは書きません）とご自身のプランで動作します。

## 成長方針: 0.2.x に向けた安定化

次の製品ラインは、Supervisor / 自動化の**新機能追加**ではなく、**信頼できる 0.2.x のための硬化と運用性**です。既存のチャット、安全 worktree、Supervisor、パイプライン、並列 Agent を検証・配布・初回導線の面で固めてから、それらの拡張に進みます。

**このフェーズの対象外:** 新しい Supervisor モードや、基盤が固まる前にオーケストレーション面を広げる大規模な自動化機能。

### 優先テーマ（順）

1. **E2E / Trust / APIキーの硬化**  
   Extension Host E2E、特権境界での Workspace Trust、APIキー経路（SecretStorage、ワーカーへの stdin のみ、ジョブファイル・ログ・ドキュメントへの鍵の非混入）を強化する。

2. **macOS を含む CI と予測可能な Marketplace 公開**  
   現行の Linux / Windows 検証に加え **macOS** を継続検証に含め、リリース → VSIX → Marketplace 公開をより予測可能で再現しやすくする。

3. **`extension.ts` モノリスからのチャット送信 / キュー補助の抽出** — 初期抽出済み（`chatSendQueue.ts`）。必要なら追加の純粋ロジック切り出しを続ける。

4. **初回オンボーディングチェックリスト** — Agent サイドバーに実装済み（APIキー、Trust、Git、権限モード、任意の `gh`）。OS レベルの隔離は主張しない。

5. **GitHub / パイプライン経路のモック統合テスト**  
   Supervisor の GitHub 検出ユニットテストは強化済み。タスクパイプライン全体のモック統合は継続。

### 正直に保つ位置づけ

- 非公式。Cursor デスクトップのログインセッションは使わない。
- SDK はベータ — resume / create 失敗やサンドボックス不可への防御的扱いを維持する。
- Windows の**安全 worktree**は意図しないワークスペース編集を抑えるが、**OS のセキュリティ境界ではない**。ワークスペース直接実行モードには明示確認が必要。

関連: [README](./README.md)、[Changelog](./CHANGELOG.md)。
