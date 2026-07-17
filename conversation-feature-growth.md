# 会話ログ: Cursor Agent VS Code Extension 機能成長

日付: 2026-07-17
リポジトリ: `cursor-agent-vscode-extension`

---

## 1. 最初の質問

**ユーザー:** ここからさらに機能を成長させようと思えばどういう機能があるか

**回答の要点:**
現状の土台（並列チャット / Supervisor+worktree / 変更セッション+検証 / Safe apply）を前提に、ゼロからより「既存を深くする」方向を提案。

### 提案カテゴリ

#### A. 既存の強みを深掘り
| 軸 | 成長案 |
|---|---|
| Supervisor | タスク優先度・依存関係、並列 Supervisor、診断以外のトリガー（失敗テスト / CI / PR コメント）、適用前の要約レビューゲート |
| 並列エージェント | オーケストレータがサブタスク分割→結果統合、ファイル所有者ロック、完了後の自動マージキュー |
| Worktree | orphan 回収を土台に、長時間バックグラウンド実行・リモート/SSH ワークスペース対応 |
| 検証・修復 | 複数ゲート（lint→test→e2e）、失敗ログの次プロンプト自動注入、修復バジェットの可視化 |
| 変更セッション | セッション間 diff、チーム向け監査ログ、Keep/Restore の一括ポリシー |

#### B. 「仕事の入口〜出口」を一本化
- Issue / TODO → Autopilot → 検証 → branch/PR のワンショット
- Plan プロファイル成果物を実行計画にし、ステップごとに checkpoint
- `/compare` の勝者をそのまま apply / PR 化

#### C. Cursor らしさを VS Code 側で埋める
- `.cursor/rules` / Skills / MCP の UI 管理
- inline completions を実験から実用へ
- SDK が許せば Cloud / Background agent

#### D. 運用・信頼
- 日次/月次の quota・コスト上限と警告
- AI 変更の監査タイムライン
- 未信頼ワークスペースでは Supervisor Autonomous を強制オフ

#### おすすめ優先順位（当時）
1. Supervisor のトリガー多様化 + 適用前レビュー
2. Issue→検証→PR の一本化
3. 並列のオーケストレーション

---

## 2. 「すべて実行しよう」

**ユーザー:** すべて実行しよう

大規模のため Plan モードへ移行。調査のうえ 5 フェーズの実装計画を作成・承認。

### 実装計画（承認済み）

| Phase | 内容 |
|---|---|
| 1 | Supervisor 深化（TODO/テスト失敗トリガー、レビューゲート、優先度） |
| 2 | Issue/TODO → Autopilot → 検証 → PR パイプライン |
| 3 | `/orchestrate` 並列オーケストレータ |
| 4 | 日次トークン予算、監査ログ、Workspace Trust |
| 5 | Rules/Skills/MCP 管理ビュー、インライン補完強化 |

**計画上の対象外:**
- Cloud / Background agent（公開 SDK に API なし）
- リモート / SSH worktree（全面改修が必要）

---

## 3. 実装（「よろしく」〜「つづけて」）

実装を進め、中断後に再開して `npm run validate` まで通した。

### 入った機能（CHANGELOG Unreleased 相当）

- Supervisor: `TODO(ai)` / 失敗テストトリガー、タスク優先度、任意の適用前 AI レビューゲート
- **Cursor: Run Task Pipeline**（GitHub Issue / TODO(ai) / 自由入力 → Autopilot → 検証 → 任意で自動 PR）
- `/orchestrate`（計画 → 並列サブタスク → 統合）
- 日次トークン予算の警告・確認、AI 監査ログのエクスポート、Workspace Trust 制限
- Rules / Skills / MCP / Commands 管理ビュー
- インライン補完の LRU・デバウンス・予算ゲート

### 主な新規ファイル例
- `src/todoScanner.ts`
- `src/orchestrator.ts`
- `src/auditLog.ts`
- `src/integrationCatalog.ts` / `integrationCatalogView.ts` / `integrationToggles.ts`
- `test/growthFeatures.test.mjs`

### 主な設定（安全側デフォルト寄り）
- `supervisorTodoTrigger`
- `supervisorTestFailureTrigger`
- `supervisorReviewGate`
- `pipelineAutoKeep`
- `dailyTokenBudget`

---

## 4. 「提案の中で入ってない機能ある？」

**回答:** ある。今回はおすすめ優先度と計画 5 フェーズ中心。

### 未実装（または部分的）
- Supervisor の**依存関係・並列実行**（優先度のみ）
- **CI / PR コメント**起点のトリガー
- **ファイル所有者ロック / 完了後の自動マージキュー**
- **長時間バックグラウンド / リモート・SSH worktree**（計画でも対象外）
- 検証の**多段ゲート可視化**（lint→test→e2e）。失敗ログ再投入は既存 auto-repair 相当のみ
- **変更セッション間 diff / Keep・Restore 一括ポリシー**（監査ログはある）
- **Plan 成果物をステップ実行 + チェックポイント化**
- **`/compare` 勝者の直接 apply / PR 化**（ピン留め止まり）
- **月次クォータ / コスト上限**（日次トークン予算のみ）
- **Cloud / Background agent**（対象外）

### 効果が大きく既存土台に乗りやすい続き候補
1. `/compare` 勝者 → PR
2. Supervisor 依存関係 / 並列

---

## 5. 本ファイル

**ユーザー:** ここまでの会話を md で出力してほしい

→ このドキュメント。

---

## 6. 部分実装だった領域の完成

**ユーザー:** 部分的な部分をすべて実装してほしいな。

前回の棚卸しで「部分的」と判定した領域を追加実装した。

- 通常の並列チャットAgentに、明示対象ファイルの所有権とワークスペース単位の実行ロック、FIFO適用キューを追加
- VS Code終了後も分離プロセスで継続し、再起動後に状態と隔離変更を復元できるバックグラウンドAgentを追加
- 修復バジェットを変更セッションへ永続化し、実行中・成功・上限到達・直近失敗を専用行で可視化
- 各変更セッションの完了内容を保存し、前回セッションとの実ファイル内容diffを開けるように拡張
- 対話的なAI監査タイムラインと、任意のチーム共有JSONL監査ログを追加
- インライン補完を、設定可能なデバウンス・上限、LRU、実行中リクエスト重複排除、Rules参照、日次/月次/コスト予算ガード、採用率表示まで拡張

公開SDK自体にCloud Agent APIがないため、バックグラウンド実行はローカルの分離ワーカーで実現している。リモート/SSH worktree対応は「部分実装」ではなく従来から対象外のため、この追加実装には含めていない。
