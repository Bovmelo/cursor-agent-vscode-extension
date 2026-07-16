# Cursor Subscription for VS Code

Cursor公式TypeScript SDKを使い、VS CodeのサイドバーからCursor Agentを実行する拡張機能です。

## 必要なもの

- VS Code 1.100以降
- Node.js 22.13以降
- CursorアカウントのユーザーAPIキー

ユーザーAPIキーによるSDK実行は、そのユーザーのCursorプランと同じ利用枠・課金ルールに従います。Cursorアプリのログインセッションを読み取ることはありません。

## 開発実行

```powershell
npm install
npm run compile
```

VS Codeでこのフォルダーを開き、`F5`を押します。Extension Development HostのActivity Barにある「Cursor」を開いてください。

初回利用時は「APIキーを設定」を選択し、[Cursor Dashboard](https://cursor.com/dashboard) の **API Keys** で発行したユーザーAPIキーを入力します。キーはVS CodeのSecretStorageに保存され、ワークスペースや設定ファイルには書き込まれません。

## VSIXの作成

```powershell
npm run package
```

生成された`.vsix`は、VS Codeのコマンド「Extensions: Install from VSIX...」からインストールできます。

## 現在の機能

- ワークスペースを対象にしたローカルCursor Agent
- 会話コンテキストを維持する連続チャット
- 応答のストリーミング表示（Markdownレンダリング対応）
- モデル選択（検索付きポップオーバー、モデルごとのThinking・Context・Effortなどの対応オプション、既定はAuto）
- `+` メニューからの実行プロファイル切り替え（Plan、Multitask）
- Cursor SDKのサブエージェントを使ったMultitask（調査、実装、レビュー）
- 画像コンテキストの直接入力（PNG、JPEG、GIF、WebP）
- プロジェクトSkillsの選択と`.cursor/skills`への導線
- `.cursor/mcp.json`で設定したMCPサーバーの読み込みと一覧表示
- 実行権限の切り替え（自動レビュー、フルアクセス。対応環境では自動レビューにサンドボックスを併用）
- `@` 入力によるワークスペース内ファイルの検索・参照
- ドラッグ＆ドロップとクリップボード貼り付けによるファイル参照（ワークスペース外も対応）
- チャット内に表示された実在ファイル名の自動リンク
- VS Codeの表示言語に連動した英語・日本語UI
- アクティブファイル・選択範囲のコンテキスト添付
- エージェントが編集したファイルのチップ表示（クリックでGit差分を表示）
- 会話履歴の保存・復元（VS Code再起動後も継続、エージェントの会話状態も復元）
- 新規チャット開始（会話のリセット）
- 実行のキャンセル
- 実行中メッセージの会話別キュー（`Enter` / `Alt+Enter`）
- 現在の実行を停止し、追加指示を最優先で続ける割り込み（`Ctrl+Enter`）
- SecretStorageによるAPIキー管理
- Source Controlからのコミットメッセージ生成（差分をCursorに渡し、Gitの入力欄へ反映）
- チャットのメッセージ／コードブロックのワンクリックコピー

この拡張機能はCursor公式製品ではなく、Cursor SDKの公開ベータAPIに依存します。

> **割り込みについて:** 現在のCursor SDKには実行中プロンプトを直接ステアする公開APIがないため、この拡張機能では現在のRunをキャンセルし、同じ会話の優先フォローアップとして送信します。
