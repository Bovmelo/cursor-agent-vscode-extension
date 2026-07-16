import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import * as path from "node:path";
import {
  Agent,
  Cursor,
  CursorAgentError,
  type AgentDefinition,
  type LocalAgentOptions,
  type ModelParameterValue,
  type ModelSelection,
  type RunResult,
  type SDKImage,
  type TokenUsage,
} from "@cursor/sdk";
import * as vscode from "vscode";
import { generateCommitMessage, resolveRootUri } from "./generateCommitMessage.js";
import {
  detectBlockedProxyEnvironment,
  type BlockedProxyEnvironment,
} from "./networkEnvironment.js";
import { RunningSoundController } from "./runningSound.js";

const API_KEY_SECRET = "cursorSubscription.apiKey";
const CONVERSATIONS_KEY = "cursorSubscription.conversations";
const MODEL_KEY = "cursorSubscription.model";
const MODEL_PARAMS_KEY = "cursorSubscription.modelParams";
const APPROVAL_MODE_KEY = "cursorSubscription.approvalMode";
const VIEW_ID = "cursorSubscription.chatView";
const DEFAULT_MODEL = "auto";
const TITLE_MAX_LENGTH = 40;
const IS_JAPANESE = vscode.env.language.toLowerCase().startsWith("ja");
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_DROPPED_FILE_BYTES = 20 * 1024 * 1024;
const MAX_EDITOR_GENERATION_CONTEXT = 60_000;
const SUPPORTS_LOCAL_SANDBOX = process.platform !== "win32";
const IMAGE_FORMATS: Record<string, { mimeType: string; vision: boolean }> = {
  ".avif": { mimeType: "image/avif", vision: false },
  ".bmp": { mimeType: "image/bmp", vision: false },
  ".gif": { mimeType: "image/gif", vision: true },
  ".heic": { mimeType: "image/heic", vision: false },
  ".heif": { mimeType: "image/heif", vision: false },
  ".ico": { mimeType: "image/x-icon", vision: false },
  ".jfif": { mimeType: "image/jpeg", vision: true },
  ".jpeg": { mimeType: "image/jpeg", vision: true },
  ".jpg": { mimeType: "image/jpeg", vision: true },
  ".png": { mimeType: "image/png", vision: true },
  ".svg": { mimeType: "image/svg+xml", vision: false },
  ".tif": { mimeType: "image/tiff", vision: false },
  ".tiff": { mimeType: "image/tiff", vision: false },
  ".webp": { mimeType: "image/webp", vision: true },
};
const IMAGE_FILE_EXTENSIONS = Object.keys(IMAGE_FORMATS).map((extension) =>
  extension.slice(1)
);

type ApprovalMode = "auto-review" | "full-access";
type RunProfile = "agent" | "plan" | "multitask";

function localize(english: string, japanese: string): string {
  return IS_JAPANESE ? japanese : english;
}

type CursorAgent = Awaited<ReturnType<typeof Agent.create>>;
type CursorRun = Awaited<ReturnType<CursorAgent["send"]>>;

interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  error?: boolean;
  files?: string[];
  attachments?: Array<string | TranscriptAttachment>;
  progress?: ToolProgressEntry[];
  progressState?: "completed" | "stopped" | "error";
}

interface TranscriptAttachment {
  path: string;
  label: string;
}

interface ToolProgressEntry {
  id: string;
  text: string;
  status: "running" | "completed" | "error" | "stopped";
}

interface WorkspaceFileItem {
  path: string;
  label: string;
  description: string;
}

interface DroppedFileUpload {
  name: string;
  data: Uint8Array;
}

interface AttachedFileReference {
  displayPath: string;
  agentPath: string;
  external: boolean;
}

interface EditorContextSnapshot {
  filePath: string;
  languageId: string;
  startLine?: number;
  endLine?: number;
  selectedText?: string;
}

interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  agentId?: string;
  attachmentRoot?: string;
  tokenUsage?: TokenUsage;
  transcript: TranscriptEntry[];
}

interface QueuedMessage {
  id: string;
  conversationId: string;
  prompt: string;
  attachContext: boolean;
  files: string[];
  profile: RunProfile;
  skills: string[];
  model: ModelSelection;
  kind: "queued" | "interrupt";
  editorContext?: EditorContextSnapshot;
}

function addTokenUsage(current: TokenUsage | undefined, usage: TokenUsage): TokenUsage {
  const reasoningTokens = (current?.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
  return {
    inputTokens: (current?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + usage.outputTokens,
    cacheReadTokens: (current?.cacheReadTokens ?? 0) + usage.cacheReadTokens,
    cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + usage.cacheWriteTokens,
    totalTokens: (current?.totalTokens ?? 0) + usage.totalTokens,
    reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
  };
}

function makeTitle(prompt: string): string {
  const firstLine = prompt.split("\n", 1)[0].trim();
  return firstLine.length > TITLE_MAX_LENGTH
    ? `${firstLine.slice(0, TITLE_MAX_LENGTH)}…`
    : firstLine;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Cursor Agent");
  const runningSound = new RunningSoundController(context, output);
  const provider = new CursorChatProvider(context, output, runningSound);

  context.subscriptions.push(
    output,
    runningSound,
    provider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("cursorSubscription.openChat", async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand("cursorSubscription.setApiKey", () =>
      provider.promptForApiKey(),
    ),
    vscode.commands.registerCommand("cursorSubscription.clearApiKey", () =>
      provider.clearApiKey(),
    ),
    vscode.commands.registerCommand("cursorSubscription.newChat", () => provider.newChat()),
    vscode.commands.registerTextEditorCommand(
      "cursorSubscription.generateCode",
      (editor) => provider.generateCode(editor),
    ),
    vscode.commands.registerTextEditorCommand(
      "cursorSubscription.explainSelection",
      (editor) => provider.explainSelection(editor),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.addFileToChat",
      (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const selected = Array.isArray(uris) && uris.length > 0
          ? uris
          : uri
            ? [uri]
            : vscode.window.activeTextEditor
              ? [vscode.window.activeTextEditor.document.uri]
              : [];
        return provider.addFilesToChat(selected);
      },
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.generateCommitMessage",
      (arg?: unknown) =>
        generateCommitMessage(
          context,
          resolveRootUri(arg),
          () => provider.promptForApiKey(),
          output,
          () => runningSound.start(),
          () => runningSound.playCompletion(),
        ),
    ),
  );
}

export function deactivate(): void {
  // CursorChatProvider is disposed through ExtensionContext subscriptions.
}

class CursorChatProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private agent: CursorAgent | undefined;
  private run: CursorRun | undefined;
  private agentRootsKey: string | undefined;
  private agentConversationId: string | undefined;
  private busy = false;
  private conversations: Conversation[];
  private activeId: string | undefined;
  private workspaceFileCache: PromiseLike<WorkspaceFileItem[]> | undefined;
  private sandboxFallbackApproved = false;
  private readonly messageQueue: QueuedMessage[] = [];
  private drainingQueue = false;
  private runningConversationId: string | undefined;
  private pendingCancelConversationId: string | undefined;
  private webviewReady = false;
  private readonly pendingChatFiles: string[] = [];
  private pendingAttachmentRoot: Promise<vscode.Uri> | undefined;
  private readonly pendingAttachmentLabels = new Map<string, string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly runningSound: RunningSoundController,
  ) {
    this.conversations = context.workspaceState.get<Conversation[]>(CONVERSATIONS_KEY, []);
  }

  public async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    this.webviewReady = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    view.webview.html = this.getHtml(view.webview);
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.webviewReady = false;
      }
    });

    view.webview.onDidReceiveMessage(
      async (message: {
        type?: string;
        prompt?: string;
        attachContext?: boolean;
        files?: string[];
        references?: string[];
        query?: string;
        requestId?: number;
        modelId?: string;
        modelParams?: { id?: unknown; value?: unknown }[];
        profile?: string;
        skills?: string[];
        approvalMode?: string;
        path?: string;
        id?: string;
        uploads?: { name?: unknown; data?: unknown }[];
      }) => {
        switch (message.type) {
          case "ready":
            this.webviewReady = true;
            this.post({ type: "modelSelected", id: this.selectedModel() });
            this.post({ type: "approvalModeSelected", mode: this.selectedApprovalMode() });
            this.postRunningSoundSetting();
            this.post({ type: "workspace", name: vscode.workspace.workspaceFolders?.[0]?.name });
            this.postView();
            await this.publishWorkspaceFileIndex();
            await this.publishIntegrationIndex();
            await this.publishAuthState();
            await this.flushPendingChatFiles();
            break;
          case "send":
            if (typeof message.prompt === "string") {
              if (typeof message.modelId === "string") {
                await this.storeModelSelection(message.modelId, message.modelParams);
              }
              await this.send(
                message.prompt.trim(),
                message.attachContext === true,
                Array.isArray(message.files)
                  ? message.files.filter((file): file is string => typeof file === "string")
                  : [],
                this.isRunProfile(message.profile) ? message.profile : "agent",
                Array.isArray(message.skills)
                  ? message.skills.filter((skill): skill is string => typeof skill === "string")
                  : [],
              );
              await this.drainMessageQueue();
            }
            break;
          case "queueMessage":
          case "interruptMessage":
            if (typeof message.prompt === "string") {
              if (typeof message.modelId === "string") {
                await this.storeModelSelection(message.modelId, message.modelParams);
              }
              await this.enqueueMessage(
                message.prompt.trim(),
                message.attachContext === true,
                Array.isArray(message.files)
                  ? message.files.filter((file): file is string => typeof file === "string")
                  : [],
                this.isRunProfile(message.profile) ? message.profile : "agent",
                Array.isArray(message.skills)
                  ? message.skills.filter((skill): skill is string => typeof skill === "string")
                  : [],
                message.type === "interruptMessage",
              );
            }
            break;
          case "removeQueuedMessage":
            if (typeof message.id === "string") {
              this.removeQueuedMessage(message.id);
            }
            break;
          case "pickImages":
            await this.pickImages(
              typeof message.requestId === "number" ? message.requestId : 0,
            );
            break;
          case "openSkillsFolder":
            await this.openSkillsFolder();
            break;
          case "openMcpSettings":
            await this.openMcpSettings();
            break;
          case "searchFiles":
            await this.searchWorkspaceFiles(
              typeof message.query === "string" ? message.query : "",
              typeof message.requestId === "number" ? message.requestId : 0,
            );
            break;
          case "resolveAttachments":
            await this.resolveAttachmentReferences(
              Array.isArray(message.references)
                ? message.references.filter(
                    (reference): reference is string => typeof reference === "string",
                  )
                : [],
              typeof message.requestId === "number" ? message.requestId : 0,
              this.parseDroppedFileUploads(message.uploads),
            );
            break;
          case "cancel":
            await this.cancel();
            break;
          case "newChat":
            await this.newChat();
            break;
          case "showHome":
            this.activeId = undefined;
            this.postView();
            break;
          case "openConversation":
            if (typeof message.id === "string") {
              await this.openConversation(message.id);
            }
            break;
          case "deleteConversation":
            if (typeof message.id === "string") {
              await this.deleteConversation(message.id);
            }
            break;
          case "getContext":
            this.postContextInfo();
            break;
          case "selectModel":
            if (typeof message.modelId === "string") {
              await this.storeModelSelection(message.modelId, message.modelParams);
            }
            break;
          case "openDiff":
            if (typeof message.path === "string") {
              await this.openDiff(message.path);
            }
            break;
          case "selectApprovalMode":
            if (this.isApprovalMode(message.approvalMode)) {
              if (
                message.approvalMode === "full-access"
                && this.selectedApprovalMode() !== "full-access"
              ) {
                const enableLabel = localize("Enable full access", "フルアクセスを有効化");
                const answer = await vscode.window.showWarningMessage(
                  localize(
                    "Full access runs tools without auto-review or sandbox restrictions. Enable it?",
                    "フルアクセスでは、自動レビューやサンドボックスの制限なしでツールを実行します。有効にしますか？",
                  ),
                  { modal: true },
                  enableLabel,
                );
                if (answer !== enableLabel) {
                  this.post({
                    type: "approvalModeSelected",
                    mode: this.selectedApprovalMode(),
                  });
                  break;
                }
              }
              await this.context.globalState.update(APPROVAL_MODE_KEY, message.approvalMode);
              await this.cancel();
              await this.disposeAgent();
              this.post({ type: "approvalModeSelected", mode: message.approvalMode });
            }
            break;
          case "openFile":
            if (typeof message.path === "string") {
              await this.openFile(message.path);
            }
            break;
          case "openReferencedFile":
            if (typeof message.path === "string") {
              await this.openReferencedFile(message.path);
            }
            break;
          case "setApiKey":
            await this.promptForApiKey();
            break;
          case "clearApiKey":
            await this.clearApiKey();
            break;
          case "openDashboard":
            await vscode.env.openExternal(vscode.Uri.parse("https://cursor.com/dashboard"));
            break;
        }
      },
      undefined,
      this.disposables,
    );

    const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*");
    const invalidateWorkspaceFiles = (): void => {
      this.workspaceFileCache = undefined;
      void this.publishWorkspaceFileIndex();
      void this.publishIntegrationIndex();
    };
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.postContextInfo()),
      vscode.window.onDidChangeTextEditorSelection(() => this.postContextInfo()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("cursorSubscription.playSoundWhileRunning")
          || event.affectsConfiguration("cursorSubscription.playSoundOnComplete")
          || event.affectsConfiguration("cursorSubscription.playSoundOnError")
        ) {
          this.postRunningSoundSetting();
        }
      }),
      fileWatcher,
      fileWatcher.onDidCreate(invalidateWorkspaceFiles),
      fileWatcher.onDidDelete(invalidateWorkspaceFiles),
    );
  }

  public async promptForApiKey(): Promise<void> {
    const apiKey = await vscode.window.showInputBox({
      title: "Cursor API Key",
      prompt: localize(
        "Enter the user API key generated from API Keys in Cursor Dashboard",
        "Cursor Dashboard の API Keys で発行したユーザーAPIキーを入力してください",
      ),
      password: true,
      ignoreFocusOut: true,
      placeHolder: "crsr_…",
      validateInput: (value) =>
        value.trim().length < 20
          ? localize("Enter a valid Cursor API key", "有効なCursor APIキーを入力してください")
          : undefined,
    });

    if (apiKey === undefined) {
      return;
    }

    await this.cancel();
    await this.disposeAgent();
    await this.context.secrets.store(API_KEY_SECRET, apiKey.trim());
    await this.publishAuthState();
    void vscode.window.showInformationMessage(localize(
      "The Cursor API key was stored securely.",
      "Cursor APIキーを安全に保存しました。",
    ));
  }

  public async clearApiKey(): Promise<void> {
    const existing = await this.context.secrets.get(API_KEY_SECRET);
    if (!existing) {
      return;
    }

    const deleteLabel = localize("Delete", "削除");
    const answer = await vscode.window.showWarningMessage(
      localize("Delete the stored Cursor API key?", "保存済みのCursor APIキーを削除しますか？"),
      { modal: true },
      deleteLabel,
    );
    if (answer !== deleteLabel) {
      return;
    }

    await this.cancel();
    await this.disposeAgent();
    await this.context.secrets.delete(API_KEY_SECRET);
    await this.publishAuthState();
  }

  public async generateCode(editor: vscode.TextEditor): Promise<void> {
    if (editor.document.uri.scheme !== "file") {
      void vscode.window.showInformationMessage(localize(
        "Save the file before generating code.",
        "コードを生成する前にファイルを保存してください。",
      ));
      return;
    }

    const selection = new vscode.Range(editor.selection.start, editor.selection.end);
    const selectedText = editor.document.getText(selection);
    if (selectedText.length > MAX_EDITOR_GENERATION_CONTEXT) {
      void vscode.window.showWarningMessage(localize(
        "The selected code is too large to generate safely. Select a smaller range.",
        "選択範囲が大きすぎるため、安全にコードを生成できません。範囲を小さくしてください。",
      ));
      return;
    }

    const instruction = await vscode.window.showInputBox({
      title: localize("Cursor: Generate Code", "Cursor: コードを生成"),
      prompt: selection.isEmpty
        ? localize(
            "Describe the code to insert at the cursor.",
            "カーソル位置に挿入するコードを指示してください。",
          )
        : localize(
            "Describe how the selected code should be changed.",
            "選択したコードをどのように変更するか指示してください。",
          ),
      ignoreFocusOut: true,
    });
    if (!instruction?.trim()) {
      return;
    }

    let apiKey = await this.context.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      await this.promptForApiKey();
      apiKey = await this.context.secrets.get(API_KEY_SECRET);
      if (!apiKey) {
        return;
      }
    }

    const blockedProxy = detectBlockedProxyEnvironment();
    if (blockedProxy) {
      void vscode.window.showErrorMessage(this.formatBlockedProxyError(blockedProxy));
      return;
    }

    const document = editor.document;
    const documentVersion = document.version;
    const relativePath = vscode.workspace.asRelativePath(document.uri);
    const cursorOffset = document.offsetAt(selection.start);
    const selectionEndOffset = document.offsetAt(selection.end);
    const surroundingBudget = Math.max(
      0,
      MAX_EDITOR_GENERATION_CONTEXT - selectedText.length,
    );
    const contextPerSide = Math.floor(surroundingBudget / 2);
    const beforeStartOffset = Math.max(
      0,
      cursorOffset - contextPerSide,
    );
    const afterEndOffset = Math.min(
      document.getText().length,
      selectionEndOffset + contextPerSide,
    );
    const beforeText = document.getText(
      new vscode.Range(document.positionAt(beforeStartOffset), selection.start),
    );
    const afterText = document.getText(
      new vscode.Range(selection.end, document.positionAt(afterEndOffset)),
    );
    const task = selection.isEmpty
      ? [
          "Generate code to insert at the cursor according to the user's instruction.",
          "Use the surrounding code for context.",
        ]
      : [
          "Generate replacement code for the selected range according to the user's instruction.",
          "Preserve behavior outside the selected range.",
        ];
    const prompt = [
      ...task,
      "Return ONLY the code to insert. Do not use Markdown fences and do not add explanations.",
      "",
      `File: ${relativePath}`,
      `Language: ${document.languageId}`,
      `Instruction: ${instruction.trim()}`,
      "",
      "Code before the target:",
      "<before>",
      beforeText,
      "</before>",
      selection.isEmpty ? undefined : "Selected code:",
      selection.isEmpty ? undefined : "<selection>",
      selection.isEmpty ? undefined : selectedText,
      selection.isEmpty ? undefined : "</selection>",
      "Code after the target:",
      "<after>",
      afterText,
      "</after>",
    ].filter((line): line is string => line !== undefined).join("\n");

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: localize("Generating code…", "コードを生成中…"),
          cancellable: false,
        },
        async () => {
          const result = await Agent.prompt(prompt, {
            apiKey,
            model: this.selectedModelSelection(),
            name: "VS Code: Generate Code",
            mode: "plan",
            local: {
              cwd:
                vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ??
                path.dirname(document.uri.fsPath),
              settingSources: [],
            },
          });

          if (result.status === "error") {
            throw new Error(this.formatRunFailure(result));
          }
          if (result.status === "cancelled") {
            return;
          }

          const generatedCode = this.cleanGeneratedCode(result.result ?? "");
          if (!generatedCode) {
            throw new Error(localize(
              "The model returned empty code.",
              "モデルから空のコードが返されました。",
            ));
          }

          const currentDocument =
            vscode.workspace.textDocuments.find(
              (candidate) => candidate.uri.toString() === document.uri.toString(),
            ) ?? await vscode.workspace.openTextDocument(document.uri);
          if (currentDocument.version !== documentVersion) {
            throw new Error(localize(
              "The file changed while code was being generated. Run the command again.",
              "コードの生成中にファイルが変更されました。もう一度実行してください。",
            ));
          }

          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, selection, generatedCode);
          const applied = await vscode.workspace.applyEdit(edit);
          if (!applied) {
            throw new Error(localize(
              "Could not apply the generated code.",
              "生成したコードを適用できませんでした。",
            ));
          }

          const end = this.positionAfterText(selection.start, generatedCode);
          const updatedEditor = await vscode.window.showTextDocument(document.uri, {
            preview: false,
            viewColumn: editor.viewColumn,
          });
          updatedEditor.selection = new vscode.Selection(end, end);
          updatedEditor.revealRange(new vscode.Range(selection.start, end));
        },
      );
    } catch (error) {
      const message =
        error instanceof CursorAgentError
          ? localize(
              `Could not start code generation: ${error.message}`,
              `コード生成を開始できませんでした: ${error.message}`,
            )
          : error instanceof Error
            ? error.message
            : String(error);
      this.output.appendLine(
        `[${new Date().toISOString()}] Code generation error: ${message}`,
      );
      void vscode.window.showErrorMessage(message);
    }
  }

  public async explainSelection(editor: vscode.TextEditor): Promise<void> {
    if (editor.selection.isEmpty) {
      void vscode.window.showInformationMessage(localize(
        "Select the code you want Cursor to explain.",
        "Cursorに説明してほしいコードを選択してください。",
      ));
      return;
    }

    const editorContext = this.captureEditorContext(editor);
    if (!editorContext?.selectedText) {
      return;
    }
    if (editorContext.selectedText.length > MAX_EDITOR_GENERATION_CONTEXT) {
      void vscode.window.showWarningMessage(localize(
        "The selected code is too large to explain safely. Select a smaller range.",
        "選択範囲が大きすぎるため、安全に説明できません。範囲を小さくしてください。",
      ));
      return;
    }

    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await this.enqueueMessage(
      localize(
        "Explain what the selected code does, how it works, and any important caveats.",
        "選択したコードが何をしているのか、どのように動作するのか、注意点も含めて説明してください。",
      ),
      true,
      [],
      "agent",
      [],
      false,
      editorContext,
    );
  }

  public async newChat(): Promise<void> {
    await this.cancel();
    this.activeId = undefined;
    this.post({ type: "newChat" });
  }

  public async addFilesToChat(uris: vscode.Uri[]): Promise<void> {
    const references: string[] = [];
    for (const uri of uris) {
      if (uri.scheme !== "file") {
        continue;
      }
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.File) !== 0) {
          references.push(uri.fsPath);
        }
      } catch {
        // Skip missing or inaccessible paths.
      }
    }

    if (references.length === 0) {
      void vscode.window.showWarningMessage(localize(
        "No files could be added to chat.",
        "チャットに追加できるファイルがありませんでした。",
      ));
      return;
    }

    this.pendingChatFiles.push(...references);
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await this.flushPendingChatFiles();
  }

  private async flushPendingChatFiles(): Promise<void> {
    if (!this.webviewReady || this.pendingChatFiles.length === 0) {
      return;
    }
    const references = this.pendingChatFiles.splice(0);
    await this.resolveAttachmentReferences(references, Date.now());
  }

  private async openConversation(id: string): Promise<void> {
    const conversation = this.conversations.find((c) => c.id === id);
    if (!conversation) {
      return;
    }
    await this.cancel();
    this.activeId = id;
    this.postView();
  }

  private async deleteConversation(id: string): Promise<void> {
    const deletedConversation = this.conversations.find((c) => c.id === id);
    this.conversations = this.conversations.filter((c) => c.id !== id);
    if (this.activeId === id) {
      this.activeId = undefined;
      await this.disposeAgent();
    }
    if (deletedConversation?.attachmentRoot) {
      const storageRoot = path.resolve(this.context.globalStorageUri.fsPath);
      const attachmentRoot = path.resolve(deletedConversation.attachmentRoot);
      const relative = path.relative(storageRoot, attachmentRoot);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(attachmentRoot), { recursive: true });
        } catch {
          // The managed attachment copy may already have been removed.
        }
      }
    }
    await this.saveConversations();
    if (!this.activeId) {
      this.postView();
    }
  }

  public async dispose(): Promise<void> {
    await this.cancel();
    await this.disposeAgent();
    if (this.pendingAttachmentRoot) {
      try {
        const root = await this.pendingAttachmentRoot;
        await vscode.workspace.fs.delete(root, { recursive: true });
      } catch {
        // Pending dropped files may already have been removed.
      }
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private selectedModel(): string {
    return this.context.globalState.get<string>(MODEL_KEY, DEFAULT_MODEL);
  }

  private cleanGeneratedCode(raw: string): string {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/^```(?:[^\r\n]*)\r?\n([\s\S]*?)\r?\n```$/);
    if (fenced) {
      return fenced[1];
    }
    return raw
      .replace(/^(?:\r?\n)+/, "")
      .replace(/(?:\r?\n)+$/, "");
  }

  private positionAfterText(start: vscode.Position, text: string): vscode.Position {
    const lines = text.split(/\r?\n/);
    return lines.length === 1
      ? start.translate(0, lines[0].length)
      : new vscode.Position(start.line + lines.length - 1, lines.at(-1)?.length ?? 0);
  }

  private captureEditorContext(editor: vscode.TextEditor): EditorContextSnapshot | undefined {
    if (editor.document.uri.scheme !== "file") {
      return undefined;
    }
    const selection = editor.selection;
    return {
      filePath: vscode.workspace.asRelativePath(editor.document.uri),
      languageId: editor.document.languageId,
      startLine: selection.isEmpty ? undefined : selection.start.line + 1,
      endLine: selection.isEmpty ? undefined : selection.end.line + 1,
      selectedText: selection.isEmpty
        ? undefined
        : editor.document.getText(selection),
    };
  }

  private storedModelParams(): Record<string, ModelParameterValue[]> {
    return this.context.globalState.get<Record<string, ModelParameterValue[]>>(
      MODEL_PARAMS_KEY,
      {},
    );
  }

  private async storeModelSelection(
    modelId: string,
    rawParams: { id?: unknown; value?: unknown }[] | undefined,
  ): Promise<void> {
    const params = Array.isArray(rawParams)
      ? rawParams
          .filter(
            (param): param is { id: string; value: string } =>
              typeof param.id === "string" && typeof param.value === "string",
          )
          .map(({ id, value }) => ({ id, value }))
      : [];
    const allParams = this.storedModelParams();
    allParams[modelId] = params;
    await Promise.all([
      this.context.globalState.update(MODEL_KEY, modelId),
      this.context.globalState.update(MODEL_PARAMS_KEY, allParams),
    ]);
  }

  private selectedModelSelection(): ModelSelection {
    const id = this.selectedModel();
    const params = this.storedModelParams()[id];
    return { id, params: params?.length ? params : undefined };
  }

  private isApprovalMode(value: unknown): value is ApprovalMode {
    return value === "auto-review" || value === "full-access";
  }

  private selectedApprovalMode(): ApprovalMode {
    const stored = this.context.globalState.get<string>(APPROVAL_MODE_KEY, "auto-review");
    return this.isApprovalMode(stored) ? stored : "auto-review";
  }

  private isRunProfile(value: unknown): value is RunProfile {
    return value === "agent"
      || value === "plan"
      || value === "multitask";
  }

  private activeConversation(): Conversation | undefined {
    return this.conversations.find((c) => c.id === this.activeId);
  }

  private conversationSummaries(): { id: string; title: string; updatedAt: number }[] {
    return [...this.conversations]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  }

  private async saveConversations(): Promise<void> {
    await this.context.workspaceState.update(CONVERSATIONS_KEY, this.conversations);
  }

  private postView(): void {
    const active = this.activeConversation();
    if (active) {
      this.post({ type: "chat", entries: active.transcript });
    } else {
      this.post({ type: "home", conversations: this.conversationSummaries() });
    }
    this.postQueueState();
  }

  private ensureConversation(prompt: string): Conversation {
    const existing = this.activeConversation();
    if (existing) {
      return existing;
    }
    const conversation: Conversation = {
      id: randomUUID(),
      title: makeTitle(prompt),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      transcript: [],
    };
    this.conversations.unshift(conversation);
    this.activeId = conversation.id;
    return conversation;
  }

  private postIfActive(conversationId: string, message: Record<string, unknown>): void {
    if (this.activeId === conversationId) {
      this.post(message);
    }
  }

  private postQueueState(): void {
    const conversationId = this.activeId;
    const items = conversationId
      ? this.messageQueue
          .filter((item) => item.conversationId === conversationId)
          .map(({ id, prompt, kind }) => ({ id, prompt, kind }))
      : [];
    this.post({ type: "queueState", items });
  }

  private postRunningSoundSetting(): void {
    const enabled = vscode.workspace
      .getConfiguration("cursorSubscription")
      .get<boolean>("playSoundWhileRunning", true)
      && process.platform !== "win32";
    const completionEnabled = vscode.workspace
      .getConfiguration("cursorSubscription")
      .get<boolean>("playSoundOnComplete", true)
      && process.platform !== "win32";
    const errorEnabled = vscode.workspace
      .getConfiguration("cursorSubscription")
      .get<boolean>("playSoundOnError", true)
      && process.platform !== "win32";
    this.post({ type: "runningSoundSetting", enabled });
    this.post({ type: "completionSoundSetting", enabled: completionEnabled });
    this.post({ type: "errorSoundSetting", enabled: errorEnabled });
  }

  private async enqueueMessage(
    prompt: string,
    attachContext: boolean,
    files: string[],
    profile: RunProfile,
    skills: string[],
    interrupt: boolean,
    editorContext?: EditorContextSnapshot,
  ): Promise<void> {
    if (!prompt) {
      return;
    }

    const conversationId = this.runningConversationId ?? this.activeId;
    if (!conversationId) {
      await this.send(
        prompt,
        attachContext,
        files,
        profile,
        skills,
        undefined,
        undefined,
        editorContext,
      );
      await this.drainMessageQueue();
      return;
    }

    const item: QueuedMessage = {
      id: randomUUID(),
      conversationId,
      prompt,
      attachContext,
      files,
      profile,
      skills,
      model: this.selectedModelSelection(),
      kind: interrupt ? "interrupt" : "queued",
      editorContext,
    };
    if (interrupt) {
      this.messageQueue.unshift(item);
    } else {
      this.messageQueue.push(item);
    }
    this.postQueueState();

    if (interrupt) {
      if (this.busy) {
        await this.cancel(false);
      }
    }
    if (!this.busy) {
      await this.drainMessageQueue();
    }
  }

  private removeQueuedMessage(id: string): void {
    const index = this.messageQueue.findIndex((item) => item.id === id);
    if (index < 0) {
      return;
    }
    this.messageQueue.splice(index, 1);
    this.postQueueState();
  }

  private async drainMessageQueue(): Promise<void> {
    if (this.drainingQueue || this.busy) {
      return;
    }
    this.drainingQueue = true;
    try {
      while (!this.busy && this.messageQueue.length > 0) {
        const item = this.messageQueue.shift();
        if (!item) {
          break;
        }
        const conversation = this.conversations.find(
          (candidate) => candidate.id === item.conversationId,
        );
        this.postQueueState();
        if (!conversation) {
          continue;
        }
        this.postIfActive(item.conversationId, {
          type: "queuedStarted",
          prompt: item.prompt,
          files: item.files,
          kind: item.kind,
        });
        await this.send(
          item.prompt,
          item.attachContext,
          item.files,
          item.profile,
          item.skills,
          item.conversationId,
          item.model,
          item.editorContext,
        );
      }
    } finally {
      this.drainingQueue = false;
    }
  }

  private async send(
    prompt: string,
    attachContext: boolean,
    requestedFiles: string[],
    profile: RunProfile,
    requestedSkills: string[],
    targetConversationId?: string,
    modelSelection?: ModelSelection,
    editorContext?: EditorContextSnapshot,
  ): Promise<void> {
    if (!prompt || this.busy) {
      return;
    }

    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this.post({
        type: "error",
        text: localize(
          "Open a folder before running Cursor Agent.",
          "Cursor Agentを実行するには、先にフォルダーを開いてください。",
        ),
      });
      return;
    }

    const apiKey = await this.context.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      this.post({ type: "authRequired" });
      await this.promptForApiKey();
      return;
    }

    const conversation = targetConversationId
      ? this.conversations.find((candidate) => candidate.id === targetConversationId)
      : this.ensureConversation(prompt);
    if (!conversation) {
      return;
    }
    const attachedFiles = await this.resolveAttachedFiles(requestedFiles, workspace);
    const attachmentReferences = await this.stageExternalAttachments(
      attachedFiles,
      workspace,
      conversation,
    );
    const { composed, contextLabel } = this.composePrompt(
      prompt,
      attachContext,
      attachmentReferences,
      profile,
      requestedSkills,
      editorContext,
    );
    const images = await this.loadAttachedImages(attachedFiles, workspace);
    const conversationId = conversation.id;

    this.busy = true;
    this.runningConversationId = conversationId;
    const runningSound = this.runningSound.start();
    this.post({ type: "started" });
    if (contextLabel) {
      this.postIfActive(conversationId, { type: "contextAttached", label: contextLabel });
    }

    const userEntry: TranscriptEntry = {
      role: "user",
      text: contextLabel
        ? `${prompt}\n\n[${localize("Attached", "添付")}: ${contextLabel}]`
        : prompt,
      attachments: attachmentReferences.length > 0
        ? attachmentReferences.map((reference) => ({
            path: reference.agentPath,
            label: path.basename(reference.displayPath) || path.basename(reference.agentPath),
          }))
        : undefined,
    };
    let assistantText = "";
    const editedFiles = new Set<string>();
    const progressSteps = new Map<string, ToolProgressEntry>();
    let failed = false;
    let progressState: "completed" | "stopped" | "error" = "completed";

    try {
      const blockedProxy = detectBlockedProxyEnvironment();
      if (blockedProxy) {
        const text = this.formatBlockedProxyError(blockedProxy);
        this.output.appendLine(
          `[${new Date().toISOString()}] Run blocked before SDK connection: ${blockedProxy.variable}=${blockedProxy.address}`,
        );
        throw new Error(text);
      }

      const cwd = workspace.uri.fsPath;
      const agentRoots = [cwd, conversation.attachmentRoot].filter(
        (root): root is string => typeof root === "string",
      );
      const rootsKey = agentRoots.map((root) => path.resolve(root).toLowerCase()).join("\n");
      if (
        !this.agent ||
        this.agentRootsKey !== rootsKey ||
        this.agentConversationId !== conversationId
      ) {
        await this.disposeAgent();
        this.agent = await this.createOrResumeAgent(
          apiKey,
          agentRoots,
          workspace.name,
          conversation,
        );
        this.agentRootsKey = rootsKey;
        this.agentConversationId = conversationId;
      }

      const run = await this.agent.send(
        images.length > 0 ? { text: composed, images } : composed,
        {
          model: modelSelection ?? this.selectedModelSelection(),
          mode: profile === "plan" ? "plan" : "agent",
        },
      );
      this.run = run;
      if (
        this.pendingCancelConversationId === conversationId
        && run.supports("cancel")
      ) {
        this.pendingCancelConversationId = undefined;
        await run.cancel();
      }

      for await (const event of run.stream()) {
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              assistantText += block.text;
              this.postIfActive(conversationId, { type: "chunk", text: block.text });
            }
          }
        } else if (event.type === "tool_call") {
          this.handleToolEvent(event, cwd, editedFiles, progressSteps, conversationId);
        }
      }

      const result = await run.wait();
      if (result.usage) {
        conversation.tokenUsage = addTokenUsage(conversation.tokenUsage, result.usage);
      }
      if (result.status === "error") {
        failed = true;
        progressState = "error";
        const errorText = this.formatRunFailure(result);
        this.output.appendLine(
          `[${new Date().toISOString()}] Run ${result.id} failed: ${result.error?.code ?? "unknown"} ${result.error?.message ?? ""}`.trim(),
        );
        this.postIfActive(conversationId, {
          type: "error",
          text: errorText,
        });
        assistantText = assistantText
          ? `${assistantText}\n\n${errorText}`
          : errorText;
      } else if (result.status === "cancelled") {
        progressState = "stopped";
        this.postIfActive(conversationId, { type: "cancelled" });
        if (!assistantText) {
          assistantText = localize("(Stopped)", "（停止しました）");
        }
      } else {
        this.postIfActive(conversationId, { type: "finished" });
      }
    } catch (error) {
      failed = true;
      progressState = "error";
      this.output.appendLine(
        `[${new Date().toISOString()}] Cursor Agent error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      const text =
        error instanceof CursorAgentError
          ? localize(
              `Could not start the connection to Cursor: ${error.message}`,
              `Cursorへの接続を開始できませんでした: ${error.message}`,
            )
          : error instanceof Error
            ? error.message
            : String(error);
      this.postIfActive(conversationId, { type: "error", text });
      if (!assistantText) {
        assistantText = text;
      }
    } finally {
      runningSound.dispose();
      if (progressState === "completed") {
        this.runningSound.playCompletion();
      } else if (progressState === "error") {
        this.runningSound.playError();
      }
      this.run = undefined;
      this.busy = false;
      this.runningConversationId = undefined;
      this.pendingCancelConversationId = undefined;
      this.post({ type: "idle" });

      const storedProgress = [...progressSteps.values()].map((step): ToolProgressEntry =>
        step.status === "running"
          ? {
              ...step,
              status: progressState === "completed" ? "completed" : progressState,
            }
          : step,
      );

      conversation.transcript.push(userEntry, {
        role: "assistant",
        text: assistantText,
        error: failed || undefined,
        files: editedFiles.size > 0 ? [...editedFiles] : undefined,
        progress: storedProgress.length > 0 ? storedProgress : undefined,
        progressState: storedProgress.length > 0 ? progressState : undefined,
      });
      conversation.updatedAt = Date.now();
      await this.saveConversations();
      if (!this.activeId) {
        this.postView();
      }
      this.notifyRunComplete(conversation, progressState);
    }
  }

  private notifyRunComplete(
    conversation: Conversation,
    progressState: "completed" | "stopped" | "error",
  ): void {
    if (progressState === "stopped") {
      return;
    }

    const enabled = vscode.workspace
      .getConfiguration("cursorSubscription")
      .get<boolean>("notifyOnComplete", true);
    if (!enabled) {
      return;
    }

    // Avoid noise when the user is already watching the chat.
    if (this.view?.visible && vscode.window.state.focused) {
      return;
    }

    const openLabel = localize("Open Chat", "チャットを開く");
    const title = conversation.title || localize("Chat", "チャット");
    const message =
      progressState === "error"
        ? localize(
            `Cursor Agent failed: ${title}`,
            `Cursor Agentが失敗しました: ${title}`,
          )
        : localize(
            `Cursor Agent finished: ${title}`,
            `Cursor Agentが完了しました: ${title}`,
          );

    const show =
      progressState === "error"
        ? vscode.window.showErrorMessage(message, openLabel)
        : vscode.window.showInformationMessage(message, openLabel);

    void show.then(async (answer) => {
      if (answer !== openLabel) {
        return;
      }
      await this.openConversation(conversation.id);
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    });
  }

  private currentContextLabel(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      return undefined;
    }
    const relative = vscode.workspace.asRelativePath(editor.document.uri);
    if (editor.selection.isEmpty) {
      return relative;
    }
    return `${relative} L${editor.selection.start.line + 1}-L${editor.selection.end.line + 1}`;
  }

  private formatRunFailure(result: RunResult): string {
    const rawDetail = result.error?.message?.trim();
    const detail = rawDetail?.replace(/^\[[^\]]+\]\s*/, "");
    const searchable = `${result.error?.code ?? ""} ${detail ?? ""}`.toLowerCase();
    let summary: string;

    const blockedProxy = detectBlockedProxyEnvironment();
    if (blockedProxy) {
      return [
        this.formatBlockedProxyError(blockedProxy),
        `Run: ${result.id}`,
      ].join("\n");
    }

    if (
      /exchange.*fetch failed|failed to connect.*exchange|network|unavailable|connection (?:failed|stalled)(?: repeatedly)?/.test(
        searchable,
      )
    ) {
      summary = localize(
        "Could not connect to Cursor's authentication server. Check the network, VPN, or proxy, then try again.",
        "Cursorの認証サーバーに接続できませんでした。ネットワーク、VPN、プロキシを確認して再試行してください。",
      );
    } else if (/invalid api key|unauthenticated|unauthorized|401/.test(searchable)) {
      summary = localize(
        "The Cursor API key was rejected. Set a valid user API key and try again.",
        "Cursor APIキーが拒否されました。有効なユーザーAPIキーを設定して再試行してください。",
      );
    } else if (/rate.?limit|too many requests|429|usage limit/.test(searchable)) {
      summary = localize(
        "Cursor's usage or rate limit was reached. Wait and try again, or check the Cursor dashboard.",
        "Cursorの利用上限またはレート制限に達しました。時間をおいて再試行するか、Cursor Dashboardを確認してください。",
      );
    } else if (/model|unsupported.*parameter|invalid.*parameter/.test(searchable)) {
      summary = localize(
        "The selected model or one of its options could not be used. Change the model settings and try again.",
        "選択したモデルまたはオプションを利用できませんでした。モデル設定を変更して再試行してください。",
      );
    } else if (/agent.*busy|active run|conflict/.test(searchable)) {
      summary = localize(
        "The agent already has an active run. Stop it or wait for it to finish, then try again.",
        "エージェントで別の処理が実行中です。停止するか完了を待ってから再試行してください。",
      );
    } else {
      summary = localize(
        "Cursor Agent could not complete the run.",
        "Cursor Agentが処理を完了できませんでした。",
      );
    }

    return [
      summary,
      detail ? `${localize("Details", "詳細")}: ${detail}` : undefined,
      result.error?.code
        ? `${localize("Error code", "エラーコード")}: ${result.error.code}`
        : undefined,
      `Run: ${result.id}`,
    ].filter((line): line is string => Boolean(line)).join("\n");
  }

  private formatBlockedProxyError(proxy: BlockedProxyEnvironment): string {
    return localize(
      [
        "Cursor Agent network access is blocked by the current VS Code process.",
        `Details: ${proxy.variable} points to the blocked loopback address ${proxy.address}.`,
        "Fully quit VS Code and reopen it normally, outside the restricted or sandboxed launcher.",
      ].join("\n"),
      [
        "現在のVS CodeプロセスではCursor Agentのネットワーク接続が遮断されています。",
        `詳細: ${proxy.variable} が遮断用ループバックアドレス ${proxy.address} を参照しています。`,
        "VS Codeをすべて終了し、制限環境やサンドボックス経由ではなく通常の方法で起動し直してください。",
      ].join("\n"),
    );
  }

  private postContextInfo(): void {
    this.post({ type: "contextInfo", label: this.currentContextLabel() ?? null });
  }

  private composePrompt(
    prompt: string,
    attachContext: boolean,
    attachedFiles: AttachedFileReference[],
    profile: RunProfile,
    requestedSkills: string[],
    editorContext?: EditorContextSnapshot,
  ): { composed: string; contextLabel?: string } {
    const profileInstruction: Partial<Record<RunProfile, string>> = {
      plan: "Create a concrete implementation plan. Do not edit files or run mutating commands.",
      multitask: "Split independent work into parallel workstreams and delegate them to the available specialist subagents when useful. Integrate and verify their results.",
    };
    const skills = [...new Set(requestedSkills)]
      .filter((skill) => skill.length > 0 && skill.length <= 80)
      .slice(0, 10);
    const intentReference = [
      profileInstruction[profile],
      skills.length > 0
        ? "Use these Cursor skills for this request when applicable: " + skills.join(", ") + "."
        : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n");
    const effectivePrompt = intentReference ? intentReference + "\n\n" + prompt : prompt;
    const fileReference = attachedFiles.length > 0
      ? [
          "The user explicitly attached these files. Read them as needed before responding:",
          ...attachedFiles.map((file) => file.external
            ? `- ${file.displayPath} (read-only staged copy: ${file.agentPath})`
            : `- ${file.agentPath}`),
          "Do not edit read-only staged copies. They represent files outside the main workspace.",
          "",
        ].join("\n")
      : "";
    if (!attachContext) {
      return {
        composed: fileReference ? `${fileReference}${effectivePrompt}` : effectivePrompt,
      };
    }

    if (editorContext) {
      if (editorContext.selectedText === undefined) {
        return {
          composed: `${fileReference}${localize("Target file", "対象ファイル")}: ${editorContext.filePath}\n\n${effectivePrompt}`,
          contextLabel: editorContext.filePath,
        };
      }

      const startLine = editorContext.startLine ?? 1;
      const endLine = editorContext.endLine ?? startLine;
      return {
        composed: [
          fileReference.trimEnd(),
          `${localize("Target file", "対象ファイル")}: ${editorContext.filePath} (L${startLine}-L${endLine})`,
          `${localize("Selection", "選択範囲")}:`,
          `\`\`\`${editorContext.languageId}`,
          editorContext.selectedText,
          "```",
          "",
          effectivePrompt,
        ].filter(Boolean).join("\n"),
        contextLabel: `${editorContext.filePath} L${startLine}-L${endLine}`,
      };
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      return {
        composed: fileReference ? `${fileReference}${effectivePrompt}` : effectivePrompt,
      };
    }

    const relative = vscode.workspace.asRelativePath(editor.document.uri);
    const selection = editor.selection;
    if (selection.isEmpty) {
      return {
        composed: `${fileReference}${localize("Target file", "対象ファイル")}: ${relative}\n\n${effectivePrompt}`,
        contextLabel: relative,
      };
    }

    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    const selectedText = editor.document.getText(selection);
    return {
      composed: [
        fileReference.trimEnd(),
        `${localize("Target file", "対象ファイル")}: ${relative} (L${startLine}-L${endLine})`,
        `${localize("Selection", "選択範囲")}:`,
        "```",
        selectedText,
        "```",
        "",
        effectivePrompt,
      ].filter(Boolean).join("\n"),
      contextLabel: `${relative} L${startLine}-L${endLine}`,
    };
  }

  private async searchWorkspaceFiles(query: string, requestId: number): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this.post({ type: "fileResults", requestId, files: [] });
      return;
    }

    const normalizedQuery = query.trim().toLowerCase().replaceAll("\\", "/");
    const workspaceFiles = await this.getWorkspaceFiles(workspace);
    const files = workspaceFiles
      .filter((file) => !normalizedQuery || file.path.toLowerCase().includes(normalizedQuery))
      .sort((a, b) =>
        this.fileMatchScore(a, normalizedQuery) - this.fileMatchScore(b, normalizedQuery)
        || a.path.localeCompare(b.path),
      )
      .slice(0, 12);

    this.post({ type: "fileResults", requestId, files });
  }

  private getWorkspaceFiles(workspace: vscode.WorkspaceFolder): PromiseLike<WorkspaceFileItem[]> {
    if (!this.workspaceFileCache) {
      this.workspaceFileCache = vscode.workspace.findFiles(
        new vscode.RelativePattern(workspace, "**/*"),
        "**/{.git,node_modules,out,dist,build,coverage}/**",
        5000,
      ).then((uris) => uris.map((uri): WorkspaceFileItem => {
        const relative = path.relative(workspace.uri.fsPath, uri.fsPath).replaceAll("\\", "/");
        const directory = path.posix.dirname(relative);
        return {
          path: relative,
          label: path.posix.basename(relative),
          description: directory === "." ? "" : directory,
        };
      }));
    }
    return this.workspaceFileCache!;
  }

  private async publishWorkspaceFileIndex(): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this.post({ type: "workspaceFileIndex", files: [] });
      return;
    }
    const files = await this.getWorkspaceFiles(workspace);
    this.post({ type: "workspaceFileIndex", files: files.map((file) => file.path) });
  }

  private fileMatchScore(file: WorkspaceFileItem, query: string): number {
    if (!query) {
      return file.path.split("/").length;
    }
    const label = file.label.toLowerCase();
    const fullPath = file.path.toLowerCase();
    if (label === query) return 0;
    if (label.startsWith(query)) return 1;
    if (label.includes(query)) return 2;
    if (fullPath.startsWith(query)) return 3;
    return 4 + fullPath.indexOf(query) / Math.max(fullPath.length, 1);
  }

  private async resolveAttachedFiles(
    requestedFiles: string[],
    workspace: vscode.WorkspaceFolder,
  ): Promise<string[]> {
    const root = path.resolve(workspace.uri.fsPath);
    const unique = [...new Set(requestedFiles)].slice(0, 20);
    const resolved: string[] = [];

    for (const requested of unique) {
      const absolute = path.isAbsolute(requested)
        ? path.resolve(requested)
        : path.resolve(root, requested);
      const relative = path.relative(root, absolute);
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(absolute));
        if ((stat.type & vscode.FileType.File) !== 0) {
          const isInWorkspace = relative
            && !relative.startsWith("..")
            && !path.isAbsolute(relative);
          resolved.push(
            (isInWorkspace ? relative : absolute).replaceAll("\\", "/"),
          );
        }
      } catch {
        // Ignore stale or invalid file selections.
      }
    }
    return resolved;
  }

  private async loadAttachedImages(
    files: string[],
    workspace: vscode.WorkspaceFolder,
  ): Promise<SDKImage[]> {
    const root = path.resolve(workspace.uri.fsPath);
    const images: SDKImage[] = [];
    let skippedLargeImages = 0;
    for (const file of files) {
      const format = IMAGE_FORMATS[path.extname(file).toLowerCase()];
      if (!format?.vision || images.length >= 8) {
        continue;
      }
      const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
      try {
        const uri = vscode.Uri.file(absolute);
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_IMAGE_BYTES) {
          skippedLargeImages += 1;
          continue;
        }
        const data = await vscode.workspace.fs.readFile(uri);
        images.push({
          data: Buffer.from(data).toString("base64"),
          mimeType: format.mimeType,
        });
      } catch {
        // Invalid or stale attachments are already omitted from the file list.
      }
    }
    if (skippedLargeImages > 0) {
      void vscode.window.showWarningMessage(localize(
        String(skippedLargeImages) + " image(s) exceeded the 20 MB image limit and were attached as files only.",
        String(skippedLargeImages) + "件の画像が20 MBの上限を超えたため、ファイル参照としてのみ添付しました。",
      ));
    }
    return images;
  }

  private async pickImages(requestId: number): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      title: localize("Attach images", "画像を添付"),
      filters: {
        [localize("Images", "画像")]: IMAGE_FILE_EXTENSIONS,
      },
    });
    if (!uris?.length) {
      return;
    }
    await this.resolveAttachmentReferences(uris.map((uri) => uri.fsPath), requestId);
  }

  private parseDroppedFileUploads(
    uploads: { name?: unknown; data?: unknown }[] | undefined,
  ): DroppedFileUpload[] {
    if (!Array.isArray(uploads)) {
      return [];
    }

    const parsed: DroppedFileUpload[] = [];
    for (const upload of uploads.slice(0, 20)) {
      if (typeof upload?.name !== "string") {
        continue;
      }
      let data: Uint8Array | undefined;
      if (upload.data instanceof Uint8Array) {
        data = upload.data;
      } else if (upload.data instanceof ArrayBuffer) {
        data = new Uint8Array(upload.data);
      } else if (
        Array.isArray(upload.data)
        && upload.data.every(
          (value) => Number.isInteger(value) && value >= 0 && value <= 255,
        )
      ) {
        data = Uint8Array.from(upload.data);
      }
      if (data) {
        parsed.push({ name: upload.name, data });
      }
    }
    return parsed;
  }

  private ensurePendingAttachmentRoot(): Promise<vscode.Uri> {
    if (!this.pendingAttachmentRoot) {
      this.pendingAttachmentRoot = (async () => {
        const root = vscode.Uri.joinPath(
          this.context.globalStorageUri,
          "pending-attachments",
        );
        try {
          await vscode.workspace.fs.delete(root, { recursive: true });
        } catch {
          // There may be no stale pending attachment directory yet.
        }
        await vscode.workspace.fs.createDirectory(root);
        return root;
      })();
    }
    return this.pendingAttachmentRoot;
  }

  private async stageDroppedFileUpload(
    upload: DroppedFileUpload,
  ): Promise<WorkspaceFileItem | undefined> {
    if (upload.data.byteLength > MAX_DROPPED_FILE_BYTES) {
      return undefined;
    }

    const originalName = path.basename(upload.name.trim());
    const safeName = originalName
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      || "attachment";
    const hash = createHash("sha256")
      .update(upload.data)
      .digest("hex")
      .slice(0, 12);
    const root = await this.ensurePendingAttachmentRoot();
    const uri = vscode.Uri.joinPath(root, `${hash}-${safeName}`);
    await vscode.workspace.fs.writeFile(uri, upload.data);
    const normalized = uri.fsPath.replaceAll("\\", "/");
    this.pendingAttachmentLabels.set(path.resolve(uri.fsPath).toLowerCase(), safeName);
    return {
      path: normalized,
      label: safeName,
      description: path.posix.dirname(normalized),
    };
  }

  private async stageExternalAttachments(
    files: string[],
    workspace: vscode.WorkspaceFolder,
    conversation: Conversation,
  ): Promise<AttachedFileReference[]> {
    const root = path.resolve(workspace.uri.fsPath);
    const references: AttachedFileReference[] = [];
    let attachmentRootUri: vscode.Uri | undefined;

    for (const file of files) {
      if (!path.isAbsolute(file)) {
        references.push({ displayPath: file, agentPath: file, external: false });
        continue;
      }

      const absolute = path.resolve(file);
      const relative = path.relative(root, absolute);
      const isInWorkspace = relative
        && !relative.startsWith("..")
        && !path.isAbsolute(relative);
      if (isInWorkspace) {
        const normalized = relative.replaceAll("\\", "/");
        references.push({ displayPath: normalized, agentPath: normalized, external: false });
        continue;
      }

      attachmentRootUri ??= vscode.Uri.joinPath(
        this.context.globalStorageUri,
        "attachments",
        conversation.id,
      );
      await vscode.workspace.fs.createDirectory(attachmentRootUri);
      const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 12);
      const stagedUri = vscode.Uri.joinPath(
        attachmentRootUri,
        `${hash}-${path.basename(absolute)}`,
      );
      await vscode.workspace.fs.copy(vscode.Uri.file(absolute), stagedUri, { overwrite: true });
      const pendingLabel = this.pendingAttachmentLabels.get(absolute.toLowerCase());
      references.push({
        displayPath: pendingLabel ?? absolute.replaceAll("\\", "/"),
        agentPath: stagedUri.fsPath.replaceAll("\\", "/"),
        external: true,
      });
    }

    if (attachmentRootUri) {
      conversation.attachmentRoot = attachmentRootUri.fsPath;
      await this.saveConversations();
    }
    return references;
  }

  private async resolveAttachmentReferences(
    references: string[],
    requestId: number,
    uploads: DroppedFileUpload[] = [],
  ): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this.post({ type: "resolvedAttachments", requestId, files: [] });
      void vscode.window.showWarningMessage(localize(
        "Open a workspace folder to attach dropped files.",
        "ドロップしたファイルを添付するには、ワークスペースフォルダーを開いてください。",
      ));
      return;
    }

    const root = path.resolve(workspace.uri.fsPath);
    const workspaceFiles = await this.getWorkspaceFiles(workspace);
    const resolved = new Map<string, WorkspaceFileItem>();
    let rejected = 0;

    for (const upload of uploads) {
      try {
        const item = await this.stageDroppedFileUpload(upload);
        if (item) {
          resolved.set(item.path, item);
        } else {
          rejected += 1;
        }
      } catch {
        rejected += 1;
      }
    }

    for (const rawReference of [...new Set(references)].slice(0, 20)) {
      const reference = rawReference.trim();
      if (!reference) {
        continue;
      }

      let candidatePath: string;
      try {
        candidatePath = reference.toLowerCase().startsWith("file:")
          ? vscode.Uri.parse(reference).fsPath
          : reference;
      } catch {
        rejected += 1;
        continue;
      }

      const isAbsolute = path.isAbsolute(candidatePath);
      const hasDirectory = candidatePath.includes("/") || candidatePath.includes("\\");
      const absolute = isAbsolute ? path.resolve(candidatePath) : path.resolve(root, candidatePath);
      const relative = path.relative(root, absolute);
      let item: WorkspaceFileItem | undefined;

      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(absolute));
        if ((stat.type & vscode.FileType.File) !== 0) {
          const isInWorkspace = relative
            && !relative.startsWith("..")
            && !path.isAbsolute(relative);
          const normalized = (isInWorkspace ? relative : absolute).replaceAll("\\", "/");
          const directory = path.posix.dirname(normalized);
          item = {
            path: normalized,
            label: path.posix.basename(normalized),
            description: directory === "." ? "" : directory,
          };
        }
      } catch {
        // A name-only clipboard entry can still be resolved from the workspace index.
      }

      if (!item && !isAbsolute && !hasDirectory) {
        const matches = workspaceFiles.filter(
          (file) => file.label.toLowerCase() === candidatePath.toLowerCase(),
        );
        if (matches.length === 1) {
          item = matches[0];
        } else if (matches.length > 1) {
          item = await vscode.window.showQuickPick(matches, {
            placeHolder: localize(
              `Select the file meant by ${candidatePath}`,
              `${candidatePath} に対応するファイルを選択してください`,
            ),
          });
        }
      }

      if (item) {
        resolved.set(item.path, item);
      } else {
        rejected += 1;
      }
    }

    this.post({
      type: "resolvedAttachments",
      requestId,
      files: [...resolved.values()],
    });
    if (rejected > 0) {
      void vscode.window.showWarningMessage(localize(
        `${rejected} file(s) could not be attached because they were unavailable or no longer exist.`,
        `${rejected}件のファイルを添付できませんでした。ファイルが利用できないか、既に存在しない可能性があります。`,
      ));
    }
  }

  private async createOrResumeAgent(
    apiKey: string,
    roots: string[],
    workspaceName: string,
    conversation: Conversation,
  ): Promise<CursorAgent> {
    const cwd = roots.length === 1 ? roots[0] : roots;
    const approvalMode = this.selectedApprovalMode();
    const local: LocalAgentOptions = {
      cwd,
      autoReview: approvalMode === "auto-review",
      sandboxOptions: {
        enabled: SUPPORTS_LOCAL_SANDBOX && approvalMode !== "full-access",
      },
      settingSources: ["all"],
    };
    if (approvalMode === "auto-review" && !SUPPORTS_LOCAL_SANDBOX) {
      this.post({ type: "sandboxUnavailable" });
    }
    const agents = this.builtInSubagents();
    const connect = async (localOptions: LocalAgentOptions): Promise<CursorAgent> => {
      if (conversation.agentId) {
        try {
          return await Agent.resume(conversation.agentId, {
            apiKey,
            local: localOptions,
            agents,
          });
        } catch (error) {
          if (this.isSandboxUnavailableError(error)) {
            throw error;
          }
          // 保存済みエージェントが復元できない場合は新規作成にフォールバック。
          conversation.agentId = undefined;
        }
      }

      const agent = await Agent.create({
        apiKey,
        model: this.selectedModelSelection(),
        local: localOptions,
        agents,
        name: `VS Code: ${workspaceName}`,
      });
      conversation.agentId = agent.agentId;
      await this.saveConversations();
      return agent;
    };

    try {
      return await connect(local);
    } catch (error) {
      if (!local.sandboxOptions?.enabled || !this.isSandboxUnavailableError(error)) {
        throw error;
      }

      if (!this.sandboxFallbackApproved) {
        const continueLabel = localize("Run without sandbox", "サンドボックスなしで実行");
        const detail = localize(
          "This environment does not support Cursor's local sandbox. Continuing disables filesystem and network isolation, but Auto-review remains enabled.",
          "この環境はCursorのローカルサンドボックスに対応していません。続行するとファイルとネットワークの隔離はなくなりますが、自動レビューは維持されます。",
        );
        const answer = await vscode.window.showWarningMessage(
          detail,
          { modal: true },
          continueLabel,
        );
        if (answer !== continueLabel) {
          throw new Error(localize(
            "Run cancelled because local sandboxing is unavailable.",
            "ローカルサンドボックスを利用できないため、実行をキャンセルしました。",
          ));
        }
        this.sandboxFallbackApproved = true;
      }

      this.post({ type: "sandboxUnavailable" });
      return connect({
        ...local,
        sandboxOptions: { enabled: false },
      });
    }
  }

  private isSandboxUnavailableError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("sandboxing is not supported in this environment")
      || message.includes("Local SDK sandboxing was requested");
  }

  private builtInSubagents(): Record<string, AgentDefinition> {
    return {
      researcher: {
        description: "Read-only specialist for gathering codebase evidence and comparing approaches.",
        prompt: "Investigate the assigned question. Read relevant files, gather concise evidence, and report findings. Do not edit files.",
        model: "inherit",
      },
      implementer: {
        description: "Implementation specialist for a clearly scoped independent code change.",
        prompt: "Implement only the assigned scope, preserve unrelated work, and run focused validation. Report changed files and results.",
        model: "inherit",
      },
      reviewer: {
        description: "Review specialist for correctness, regressions, security, and missing validation.",
        prompt: "Review the assigned work with evidence. Do not edit files unless explicitly instructed. Report actionable issues by priority.",
        model: "inherit",
      },
    };
  }

  private handleToolEvent(
    event: unknown,
    cwd: string,
    editedFiles: Set<string>,
    progressSteps: Map<string, ToolProgressEntry>,
    conversationId: string,
  ): void {
    const tool = event as {
      call_id?: string;
      name?: string;
      status?: "running" | "completed" | "error";
      args?: unknown;
    };
    if (typeof tool.name !== "string") {
      return;
    }

    const id = typeof tool.call_id === "string"
      ? tool.call_id
      : `${tool.name}-${progressSteps.size}`;
    const status = tool.status ?? "running";
    const text = this.describeToolProgress(tool.name, tool.args, cwd);
    const step: ToolProgressEntry = { id, text, status };
    progressSteps.set(id, step);
    this.postIfActive(conversationId, {
      type: "toolStatus",
      callId: id,
      text,
      status,
    });

    if (!/edit|write/i.test(tool.name)) {
      return;
    }

    for (const filePath of extractFilePaths(tool.args)) {
      const absolute = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
      if (!editedFiles.has(absolute)) {
        editedFiles.add(absolute);
        this.postIfActive(conversationId, {
          type: "fileEdited",
          path: absolute,
          label: vscode.workspace.asRelativePath(absolute),
        });
      }
    }
  }

  private describeToolProgress(toolName: string, args: unknown, cwd: string): string {
    const lower = toolName.toLowerCase();
    let action: string;
    if (/edit|write|apply.?patch/.test(lower)) {
      action = localize("Editing file", "ファイルを編集");
    } else if (/read|open.?file/.test(lower)) {
      action = localize("Reading file", "ファイルを読み取り");
    } else if (/grep|search|find|glob/.test(lower)) {
      action = localize("Searching", "検索");
    } else if (/shell|terminal|command|exec|run/.test(lower)) {
      action = localize("Running command", "コマンドを実行");
    } else if (/subagent|agent/.test(lower)) {
      action = localize("Running subagent", "サブエージェントを実行");
    } else if (/web|browser|fetch/.test(lower)) {
      action = localize("Accessing the web", "Webへアクセス");
    } else {
      action = toolName.replaceAll("_", " ");
    }

    const filePath = extractFilePaths(args)[0];
    if (filePath) {
      const absolute = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
      return `${action}: ${vscode.workspace.asRelativePath(absolute)}`;
    }

    if (args && typeof args === "object" && /shell|terminal|command|exec|run/.test(lower)) {
      const record = args as Record<string, unknown>;
      const command = [record.command, record.cmd, record.script]
        .find((value): value is string => typeof value === "string" && value.length > 0);
      if (command) {
        const compact = command.replace(/\s+/g, " ").trim();
        return `${action}: ${compact.length > 90 ? `${compact.slice(0, 87)}…` : compact}`;
      }
    }

    return action;
  }

  private async openDiff(filePath: string): Promise<void> {
    const uri = vscode.Uri.file(filePath);
    try {
      await vscode.commands.executeCommand("git.openChange", uri);
    } catch {
      await vscode.window.showTextDocument(uri, { preview: true });
    }
  }

  private async openFile(filePath: string): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      return;
    }
    const root = path.resolve(workspace.uri.fsPath);
    const absolute = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(root, filePath);
    let uri = vscode.Uri.file(absolute);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      const recovered = await this.recoverStoredAttachment(filePath);
      if (recovered) {
        uri = recovered;
      } else {
        void vscode.window.showWarningMessage(localize(
          `Could not open file: ${filePath}`,
          `ファイルを開けませんでした: ${filePath}`,
        ));
        return;
      }
    }

    try {
      await vscode.commands.executeCommand("vscode.open", uri);
    } catch {
      void vscode.window.showWarningMessage(localize(
        `Could not open file: ${filePath}`,
        `ファイルを開けませんでした: ${filePath}`,
      ));
    }
  }

  private async recoverStoredAttachment(filePath: string): Promise<vscode.Uri | undefined> {
    const missingName = path.basename(filePath);
    if (!missingName) {
      return undefined;
    }

    const active = this.activeId
      ? this.conversations.find((conversation) => conversation.id === this.activeId)
      : undefined;
    const conversations = [
      ...(active ? [active] : []),
      ...this.conversations.filter((conversation) => conversation !== active),
    ];

    for (const conversation of conversations) {
      if (!conversation.attachmentRoot) {
        continue;
      }
      const root = vscode.Uri.file(conversation.attachmentRoot);
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(root);
      } catch {
        continue;
      }
      const lowerName = missingName.toLowerCase();
      const match = entries.find(([name, type]) =>
        (type & vscode.FileType.File) !== 0
        && (
          name.toLowerCase() === lowerName
          || name.toLowerCase().endsWith(`-${lowerName}`)
        )
      );
      if (!match) {
        continue;
      }

      const recovered = vscode.Uri.joinPath(root, match[0]);
      const recoveredPath = recovered.fsPath.replaceAll("\\", "/");
      const label = missingName.replace(/^[0-9a-f]{12}-/i, "");
      let changed = false;
      for (const entry of conversation.transcript) {
        if (!entry.attachments) {
          continue;
        }
        entry.attachments = entry.attachments.map((attachment) => {
          const attachmentPath = typeof attachment === "string"
            ? attachment
            : attachment.path;
          if (path.resolve(attachmentPath).toLowerCase() !== path.resolve(filePath).toLowerCase()) {
            return attachment;
          }
          changed = true;
          return { path: recoveredPath, label };
        });
      }
      if (changed) {
        await this.saveConversations();
      }
      return recovered;
    }
    return undefined;
  }

  private async openReferencedFile(reference: string): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      return;
    }

    const match = /^(.*?)(?::(\d+)(?::\d+)?)?$/.exec(reference.trim());
    const requestedPath = (match?.[1] ?? reference).replaceAll("\\", "/");
    const line = match?.[2] ? Math.max(0, Number(match[2]) - 1) : undefined;
    const root = path.resolve(workspace.uri.fsPath);
    const exact = path.resolve(root, requestedPath);
    const relativeExact = path.relative(root, exact);
    let candidates: vscode.Uri[] = [];

    if (
      relativeExact
      && !relativeExact.startsWith("..")
      && !path.isAbsolute(relativeExact)
      && requestedPath.includes("/")
    ) {
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(exact));
        if ((stat.type & vscode.FileType.File) !== 0) {
          candidates = [vscode.Uri.file(exact)];
        }
      } catch {
        // Fall back to matching by the displayed file name.
      }
    }

    if (candidates.length === 0) {
      const fileName = path.posix.basename(requestedPath).toLowerCase();
      const files = await this.getWorkspaceFiles(workspace);
      candidates = files
        .filter((file) => file.label.toLowerCase() === fileName)
        .map((file) => vscode.Uri.file(path.join(root, file.path)));
    }

    if (candidates.length === 0) {
      void vscode.window.showWarningMessage(localize(
        `No workspace file matches: ${requestedPath}`,
        `一致するワークスペースファイルがありません: ${requestedPath}`,
      ));
      return;
    }

    let selected = candidates[0];
    if (candidates.length > 1) {
      const picked = await vscode.window.showQuickPick(
        candidates.map((uri) => {
          const relative = path.relative(root, uri.fsPath).replaceAll("\\", "/");
          return {
            label: path.posix.basename(relative),
            description: path.posix.dirname(relative),
            uri,
          };
        }),
        {
          placeHolder: localize(
            `Select the file meant by ${requestedPath}`,
            `${requestedPath} に対応するファイルを選択してください`,
          ),
        },
      );
      if (!picked) {
        return;
      }
      selected = picked.uri;
    }

    const document = await vscode.workspace.openTextDocument(selected);
    const selection = line === undefined
      ? undefined
      : new vscode.Range(
          new vscode.Position(Math.min(line, Math.max(0, document.lineCount - 1)), 0),
          new vscode.Position(Math.min(line, Math.max(0, document.lineCount - 1)), 0),
        );
    await vscode.window.showTextDocument(document, { preview: true, selection });
  }

  private async cancel(clearQueue = true): Promise<void> {
    const conversationId = this.runningConversationId;
    if (clearQueue && conversationId) {
      for (let index = this.messageQueue.length - 1; index >= 0; index -= 1) {
        if (this.messageQueue[index].conversationId === conversationId) {
          this.messageQueue.splice(index, 1);
        }
      }
      this.postQueueState();
    }
    const run = this.run;
    if (!run || !run.supports("cancel")) {
      if (conversationId) {
        this.pendingCancelConversationId = conversationId;
      }
      return;
    }
    await run.cancel();
  }

  private async disposeAgent(): Promise<void> {
    const agent = this.agent;
    this.agent = undefined;
    this.agentRootsKey = undefined;
    this.agentConversationId = undefined;
    if (agent) {
      await agent[Symbol.asyncDispose]();
    }
  }

  private async publishIntegrationIndex(): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this.post({ type: "integrations", skills: [], mcpServers: [] });
      return;
    }

    const skills: { name: string; description?: string }[] = [];
    try {
      const skillUris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspace, ".cursor/skills/**/SKILL.md"),
        "**/node_modules/**",
        100,
      );
      for (const uri of skillUris) {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const source = Buffer.from(bytes).toString("utf8", 0, 8192);
        const fallbackName = path.basename(path.dirname(uri.fsPath));
        const name = /^name:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(source)?.[1]?.trim()
          ?? fallbackName;
        const description = /^description:\s*["']?([^"'\r\n]+)["']?\s*$/m
          .exec(source)?.[1]?.trim();
        skills.push({ name, description });
      }
    } catch {
      // An unavailable skills folder is equivalent to an empty list.
    }

    const mcpServers: string[] = [];
    const mcpUri = vscode.Uri.joinPath(workspace.uri, ".cursor", "mcp.json");
    try {
      const bytes = await vscode.workspace.fs.readFile(mcpUri);
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
      if (parsed && typeof parsed === "object" && "mcpServers" in parsed) {
        const servers = (parsed as { mcpServers?: unknown }).mcpServers;
        if (servers && typeof servers === "object" && !Array.isArray(servers)) {
          mcpServers.push(...Object.keys(servers));
        }
      }
    } catch {
      // Invalid JSON is left for the editor to surface when the user opens it.
    }

    this.post({
      type: "integrations",
      skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
      mcpServers: mcpServers.sort((a, b) => a.localeCompare(b)),
    });
  }

  private async openSkillsFolder(): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      return;
    }
    const uri = vscode.Uri.joinPath(workspace.uri, ".cursor", "skills");
    await vscode.workspace.fs.createDirectory(uri);
    await vscode.commands.executeCommand("revealInExplorer", uri);
  }

  private async openMcpSettings(): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      return;
    }
    const directory = vscode.Uri.joinPath(workspace.uri, ".cursor");
    const uri = vscode.Uri.joinPath(directory, "mcp.json");
    await vscode.workspace.fs.createDirectory(directory);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from('{\n  "mcpServers": {}\n}\n', "utf8"),
      );
    }
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async publishAuthState(): Promise<void> {
    const apiKey = await this.context.secrets.get(API_KEY_SECRET);
    this.post({ type: "authState", configured: Boolean(apiKey) });
    if (apiKey) {
      void this.publishModels(apiKey);
    }
  }

  private async publishModels(apiKey: string): Promise<void> {
    let models: {
      id: string;
      label: string;
      description?: string;
      parameters: {
        id: string;
        label: string;
        values: { value: string; label: string }[];
      }[];
      variants: {
        label: string;
        description?: string;
        isDefault: boolean;
        params: ModelParameterValue[];
      }[];
    }[] = [];
    try {
      const blockedProxy = detectBlockedProxyEnvironment();
      if (blockedProxy) {
        this.output.appendLine(
          `[${new Date().toISOString()}] Model refresh skipped: ${blockedProxy.variable}=${blockedProxy.address}`,
        );
        throw new Error(this.formatBlockedProxyError(blockedProxy));
      }
      const list = await Cursor.models.list({ apiKey });
      models = list.map((model) => {
        return {
          id: model.id,
          label: model.displayName ?? model.id,
          description: model.description,
          parameters: (model.parameters ?? []).map((parameter) => ({
            id: parameter.id,
            label: parameter.displayName ?? parameter.id,
            values: parameter.values.map((value) => ({
              value: value.value,
              label: value.displayName ?? value.value,
            })),
          })),
          variants: (model.variants ?? []).map((variant) => ({
            label: variant.displayName,
            description: variant.description,
            isDefault: variant.isDefault === true,
            params: variant.params,
          })),
        };
      });
    } catch {
      models = [{
        id: "composer-2.5",
        label: "composer-2.5",
        parameters: [],
        variants: [],
      }];
    }

    const seenIds = new Set<string>();
    models = models.filter((model) => {
      if (seenIds.has(model.id)) {
        return false;
      }
      seenIds.add(model.id);
      return true;
    });

    const hasAuto = models.some(
      (model) =>
        model.id.toLowerCase() === DEFAULT_MODEL ||
        model.label.trim().toLowerCase() === DEFAULT_MODEL,
    );
    if (!hasAuto) {
      models.unshift({
        id: DEFAULT_MODEL,
        label: "Auto",
        parameters: [],
        variants: [],
      });
    }
    this.post({
      type: "models",
      models,
      selected: this.selectedModel(),
      savedParams: this.storedModelParams(),
    });
  }

  private post(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");
    const extensionVersion = String(
      (this.context.extension.packageJSON as { version?: string }).version ?? "",
    );
    const markedUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "node_modules",
        "marked",
        "lib",
        "marked.umd.js",
      ),
    );
    const purifyUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "node_modules",
        "dompurify",
        "dist",
        "purify.min.js",
      ),
    );
    const ui = IS_JAPANESE
      ? {
          history: "会話履歴",
          newChat: "新規チャット",
          setApiKey: "APIキーを設定",
          authMessage: "Cursor DashboardでユーザーAPIキーを発行し、VS Codeに設定してください。",
          openDashboard: "Dashboardを開く",
          tasks: "タスク",
          detach: "添付を解除",
          referencedFiles: "参照ファイル",
          workspaceFiles: "ワークスペースのファイル",
          slashCommands: "スラッシュコマンド",
          prompt: "何でも依頼してください",
          promptLabel: "プロンプト",
          attachActive: "アクティブファイル/選択範囲を添付",
          addContextTools: "エージェント、コンテキスト、ツールを追加…",
          standardProfile: "標準",
          planProfile: "Plan",
          multitaskProfile: "Multitask",
          standardProfileDescription: "通常のエージェント実行",
          planProfileDescription: "実装計画を作成（ファイルは編集しない）",
          multitaskProfileDescription: "並列サブエージェントに分割して実行",
          noMatchingCommands: "一致するコマンドがありません",
          image: "画像を添付",
          skills: "Skills",
          mcpServers: "MCPサーバー",
          back: "戻る",
          noSkills: "プロジェクトSkillsはありません",
          noMcpServers: "設定済みMCPサーバーはありません",
          openSkillsFolder: "Skillsフォルダーを開く",
          openMcpSettings: "mcp.jsonを開く",
          apiKeyMissing: "APIキー未設定",
          model: "モデル",
          searchModels: "モデルを検索",
          modelOptions: "オプション",
          noMatchingModels: "一致するモデルがありません",
          variant: "バリアント",
          send: "送信",
          queue: "キュー",
          queueTitle: "実行後に送信（Enter / Alt+Enter）",
          interrupt: "割り込み",
          interruptTitle: "現在の実行を停止して最優先で送信（Ctrl+Enter）",
          queuedMessages: "送信待ち",
          queued: "キュー",
          interruptQueued: "割り込み",
          removeQueued: "キューから削除",
          localRun: "ローカルで実行",
          checkingConnection: "接続を確認中…",
          justNow: "たった今",
          minutesAgo: "分前",
          hoursAgo: "時間前",
          yesterday: "昨日",
          daysAgo: "日前",
          deleteConversation: "この会話を削除",
          showAll: "すべて表示",
          noActiveFile: "アクティブなファイルがありません",
          noMatchingFiles: "一致するファイルがありません",
          removeReference: "参照を解除",
          openFile: "ファイルを開く",
          showDiff: "差分を表示",
          connected: "接続済み",
          runningIn: "でローカル実行",
          stop: "停止",
          running: "実行中",
          attached: "添付",
          stopped: "停止しました。",
          progressRunning: "処理中",
          progressPreparing: "処理を準備しています…",
          progressCompleted: "処理が完了しました",
          progressStopped: "処理を停止しました",
          progressFailed: "処理中にエラーが発生しました",
          progressStep: "ステップ",
          dropFiles: "Shiftを押しながらドロップして添付",
          dropFailed: "ドロップしたファイルを読み取れませんでした。Shiftを押しながらドロップしてください。",
          pasteFailed: "クリップボードの画像を読み取れませんでした。",
          approvalMode: "実行権限",
          autoReview: "自動レビュー",
          autoReviewDescription: SUPPORTS_LOCAL_SANDBOX
            ? "危険な可能性がある操作を自動判定し、サンドボックスを使用します"
            : "危険な可能性がある操作を自動判定します（この環境ではサンドボックス非対応）",
          fullAccess: "フルアクセス",
          fullAccessDescription: "確認とサンドボックスなしで実行します",
          sandboxUnavailable: "サンドボックスなし・自動レビュー有効",
          copyCode: "コードをコピー",
          copyMessage: "メッセージをコピー",
          copied: "コピーしました",
        }
      : {
          history: "Conversation history",
          newChat: "New chat",
          setApiKey: "Set API key",
          authMessage: "Generate a user API key in Cursor Dashboard and set it in VS Code.",
          openDashboard: "Open Dashboard",
          tasks: "Tasks",
          detach: "Remove attachment",
          referencedFiles: "Referenced files",
          workspaceFiles: "Workspace files",
          slashCommands: "Slash commands",
          prompt: "Ask anything",
          promptLabel: "Prompt",
          attachActive: "Attach active file/selection",
          addContextTools: "Add agents, context, tools…",
          standardProfile: "Standard",
          planProfile: "Plan",
          multitaskProfile: "Multitask",
          standardProfileDescription: "Standard agent run",
          planProfileDescription: "Create an implementation plan without edits",
          multitaskProfileDescription: "Split work across parallel subagents",
          noMatchingCommands: "No matching commands",
          image: "Attach image",
          skills: "Skills",
          mcpServers: "MCP Servers",
          back: "Back",
          noSkills: "No project skills found",
          noMcpServers: "No MCP servers configured",
          openSkillsFolder: "Open Skills folder",
          openMcpSettings: "Open mcp.json",
          apiKeyMissing: "API key not set",
          model: "Model",
          searchModels: "Search models",
          modelOptions: "Options",
          noMatchingModels: "No matching models",
          variant: "Variant",
          send: "Send",
          queue: "Queue",
          queueTitle: "Send after the current run (Enter / Alt+Enter)",
          interrupt: "Interrupt",
          interruptTitle: "Stop the current run and send this next (Ctrl+Enter)",
          queuedMessages: "Queued messages",
          queued: "Queued",
          interruptQueued: "Interrupt",
          removeQueued: "Remove from queue",
          localRun: "Run locally",
          checkingConnection: "Checking connection…",
          justNow: "Just now",
          minutesAgo: " min ago",
          hoursAgo: " hr ago",
          yesterday: "Yesterday",
          daysAgo: " days ago",
          deleteConversation: "Delete this conversation",
          showAll: "Show all",
          noActiveFile: "No active file",
          noMatchingFiles: "No matching files",
          removeReference: "Remove reference",
          openFile: "Open file",
          showDiff: "Show diff",
          connected: "Connected",
          runningIn: "running locally",
          stop: "Stop",
          running: "Running",
          attached: "Attached",
          stopped: "Stopped.",
          progressRunning: "Working",
          progressPreparing: "Preparing the run…",
          progressCompleted: "Work completed",
          progressStopped: "Work stopped",
          progressFailed: "Work failed",
          progressStep: "steps",
          dropFiles: "Hold Shift and drop files to attach",
          dropFailed: "Could not read the dropped files. Hold Shift while dropping.",
          pasteFailed: "Could not read the image from the clipboard.",
          approvalMode: "Execution permissions",
          autoReview: "Auto-review",
          autoReviewDescription: SUPPORTS_LOCAL_SANDBOX
            ? "Classify potentially unsafe actions and use the sandbox"
            : "Classify potentially unsafe actions (sandbox unavailable in this environment)",
          fullAccess: "Full access",
          fullAccessDescription: "Run without review or sandbox restrictions",
          sandboxUnavailable: "No sandbox · Auto-review enabled",
          copyCode: "Copy code",
          copyMessage: "Copy message",
          copied: "Copied",
        };

    return /* html */ `<!doctype html>
<html lang="${IS_JAPANESE ? "ja" : "en"}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';"
  >
  <title>Cursor Agent</title>
  <style>
    * { box-sizing: border-box; }
    :root {
      --radius-card: 16px;
      --muted: var(--vscode-descriptionForeground);
    }
    body {
      height: 100vh;
      margin: 0;
      display: flex;
      flex-direction: column;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: var(--vscode-font-size) var(--vscode-font-family);
    }

    /* ---- Header ---- */
    .header {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 10px 14px 8px;
    }
    .brand {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .08em;
      text-transform: uppercase;
      padding-bottom: 3px;
      border-bottom: 2px solid var(--vscode-foreground);
    }
    .header .spacer { flex: 1; }
    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      padding: 0;
      color: var(--vscode-icon-foreground);
      background: transparent;
      border: 0;
      border-radius: 6px;
      cursor: pointer;
    }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .icon-btn svg { width: 15px; height: 15px; }

    /* ---- Messages ---- */
    #scroller {
      flex: 1;
      overflow-y: auto;
      padding: 4px 14px;
      display: flex;
      flex-direction: column;
    }
    #messages {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    #home {
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    #tasks { padding: 2px 0 8px; }
    .tasks-title {
      padding: 4px 8px 6px;
      font-size: 12px;
      font-weight: 600;
    }
    .task-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 8px;
      cursor: pointer;
    }
    .task-row:hover { background: var(--vscode-list-hoverBackground); }
    .task-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .task-time {
      flex: none;
      font-size: 11px;
      color: var(--muted);
    }
    .task-delete {
      display: none;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      padding: 0;
      font-size: 13px;
      line-height: 1;
      color: var(--muted);
      background: transparent;
      border: 0;
      border-radius: 4px;
      cursor: pointer;
    }
    .task-delete:hover { color: var(--vscode-errorForeground); }
    .task-row:hover .task-time { display: none; }
    .task-row:hover .task-delete { display: inline-flex; }
    #viewAll {
      padding: 6px 8px;
      font-size: 12px;
      text-align: left;
      color: var(--muted);
      background: transparent;
      border: 0;
      cursor: pointer;
    }
    #viewAll:hover { color: var(--vscode-foreground); }
    .ghost {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 140px;
    }
    .ghost svg {
      width: 64px;
      height: 64px;
      opacity: .28;
    }
    .message {
      position: relative;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .user {
      align-self: flex-end;
      max-width: 88%;
      padding: 8px 28px 8px 12px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 14px;
      border-bottom-right-radius: 4px;
      white-space: pre-wrap;
    }
    .assistant {
      align-self: stretch;
      padding-right: 28px;
    }
    .assistant.error > .message-body {
      color: var(--vscode-errorForeground);
      white-space: pre-wrap;
    }
    .assistant > .message-body > :first-child { margin-top: 0; }
    .assistant > .message-body > :last-child { margin-bottom: 0; }
    .assistant .code-block {
      position: relative;
      margin: .75em 0;
    }
    .assistant .code-block > pre {
      margin: 0;
      padding: 10px 36px 10px 10px;
      overflow-x: auto;
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
    }
    .assistant code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: .95em;
    }
    .assistant :not(pre) > code {
      padding: 1px 4px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
    }
    .copy-btn {
      position: absolute;
      top: 4px;
      right: 4px;
      z-index: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      color: var(--vscode-icon-foreground);
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      opacity: 0;
      cursor: pointer;
    }
    .code-block > .copy-btn {
      top: 6px;
      right: 6px;
      background: var(--vscode-textCodeBlock-background);
    }
    .message:hover > .copy-btn,
    .message:focus-within > .copy-btn,
    .code-block:hover > .copy-btn,
    .code-block:focus-within > .copy-btn,
    .copy-btn:focus-visible,
    .copy-btn.copied {
      opacity: 1;
    }
    .copy-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .copy-btn:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .copy-btn.copied {
      color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #3fb950));
    }
    .copy-btn svg {
      width: 14px;
      height: 14px;
      pointer-events: none;
    }
    .chat-progress {
      align-self: stretch;
      overflow: hidden;
      color: var(--muted);
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 9px;
      font-size: 11px;
    }
    .chat-progress > summary {
      display: flex;
      align-items: center;
      gap: 7px;
      min-height: 29px;
      padding: 5px 8px;
      color: var(--vscode-foreground);
      cursor: pointer;
      list-style: none;
      user-select: none;
    }
    .chat-progress > summary::-webkit-details-marker { display: none; }
    .chat-progress > summary::after {
      content: "›";
      margin-left: auto;
      color: var(--muted);
      transform: rotate(90deg);
      transition: transform .12s ease;
    }
    .chat-progress[open] > summary::after { transform: rotate(-90deg); }
    .progress-spinner {
      width: 11px;
      height: 11px;
      flex: none;
      border: 1.5px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: running-spin .8s linear infinite;
    }
    .chat-progress:not(.running) .progress-spinner { display: none; }
    .progress-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 2px 8px 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .progress-empty { padding-top: 5px; }
    .progress-item {
      display: flex;
      align-items: flex-start;
      gap: 7px;
      min-width: 0;
      padding-top: 4px;
    }
    .progress-status {
      width: 12px;
      flex: none;
      text-align: center;
      line-height: 1.4;
    }
    .progress-item.running .progress-status {
      width: 9px;
      height: 9px;
      margin: 2px 2px 0 1px;
      border: 1.3px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: running-spin .8s linear infinite;
    }
    .progress-item.completed .progress-status { color: var(--vscode-testing-iconPassed, #4caf50); }
    .progress-item.error .progress-status { color: var(--vscode-errorForeground); }
    .progress-text {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .workspace-file-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      cursor: pointer;
    }
    .workspace-file-link:hover {
      color: var(--vscode-textLink-activeForeground);
      text-decoration: underline;
    }
    .files {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .file-chip {
      padding: 3px 10px;
      font-size: 11px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      border: 0;
      border-radius: 10px;
      cursor: pointer;
    }
    .context-note {
      margin-top: 5px;
      font-size: 11px;
      color: var(--muted);
    }
    .user-attachments {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 4px;
      margin-top: 6px;
    }
    .user-attachment {
      padding: 2px 6px;
      color: var(--vscode-textLink-foreground);
      background: transparent;
      border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 45%, transparent);
      border-radius: 7px;
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }

    /* ---- Auth panel ---- */
    #auth {
      display: none;
      margin: 4px 14px;
      padding: 12px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: var(--radius-card);
    }
    #auth p { margin: 0 0 10px; line-height: 1.5; }
    #auth .row { display: flex; gap: 6px; }
    #auth button {
      padding: 5px 12px;
      border: 0;
      border-radius: 8px;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    #auth button.secondary {
      color: var(--vscode-foreground);
      background: var(--vscode-button-secondaryBackground);
    }

    /* ---- Composer card ---- */
    .composer-wrap {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 12px 4px;
    }
    .card {
      position: relative;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: var(--radius-card);
      box-shadow: 0 2px 10px rgba(0, 0, 0, .10);
      padding: 10px 12px 8px;
    }
    .card:focus-within { border-color: var(--vscode-focusBorder); }
    #dropHint {
      position: absolute;
      inset: 5px;
      z-index: 10;
      display: none;
      align-items: center;
      justify-content: center;
      color: var(--vscode-button-foreground);
      background: color-mix(in srgb, var(--vscode-button-background) 88%, transparent);
      border: 1px dashed var(--vscode-button-foreground);
      border-radius: 12px;
      font-weight: 600;
      pointer-events: none;
    }
    .card.drag-active #dropHint { display: flex; }
    #filePicker,
    #slashPicker {
      max-height: 250px;
      margin: -2px -4px 8px;
      overflow-y: auto;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 10px;
      box-shadow: 0 5px 18px rgba(0, 0, 0, .25);
    }
    #filePicker[hidden],
    #slashPicker[hidden] { display: none; }
    .file-result {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 8px;
      color: var(--vscode-dropdown-foreground);
      background: transparent;
      border: 0;
      text-align: left;
      cursor: pointer;
    }
    .file-result:hover,
    .file-result.selected {
      color: var(--vscode-list-activeSelectionForeground);
      background: var(--vscode-list-activeSelectionBackground);
    }
    .file-result svg { width: 13px; height: 13px; flex: none; }
    .file-result-label {
      flex: none;
      max-width: 55%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file-result-path {
      flex: 1;
      overflow: hidden;
      color: var(--muted);
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file-result.selected .file-result-path { color: inherit; opacity: .8; }
    .file-empty { padding: 8px; color: var(--muted); font-size: 11px; }
    #mentionRow {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      padding-bottom: 7px;
    }
    #mentionRow[hidden] { display: none; }
    #queueRow {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin: 0 -2px 8px;
      padding: 7px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
    }
    #queueRow[hidden] { display: none; }
    .queue-heading {
      color: var(--muted);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: .02em;
      text-transform: uppercase;
    }
    .queue-item {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      font-size: 11px;
    }
    .queue-kind {
      flex: none;
      padding: 1px 5px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      border-radius: 5px;
      font-size: 10px;
    }
    .queue-item.interrupt .queue-kind {
      color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
      background: var(--vscode-inputValidation-warningBackground, var(--vscode-badge-background));
    }
    .queue-text {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .queue-remove {
      flex: none;
      padding: 0 3px;
      color: var(--muted);
      background: transparent;
      border: 0;
      border-radius: 3px;
      cursor: pointer;
    }
    .queue-remove:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
    }
    .mention-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 100%;
      padding: 3px 5px 3px 8px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      border-radius: 8px;
      font-size: 11px;
    }
    .mention-chip-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mention-remove {
      padding: 0 3px;
      color: inherit;
      background: transparent;
      border: 0;
      border-radius: 3px;
      cursor: pointer;
    }
    .mention-remove:hover { background: rgba(255, 255, 255, .15); }
    textarea {
      display: block;
      width: 100%;
      min-height: 44px;
      max-height: 200px;
      resize: none;
      padding: 2px 2px 8px;
      color: var(--vscode-input-foreground);
      background: transparent;
      border: 0;
      outline: none;
      font: inherit;
      line-height: 1.5;
    }
    textarea::placeholder { color: var(--muted); }
    .card-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #runningActions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #runningActions[hidden] { display: none; }
    .run-action {
      flex: 1;
      min-width: 0;
      height: 28px;
      padding: 0 10px;
      color: var(--vscode-foreground);
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .run-action:hover { background: var(--vscode-toolbar-hoverBackground); }
    .round-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      padding: 0;
      color: var(--vscode-icon-foreground);
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 50%;
      cursor: pointer;
    }
    .round-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .round-btn.active {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-color: var(--vscode-button-background);
    }
    .round-btn svg { width: 13px; height: 13px; }
    .add-control { position: relative; }
    #addMenu {
      position: absolute;
      left: 0;
      bottom: 34px;
      z-index: 35;
      width: min(250px, calc(100vw - 32px));
      max-height: min(420px, calc(100vh - 130px));
      overflow-y: auto;
      padding: 6px;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      background: var(--vscode-menu-background, var(--vscode-dropdown-background));
      border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, var(--vscode-panel-border)));
      border-radius: 11px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .32);
    }
    #addMenu[hidden] { display: none; }
    .add-menu-title {
      padding: 4px 8px 6px;
      color: var(--muted);
      font-size: 12px;
    }
    .add-menu-row {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-height: 32px;
      padding: 5px 8px;
      color: inherit;
      background: transparent;
      border: 0;
      border-radius: 6px;
      text-align: left;
      font: inherit;
      cursor: pointer;
    }
    .add-menu-row:hover { background: var(--vscode-list-hoverBackground); }
    .add-menu-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .add-menu-row:disabled { color: var(--muted); cursor: default; }
    .add-menu-row:disabled:hover { background: transparent; }
    .add-menu-icon {
      width: 18px;
      flex: none;
      color: var(--muted);
      text-align: center;
      font-size: 15px;
    }
    .add-menu-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .add-menu-meta { color: var(--muted); font-size: 11px; }
    .add-menu-separator {
      height: 1px;
      margin: 5px -6px;
      background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
    }
    #profileChip {
      display: none;
      max-width: 110px;
      padding: 3px 7px;
      overflow: hidden;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      border: 0;
      border-radius: 9px;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    #contextRow { padding-bottom: 6px; }
    .ctx-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      max-width: 100%;
      padding: 3px 6px 3px 8px;
      font-size: 11px;
      color: var(--muted);
      background: var(--vscode-toolbar-hoverBackground);
      border-radius: 8px;
    }
    .ctx-chip svg { width: 12px; height: 12px; flex: none; }
    #ctxLabel {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #ctxLabel.none { font-style: italic; }
    #ctxRemove {
      padding: 0 3px;
      font-size: 13px;
      line-height: 1;
      color: var(--muted);
      background: transparent;
      border: 0;
      border-radius: 4px;
      cursor: pointer;
    }
    #ctxRemove:hover { color: var(--vscode-foreground); }
    #authChip {
      display: none;
      align-items: center;
      gap: 4px;
      padding: 3px 9px;
      font-size: 11px;
      color: var(--vscode-editorWarning-foreground);
      background: transparent;
      border: 1px solid var(--vscode-editorWarning-foreground);
      border-radius: 10px;
      cursor: pointer;
    }
    .card-row .spacer { flex: 1; }
    #approvalSelect {
      max-width: 108px;
      padding: 2px 2px;
      font-size: 12px;
      color: var(--muted);
      background: transparent;
      border: 0;
      outline: none;
      cursor: pointer;
    }
    #approvalSelect option {
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
    }
    .model-control { position: relative; }
    #modelButton {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 132px;
      padding: 3px 4px;
      color: var(--muted);
      background: transparent;
      border: 0;
      border-radius: 5px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    #modelButton:hover,
    #modelButton[aria-expanded="true"] {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
    }
    #modelButtonLabel {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #modelButton svg {
      width: 10px;
      height: 10px;
      flex: none;
    }
    #modelPicker {
      position: fixed;
      left: 12px;
      bottom: 72px;
      z-index: 30;
      display: grid;
      grid-template-columns: minmax(190px, 1.1fr) minmax(170px, .9fr);
      width: min(500px, calc(100vw - 32px));
      max-height: min(430px, calc(100vh - 130px));
      overflow: hidden;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      background: var(--vscode-menu-background, var(--vscode-dropdown-background));
      border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, var(--vscode-panel-border)));
      border-radius: 12px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .32);
    }
    #modelPicker[hidden] { display: none; }
    #modelPicker.options-empty { grid-template-columns: 1fr; width: min(270px, calc(100vw - 32px)); }
    .model-pane {
      min-width: 0;
      min-height: 0;
      overflow-y: auto;
    }
    .model-list-pane {
      display: flex;
      flex-direction: column;
      padding: 7px;
    }
    #modelSearch {
      width: 100%;
      margin-bottom: 5px;
      padding: 7px 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid transparent;
      border-radius: 7px;
      outline: none;
      font: inherit;
    }
    #modelSearch:focus { border-color: var(--vscode-focusBorder); }
    #modelList {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }
    .model-row,
    .model-option-row,
    .model-toggle-row {
      display: flex;
      align-items: center;
      width: 100%;
      min-height: 30px;
      padding: 5px 7px;
      color: inherit;
      background: transparent;
      border: 0;
      border-radius: 6px;
      text-align: left;
      font: inherit;
      cursor: pointer;
    }
    .model-row:hover,
    .model-option-row:hover,
    .model-toggle-row:hover { background: var(--vscode-list-hoverBackground); }
    .model-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .model-row-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .model-row-description {
      margin-left: 5px;
      overflow: hidden;
      color: var(--muted);
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11px;
    }
    .model-empty {
      padding: 12px 8px;
      color: var(--muted);
      font-size: 12px;
    }
    #modelOptionsPane {
      border-left: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
      padding: 8px 7px;
    }
    #modelOptionsPane[hidden] { display: none; }
    .model-options-title,
    .model-param-title {
      padding: 1px 7px 6px;
      color: var(--muted);
      font-size: 11px;
    }
    .model-param-group {
      margin: 4px 0;
      padding-top: 6px;
      border-top: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
    }
    .model-option-label { flex: 1; }
    .model-check {
      width: 15px;
      margin-left: 8px;
      text-align: center;
    }
    .model-switch {
      position: relative;
      width: 30px;
      height: 18px;
      margin-left: auto;
      background: var(--vscode-inputOption-activeBackground, var(--vscode-disabledForeground));
      border-radius: 10px;
    }
    .model-switch::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      background: var(--vscode-button-foreground);
      border-radius: 50%;
      transition: transform .12s ease;
    }
    .model-switch.on { background: var(--vscode-button-background); }
    .model-switch.on::after { transform: translateX(12px); }

    /* Narrow sidebar (typical VS Code activity-bar width) */
    @media (max-width: 420px) {
      .header { padding: 8px 10px 6px; gap: 2px; }
      #scroller { padding: 4px 10px; }
      #auth { margin: 4px 10px; padding: 10px; }
      #auth .row { flex-wrap: wrap; }
      .composer-wrap { padding: 6px 8px 2px; }
      .card {
        padding: 8px 8px 6px;
        border-radius: 12px;
      }
      .user { max-width: 100%; }
      .assistant { padding-right: 24px; }
      .tasks-title { padding-left: 4px; }
      .task-row { padding: 6px 4px; gap: 6px; }
      .task-time { font-size: 10px; }

      .card-row {
        flex-wrap: wrap;
        align-items: center;
        row-gap: 6px;
        column-gap: 6px;
      }
      .model-control { min-width: 0; }
      #sendButton { margin-left: auto; }
      #approvalSelect { max-width: min(96px, 28vw); }
      #modelButton { max-width: min(110px, 34vw); }
      #profileChip { max-width: 88px; }
      #authChip {
        max-width: 7.2em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #addMenu {
        width: min(250px, calc(100vw - 20px));
        max-height: min(360px, calc(100vh - 110px));
      }
      .file-result-label { max-width: 100%; }
      .file-result-path {
        flex: 1 1 100%;
        padding-left: 21px;
      }
      .model-row-description { display: none; }

      .footer {
        gap: 4px;
        padding: 2px 10px 8px;
        font-size: 11px;
      }
      #workspaceLabel {
        min-width: 0;
        max-width: 36%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #modelPicker {
        grid-template-columns: 1fr;
        grid-template-rows: minmax(150px, 1fr) minmax(120px, .75fr);
        width: min(290px, calc(100vw - 16px));
        height: min(520px, calc(100vh - 120px));
        max-height: min(520px, calc(100vh - 120px));
      }
      #modelPicker.options-empty {
        grid-template-rows: minmax(0, auto);
        height: auto;
      }
      #modelOptionsPane {
        min-height: 0;
        max-height: none;
        overflow-y: auto;
        border-top: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
        border-left: 0;
      }
    }

    @media (max-width: 300px) {
      .brand {
        font-size: 10px;
        letter-spacing: .06em;
      }
      .ghost svg {
        width: 48px;
        height: 48px;
      }
      #auth .row {
        flex-direction: column;
      }
      #auth .row button { width: 100%; }
      .footer > svg:first-child,
      #workspaceLabel,
      .footer-sep:not(.footer-version-sep) {
        display: none;
      }
      #runningIndicator { padding: 2px 5px; }
      #runningIndicator > span:not(.running-spinner) { display: none; }
      #approvalSelect { max-width: 72px; }
      #modelButton { max-width: 84px; }
    }
    #sendButton {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      padding: 0;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 0;
      border-radius: 50%;
      cursor: pointer;
    }
    #sendButton:hover { background: var(--vscode-button-hoverBackground); }
    #sendButton svg { width: 14px; height: 14px; }
    #sendButton .stop-icon { display: none; }
    #sendButton.running .send-icon { display: none; }
    #sendButton.running .stop-icon { display: block; }

    /* ---- Footer ---- */
    .footer {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 16px 10px;
      font-size: 12px;
      color: var(--muted);
    }
    .footer svg { width: 13px; height: 13px; flex: none; }
    #status {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #extensionVersion {
      flex: none;
      opacity: .85;
      font-variant-numeric: tabular-nums;
    }
    #runningIndicator {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      flex: none;
      margin-left: auto;
      padding: 2px 7px;
      color: var(--vscode-statusBarItem-prominentForeground, var(--vscode-foreground));
      background: var(--vscode-statusBarItem-prominentBackground, var(--vscode-badge-background));
      border-radius: 9px;
      font-size: 11px;
    }
    #runningIndicator[hidden] { display: none; }
    .running-spinner {
      width: 10px;
      height: 10px;
      border: 1.5px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: running-spin .8s linear infinite;
    }
    @keyframes running-spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="header">
    <span class="brand">Cursor</span>
    <span class="spacer"></span>
    <button id="historyButton" class="icon-btn" type="button" title="${ui.history}">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="8" cy="8" r="6.2"/>
        <path d="M8 4.8V8l2.2 1.6"/>
      </svg>
    </button>
    <button id="newChatButton" class="icon-btn" type="button" title="${ui.newChat}">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
        <path d="M11.5 2.5l2 2L6 12l-2.7.7L4 10l7.5-7.5z"/>
        <path d="M13.5 8.5v4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h4"/>
      </svg>
    </button>
    <button id="keyButton" class="icon-btn" type="button" title="${ui.setApiKey}">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="5" cy="8" r="3"/>
        <path d="M8 8h6M11 8v2M13.5 8v2"/>
      </svg>
    </button>
  </div>

  <div id="auth">
    <p>${ui.authMessage}</p>
    <div class="row">
      <button id="connectButton" type="button">${ui.setApiKey}</button>
      <button id="dashboardButton" class="secondary" type="button">${ui.openDashboard}</button>
    </div>
  </div>

  <div id="scroller">
    <div id="messages" aria-live="polite" style="display: none;"></div>
    <div id="home">
      <div id="tasks" hidden>
        <div class="tasks-title">${ui.tasks}</div>
        <div id="taskList"></div>
        <button id="viewAll" type="button" hidden></button>
      </div>
      <div class="ghost">
        <svg viewBox="668 350 264 300" fill="currentColor">
          <path d="M920.015 424.958L805.919 359.086C802.256 356.97 797.735 356.97 794.071 359.086L679.981 424.958C676.901 426.736 675 430.025 675 433.587V566.419C675 569.981 676.901 573.269 679.981 575.048L794.077 640.92C797.74 643.036 802.261 643.036 805.925 640.92L920.02 575.048C923.1 573.269 925.001 569.981 925.001 566.419V433.587C925.001 430.025 923.1 426.736 920.02 424.958H920.015ZM912.848 438.911L802.706 629.682C801.961 630.968 799.995 630.443 799.995 628.954V504.039C799.995 501.543 798.662 499.234 796.498 497.981L688.321 435.526C687.036 434.781 687.561 432.816 689.05 432.816H909.334C912.462 432.816 914.417 436.206 912.853 438.917H912.848V438.911Z"/>
        </svg>
      </div>
    </div>
  </div>

  <div class="composer-wrap">
    <div id="runningActions" hidden>
      <button id="queueButton" class="run-action" type="button" title="${ui.queueTitle}">${ui.queue}</button>
      <button id="interruptButton" class="run-action" type="button" title="${ui.interruptTitle}">${ui.interrupt}</button>
    </div>
    <div class="card">
      <div id="dropHint" aria-live="polite">${ui.dropFiles}</div>
      <div id="contextRow" hidden>
        <span class="ctx-chip">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
            <path d="M9.5 1.5H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5l-3-3z"/>
            <path d="M9.5 1.5v3h3"/>
          </svg>
          <span id="ctxLabel"></span>
          <button id="ctxRemove" type="button" title="${ui.detach}">×</button>
        </span>
      </div>
      <div id="mentionRow" aria-label="${ui.referencedFiles}" hidden></div>
      <div id="queueRow" aria-label="${ui.queuedMessages}" hidden></div>
      <div id="filePicker" role="listbox" aria-label="${ui.workspaceFiles}" hidden></div>
      <div id="slashPicker" role="listbox" aria-label="${ui.slashCommands}" hidden></div>
      <textarea id="prompt" placeholder="${ui.prompt}" aria-label="${ui.promptLabel}" rows="2"></textarea>
      <div class="card-row">
        <div class="add-control">
          <button id="attachButton" class="round-btn" type="button" title="${ui.addContextTools}" aria-expanded="false">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M8 3v10M3 8h10"/>
            </svg>
          </button>
          <div id="addMenu" hidden>
            <div id="addMenuContent"></div>
          </div>
        </div>
        <button id="profileChip" type="button"></button>
        <button id="authChip" type="button" title="${ui.setApiKey}">${ui.apiKeyMissing}</button>
        <span class="spacer"></span>
        <select id="approvalSelect" aria-label="${ui.approvalMode}">
          <option value="auto-review">${ui.autoReview}</option>
          <option value="full-access">${ui.fullAccess}</option>
        </select>
        <div class="model-control">
          <button id="modelButton" type="button" aria-label="${ui.model}" aria-expanded="false">
            <span id="modelButtonLabel">Auto</span>
            <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2">
              <path d="M2 3.5 5 6.5 8 3.5"/>
            </svg>
          </button>
          <div id="modelPicker" hidden>
            <div class="model-pane model-list-pane">
              <input id="modelSearch" type="search" placeholder="${ui.searchModels}" aria-label="${ui.searchModels}">
              <div id="modelList"></div>
            </div>
            <div id="modelOptionsPane" class="model-pane" hidden>
              <div class="model-options-title">${ui.modelOptions}</div>
              <div id="modelOptions"></div>
            </div>
          </div>
        </div>
        <button id="sendButton" type="button" title="${ui.send}">
          <svg class="send-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/>
          </svg>
          <svg class="stop-icon" viewBox="0 0 16 16" fill="currentColor">
            <rect x="4" y="4" width="8" height="8" rx="1.5"/>
          </svg>
        </button>
      </div>
    </div>
  </div>

  <div class="footer">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
      <rect x="1.8" y="3" width="12.4" height="8" rx="1"/>
      <path d="M5.5 13.5h5"/>
    </svg>
    <span id="workspaceLabel">${ui.localRun}</span>
    <span class="footer-sep" aria-hidden="true">·</span>
    <span id="status">${ui.checkingConnection}</span>
    <span class="footer-sep footer-version-sep" aria-hidden="true">·</span>
    <span id="extensionVersion" title="Extension version">v${extensionVersion}</span>
    <span id="runningIndicator" hidden>
      <span class="running-spinner" aria-hidden="true"></span>
      <span>${ui.running}</span>
    </span>
  </div>

  <script nonce="${nonce}" src="${markedUri}"></script>
  <script nonce="${nonce}" src="${purifyUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const i18n = ${JSON.stringify(ui)};
    const messages = document.getElementById("messages");
    const home = document.getElementById("home");
    const tasks = document.getElementById("tasks");
    const taskList = document.getElementById("taskList");
    const viewAll = document.getElementById("viewAll");
    const historyButton = document.getElementById("historyButton");
    const scroller = document.getElementById("scroller");
    const prompt = document.getElementById("prompt");
    const composerCard = document.querySelector(".composer-wrap .card");
    const sendButton = document.getElementById("sendButton");
    const attachButton = document.getElementById("attachButton");
    const addMenu = document.getElementById("addMenu");
    const addMenuContent = document.getElementById("addMenuContent");
    const profileChip = document.getElementById("profileChip");
    const newChatButton = document.getElementById("newChatButton");
    const status = document.getElementById("status");
    const runningIndicator = document.getElementById("runningIndicator");
    const workspaceLabel = document.getElementById("workspaceLabel");
    const auth = document.getElementById("auth");
    const authChip = document.getElementById("authChip");
    const approvalSelect = document.getElementById("approvalSelect");
    const modelButton = document.getElementById("modelButton");
    const modelButtonLabel = document.getElementById("modelButtonLabel");
    const modelPicker = document.getElementById("modelPicker");
    const modelSearch = document.getElementById("modelSearch");
    const modelList = document.getElementById("modelList");
    const modelOptionsPane = document.getElementById("modelOptionsPane");
    const modelOptions = document.getElementById("modelOptions");
    const contextRow = document.getElementById("contextRow");
    const ctxLabel = document.getElementById("ctxLabel");
    const ctxRemove = document.getElementById("ctxRemove");
    const mentionRow = document.getElementById("mentionRow");
    const queueRow = document.getElementById("queueRow");
    const runningActions = document.getElementById("runningActions");
    const queueButton = document.getElementById("queueButton");
    const interruptButton = document.getElementById("interruptButton");
    const filePicker = document.getElementById("filePicker");
    const slashPicker = document.getElementById("slashPicker");
    let assistantNode;
    let assistantRaw = "";
    let activeProgress;
    let running = false;
    let runningSoundEnabled = false;
    let completionSoundEnabled = false;
    let errorSoundEnabled = false;
    let runningSoundTimer;
    let runningAudioContext;
    let sandboxUnavailable = false;
    let attach = false;
    let view = "home";
    let allConversations = [];
    let tasksExpanded = false;
    let selectedFiles = [];
    let fileResults = [];
    let selectedFileIndex = 0;
    let fileRequestId = 0;
    let mentionRange;
    let slashResults = [];
    let selectedSlashIndex = 0;
    let slashRange;
    let workspacePaths = new Set();
    let workspaceBasenames = new Set();
    let attachmentRequestId = 0;
    let availableModels = [];
    let selectedModelId = "auto";
    let modelParamState = {};
    let runProfile = "agent";
    let availableSkills = [];
    let selectedSkills = [];
    let availableMcpServers = [];
    let queuedMessages = [];
    let followOutput = true;

    function profileLabel(profile) {
      return {
        agent: i18n.standardProfile,
        plan: i18n.planProfile,
        multitask: i18n.multitaskProfile,
      }[profile] || profile;
    }

    function updateProfileChip() {
      const labels = [];
      if (runProfile !== "agent") labels.push(profileLabel(runProfile));
      if (selectedSkills.length > 0) labels.push(i18n.skills + " " + selectedSkills.length);
      profileChip.style.display = labels.length > 0 ? "inline-block" : "none";
      profileChip.textContent = labels.join(" · ");
      profileChip.title = labels.join(", ");
      attachButton.classList.toggle("active", attach || labels.length > 0);
    }

    function addMenuTitle(text) {
      const title = document.createElement("div");
      title.className = "add-menu-title";
      title.textContent = text;
      addMenuContent.appendChild(title);
    }

    function addMenuSeparator() {
      const separator = document.createElement("div");
      separator.className = "add-menu-separator";
      addMenuContent.appendChild(separator);
    }

    function addMenuRow(iconText, labelText, options) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "add-menu-row" + (options.selected ? " selected" : "");
      row.disabled = options.disabled === true;
      if (options.title) row.title = options.title;
      const icon = document.createElement("span");
      icon.className = "add-menu-icon";
      icon.textContent = iconText;
      const label = document.createElement("span");
      label.className = "add-menu-label";
      label.textContent = labelText;
      row.append(icon, label);
      if (options.meta) {
        const meta = document.createElement("span");
        meta.className = "add-menu-meta";
        meta.textContent = options.meta;
        row.appendChild(meta);
      }
      if (options.onClick) row.addEventListener("click", options.onClick);
      addMenuContent.appendChild(row);
      return row;
    }

    function selectRunProfile(profile) {
      runProfile = profile;
      updateProfileChip();
      closeAddMenu();
    }

    function slashCommands() {
      return [
        {
          id: "agent",
          aliases: ["agent", "standard"],
          label: i18n.standardProfile,
          description: i18n.standardProfileDescription,
          icon: "A",
          profile: "agent",
        },
        {
          id: "plan",
          aliases: ["plan"],
          label: i18n.planProfile,
          description: i18n.planProfileDescription,
          icon: "☷",
          profile: "plan",
        },
        {
          id: "multitask",
          aliases: ["multitask"],
          label: i18n.multitaskProfile,
          description: i18n.multitaskProfileDescription,
          icon: "⑂",
          profile: "multitask",
        },
      ];
    }

    function consumeLeadingSlashCommand(text) {
      const match = /^\\/(agent|standard|plan|multitask)(?:\\s+|$)/i.exec(text);
      if (!match) return { text, profile: undefined };
      const command = match[1].toLowerCase();
      const profile = command === "standard" || command === "agent" ? "agent" : command;
      return {
        text: text.slice(match[0].length).replace(/^\\s+/, ""),
        profile,
      };
    }

    function renderMainAddMenu() {
      addMenuContent.innerHTML = "";
      addMenuTitle(i18n.addContextTools);
      addMenuRow("＋", i18n.attachActive, {
        selected: attach,
        onClick: () => {
          setAttach(!attach);
          closeAddMenu();
        },
      });
      addMenuSeparator();
      for (const profile of ["agent", "plan", "multitask"]) {
        const icons = { agent: "A", plan: "☷", multitask: "⑂" };
        addMenuRow(icons[profile], profileLabel(profile), {
          selected: runProfile === profile,
          meta: runProfile === profile ? "✓" : "",
          onClick: () => selectRunProfile(profile),
        });
      }
      addMenuSeparator();
      addMenuRow("▧", i18n.image, {
        onClick: () => {
          attachmentRequestId += 1;
          vscode.postMessage({ type: "pickImages", requestId: attachmentRequestId });
          closeAddMenu();
        },
      });
      addMenuRow("◇", i18n.skills, {
        meta: selectedSkills.length > 0 ? String(selectedSkills.length) + " ›" : "›",
        onClick: renderSkillsMenu,
      });
      addMenuRow("⌁", i18n.mcpServers, {
        meta: availableMcpServers.length > 0 ? String(availableMcpServers.length) + " ›" : "›",
        onClick: renderMcpMenu,
      });
    }

    function renderSkillsMenu() {
      addMenuContent.innerHTML = "";
      addMenuRow("‹", i18n.back, { onClick: renderMainAddMenu });
      addMenuTitle(i18n.skills);
      if (availableSkills.length === 0) {
        addMenuRow("◇", i18n.noSkills, { disabled: true });
      } else {
        for (const skill of availableSkills) {
          addMenuRow("◇", skill.name, {
            title: skill.description || skill.name,
            selected: selectedSkills.includes(skill.name),
            meta: selectedSkills.includes(skill.name) ? "✓" : "",
            onClick: () => {
              if (selectedSkills.includes(skill.name)) {
                selectedSkills = selectedSkills.filter((name) => name !== skill.name);
              } else {
                selectedSkills.push(skill.name);
              }
              updateProfileChip();
              renderSkillsMenu();
            },
          });
        }
      }
      addMenuSeparator();
      addMenuRow("↗", i18n.openSkillsFolder, {
        onClick: () => {
          vscode.postMessage({ type: "openSkillsFolder" });
          closeAddMenu();
        },
      });
    }

    function renderMcpMenu() {
      addMenuContent.innerHTML = "";
      addMenuRow("‹", i18n.back, { onClick: renderMainAddMenu });
      addMenuTitle(i18n.mcpServers);
      if (availableMcpServers.length === 0) {
        addMenuRow("⌁", i18n.noMcpServers, { disabled: true });
      } else {
        for (const server of availableMcpServers) {
          addMenuRow("●", server, { disabled: true, meta: "✓" });
        }
      }
      addMenuSeparator();
      addMenuRow("↗", i18n.openMcpSettings, {
        onClick: () => {
          vscode.postMessage({ type: "openMcpSettings" });
          closeAddMenu();
        },
      });
    }

    function openAddMenu() {
      closeModelPicker();
      renderMainAddMenu();
      addMenu.hidden = false;
      attachButton.setAttribute("aria-expanded", "true");
    }

    function closeAddMenu() {
      addMenu.hidden = true;
      attachButton.setAttribute("aria-expanded", "false");
    }

    function selectedModelDefinition() {
      return availableModels.find((model) => model.id === selectedModelId);
    }

    function defaultParamsFor(model) {
      const defaultVariant = (model.variants || []).find((variant) => variant.isDefault);
      const params = defaultVariant ? defaultVariant.params.map((param) => ({ ...param })) : [];
      for (const parameter of model.parameters || []) {
        if (!params.some((param) => param.id === parameter.id) && parameter.values.length > 0) {
          params.push({ id: parameter.id, value: parameter.values[0].value });
        }
      }
      return params;
    }

    function paramsForModel(model) {
      if (!Object.prototype.hasOwnProperty.call(modelParamState, model.id)) {
        modelParamState[model.id] = defaultParamsFor(model);
      }
      return modelParamState[model.id];
    }

    function updateModelButton() {
      const model = selectedModelDefinition();
      modelButtonLabel.textContent = model ? model.label : selectedModelId;
      modelButton.title = model && model.description
        ? model.label + ": " + model.description
        : modelButtonLabel.textContent;
    }

    function postModelSelection() {
      const model = selectedModelDefinition();
      vscode.postMessage({
        type: "selectModel",
        modelId: selectedModelId,
        modelParams: model ? paramsForModel(model) : [],
      });
    }

    function setModelParameter(model, parameterId, value) {
      const params = paramsForModel(model);
      const existing = params.find((param) => param.id === parameterId);
      if (existing) {
        existing.value = value;
      } else {
        params.push({ id: parameterId, value });
      }
      postModelSelection();
      renderModelOptions();
    }

    function booleanValues(parameter) {
      if (parameter.values.length !== 2) return;
      const truthy = new Set(["true", "on", "enabled", "yes", "1"]);
      const falsy = new Set(["false", "off", "disabled", "no", "0"]);
      const enabled = parameter.values.find((item) =>
        truthy.has(item.value.toLowerCase()) || truthy.has(item.label.toLowerCase()));
      const disabled = parameter.values.find((item) =>
        falsy.has(item.value.toLowerCase()) || falsy.has(item.label.toLowerCase()));
      return enabled && disabled ? { enabled, disabled } : undefined;
    }

    function hasModelOptions(model) {
      return Boolean(model && ((model.parameters || []).length || (model.variants || []).length));
    }

    function renderModelList() {
      modelList.innerHTML = "";
      const query = modelSearch.value.trim().toLowerCase();
      const filtered = availableModels.filter((model) =>
        !query || [model.id, model.label, model.description || ""]
          .some((value) => value.toLowerCase().includes(query)));
      if (filtered.length === 0) {
        const empty = document.createElement("div");
        empty.className = "model-empty";
        empty.textContent = i18n.noMatchingModels;
        modelList.appendChild(empty);
        return;
      }
      for (const model of filtered) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "model-row" + (model.id === selectedModelId ? " selected" : "");
        row.title = model.description || model.label;

        const name = document.createElement("span");
        name.className = "model-row-name";
        name.textContent = model.label;
        row.appendChild(name);
        if (model.description) {
          const description = document.createElement("span");
          description.className = "model-row-description";
          description.textContent = model.description;
          row.appendChild(description);
        }
        row.addEventListener("click", () => {
          selectedModelId = model.id;
          paramsForModel(model);
          updateModelButton();
          postModelSelection();
          renderModelList();
          renderModelOptions();
          if (!hasModelOptions(model)) closeModelPicker();
        });
        modelList.appendChild(row);
      }
    }

    function addModelOption(group, label, selected, onSelect) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "model-option-row";
      const text = document.createElement("span");
      text.className = "model-option-label";
      text.textContent = label;
      const check = document.createElement("span");
      check.className = "model-check";
      check.textContent = selected ? "✓" : "";
      row.append(text, check);
      row.addEventListener("click", onSelect);
      group.appendChild(row);
    }

    function renderModelOptions() {
      modelOptions.innerHTML = "";
      const model = selectedModelDefinition();
      const showOptions = hasModelOptions(model);
      modelOptionsPane.hidden = !showOptions;
      modelPicker.classList.toggle("options-empty", !showOptions);
      if (!modelPicker.hidden) requestAnimationFrame(positionModelPicker);
      if (!model || !showOptions) return;

      const params = paramsForModel(model);
      for (const parameter of model.parameters || []) {
        const group = document.createElement("div");
        group.className = "model-param-group";
        const boolean = booleanValues(parameter);
        const selected = params.find((param) => param.id === parameter.id)?.value;
        if (boolean) {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "model-toggle-row";
          row.setAttribute("role", "switch");
          const on = selected === boolean.enabled.value;
          row.setAttribute("aria-checked", String(on));
          const label = document.createElement("span");
          label.className = "model-option-label";
          label.textContent = parameter.label;
          const toggle = document.createElement("span");
          toggle.className = "model-switch" + (on ? " on" : "");
          row.append(label, toggle);
          row.addEventListener("click", () =>
            setModelParameter(model, parameter.id, on ? boolean.disabled.value : boolean.enabled.value));
          group.appendChild(row);
        } else {
          const title = document.createElement("div");
          title.className = "model-param-title";
          title.textContent = parameter.label;
          group.appendChild(title);
          for (const value of parameter.values) {
            addModelOption(group, value.label, selected === value.value, () =>
              setModelParameter(model, parameter.id, value.value));
          }
        }
        modelOptions.appendChild(group);
      }

      if ((model.parameters || []).length === 0 && (model.variants || []).length > 0) {
        const group = document.createElement("div");
        group.className = "model-param-group";
        const title = document.createElement("div");
        title.className = "model-param-title";
        title.textContent = i18n.variant;
        group.appendChild(title);
        for (const variant of model.variants) {
          const selected = variant.params.every((expected) =>
            params.some((param) => param.id === expected.id && param.value === expected.value));
          addModelOption(group, variant.label, selected, () => {
            modelParamState[model.id] = variant.params.map((param) => ({ ...param }));
            postModelSelection();
            renderModelOptions();
          });
        }
        modelOptions.appendChild(group);
      }
    }

    function positionModelPicker() {
      if (modelPicker.hidden) return;
      const narrow = window.innerWidth <= 420;
      const veryNarrow = window.innerWidth <= 300;
      const margin = veryNarrow ? 8 : narrow ? 8 : 12;
      const gap = 6;
      const buttonRect = modelButton.getBoundingClientRect();
      const desiredWidth = modelPicker.classList.contains("options-empty")
        ? narrow ? Math.min(270, window.innerWidth - margin * 2) : 270
        : narrow ? 290 : 500;
      const width = Math.min(desiredWidth, Math.max(0, window.innerWidth - margin * 2));
      const left = Math.min(
        Math.max(margin, buttonRect.right - width),
        Math.max(margin, window.innerWidth - margin - width),
      );
      const availableAbove = Math.max(80, buttonRect.top - gap - margin);
      const maxHeight = Math.min(narrow ? 520 : 430, availableAbove);

      modelPicker.style.left = Math.round(left) + "px";
      modelPicker.style.right = "auto";
      modelPicker.style.bottom = Math.round(window.innerHeight - buttonRect.top + gap) + "px";
      modelPicker.style.width = Math.round(width) + "px";
      modelPicker.style.maxHeight = Math.round(maxHeight) + "px";
    }

    function openModelPicker() {
      closeAddMenu();
      modelPicker.hidden = false;
      modelButton.setAttribute("aria-expanded", "true");
      renderModelList();
      renderModelOptions();
      positionModelPicker();
      modelSearch.focus();
      modelSearch.select();
    }

    function closeModelPicker() {
      modelPicker.hidden = true;
      modelButton.setAttribute("aria-expanded", "false");
      modelSearch.value = "";
    }

    function relTime(ts) {
      const seconds = (Date.now() - ts) / 1000;
      if (seconds < 60) return i18n.justNow;
      const minutes = seconds / 60;
      if (minutes < 60) return Math.floor(minutes) + i18n.minutesAgo;
      const hours = minutes / 60;
      if (hours < 24) return Math.floor(hours) + i18n.hoursAgo;
      const days = hours / 24;
      if (days < 2) return i18n.yesterday;
      if (days < 7) return Math.floor(days) + i18n.daysAgo;
      return new Date(ts).toLocaleDateString();
    }

    function renderTasks() {
      taskList.innerHTML = "";
      tasks.hidden = allConversations.length === 0;
      const items = tasksExpanded ? allConversations : allConversations.slice(0, 5);
      for (const conv of items) {
        const row = document.createElement("div");
        row.className = "task-row";
        row.title = conv.title;

        const title = document.createElement("span");
        title.className = "task-title";
        title.textContent = conv.title;

        const time = document.createElement("span");
        time.className = "task-time";
        time.textContent = relTime(conv.updatedAt);

        const del = document.createElement("button");
        del.className = "task-delete";
        del.type = "button";
        del.textContent = "×";
        del.title = i18n.deleteConversation;
        del.addEventListener("click", (event) => {
          event.stopPropagation();
          vscode.postMessage({ type: "deleteConversation", id: conv.id });
        });

        row.append(title, time, del);
        row.addEventListener("click", () => vscode.postMessage({ type: "openConversation", id: conv.id }));
        taskList.appendChild(row);
      }
      viewAll.hidden = tasksExpanded || allConversations.length <= 5;
      viewAll.textContent = i18n.showAll + " (" + allConversations.length + ")";
    }

    function clearMessages() {
      messages.innerHTML = "";
      assistantNode = undefined;
      assistantRaw = "";
      activeProgress = undefined;
      followOutput = true;
      scroller.scrollTop = 0;
    }

    function showHome(convs) {
      view = "home";
      if (convs) {
        allConversations = convs;
        tasksExpanded = false;
      }
      clearMessages();
      home.style.display = "flex";
      messages.style.display = "none";
      renderTasks();
    }

    function showChat() {
      view = "chat";
      home.style.display = "none";
      messages.style.display = "flex";
    }

    function setAttach(value) {
      attach = value;
      updateProfileChip();
      contextRow.hidden = !attach;
      if (attach) vscode.postMessage({ type: "getContext" });
    }

    function setApprovalMode(mode) {
      approvalSelect.value = mode;
      sandboxUnavailable = false;
      const descriptions = {
        "auto-review": i18n.autoReviewDescription,
        "full-access": i18n.fullAccessDescription,
      };
      approvalSelect.title = descriptions[mode] || i18n.approvalMode;
    }

    function updateContextChip(label) {
      if (label) {
        ctxLabel.textContent = label;
        ctxLabel.classList.remove("none");
      } else {
        ctxLabel.textContent = i18n.noActiveFile;
        ctxLabel.classList.add("none");
      }
    }

    function activeMention() {
      const caret = prompt.selectionStart;
      const beforeCaret = prompt.value.slice(0, caret);
      const match = /(^|\\s)@([^\\s@]*)$/.exec(beforeCaret);
      if (!match) return undefined;
      return {
        start: caret - match[2].length - 1,
        end: caret,
        query: match[2],
      };
    }

    function activeSlashCommand() {
      const caret = prompt.selectionStart;
      const beforeCaret = prompt.value.slice(0, caret);
      const match = /(^|\\s)\\/([\\w-]*)$/.exec(beforeCaret);
      if (!match) return undefined;
      return {
        start: caret - match[2].length - 1,
        end: caret,
        query: match[2].toLowerCase(),
      };
    }

    function closeFilePicker() {
      filePicker.hidden = true;
      filePicker.innerHTML = "";
      fileResults = [];
      selectedFileIndex = 0;
      mentionRange = undefined;
    }

    function closeSlashPicker() {
      slashPicker.hidden = true;
      slashPicker.innerHTML = "";
      slashResults = [];
      selectedSlashIndex = 0;
      slashRange = undefined;
    }

    function requestFileResults() {
      const mention = activeMention();
      if (!mention) {
        closeFilePicker();
        return;
      }
      closeSlashPicker();
      mentionRange = mention;
      selectedFileIndex = 0;
      fileRequestId += 1;
      vscode.postMessage({
        type: "searchFiles",
        query: mention.query,
        requestId: fileRequestId,
      });
    }

    function requestSlashResults() {
      if (activeMention()) {
        closeSlashPicker();
        return;
      }
      const slash = activeSlashCommand();
      if (!slash) {
        closeSlashPicker();
        return;
      }
      closeFilePicker();
      slashRange = slash;
      slashResults = slashCommands().filter((command) =>
        command.aliases.some((alias) => alias.startsWith(slash.query))
          || command.label.toLowerCase().startsWith(slash.query),
      );
      selectedSlashIndex = 0;
      renderSlashResults();
    }

    function renderSlashResults() {
      slashPicker.innerHTML = "";
      if (slashResults.length === 0) {
        const empty = document.createElement("div");
        empty.className = "file-empty";
        empty.textContent = i18n.noMatchingCommands;
        slashPicker.appendChild(empty);
        slashPicker.hidden = false;
        return;
      }

      selectedSlashIndex = Math.max(0, Math.min(selectedSlashIndex, slashResults.length - 1));
      slashResults.forEach((command, index) => {
        const row = document.createElement("button");
        row.className = "file-result" + (index === selectedSlashIndex ? " selected" : "");
        row.type = "button";
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", index === selectedSlashIndex ? "true" : "false");
        row.title = "/" + command.id;

        const icon = document.createElement("span");
        icon.textContent = command.icon;
        const label = document.createElement("span");
        label.className = "file-result-label";
        label.textContent = "/" + command.id;
        const description = document.createElement("span");
        description.className = "file-result-path";
        description.textContent = command.description;
        row.append(icon, label, description);
        row.addEventListener("mousedown", (event) => event.preventDefault());
        row.addEventListener("click", () => selectSlashCommand(command));
        slashPicker.appendChild(row);
      });
      slashPicker.hidden = false;
      slashPicker.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
    }

    function selectSlashCommand(command) {
      if (slashRange) {
        prompt.value = prompt.value.slice(0, slashRange.start) + prompt.value.slice(slashRange.end);
        prompt.selectionStart = prompt.selectionEnd = slashRange.start;
      }
      selectRunProfile(command.profile);
      closeSlashPicker();
      autoGrow();
      prompt.focus();
    }

    function updateComposerSuggestions() {
      if (activeMention()) {
        requestFileResults();
        return;
      }
      closeFilePicker();
      requestSlashResults();
    }

    function renderFileResults() {
      filePicker.innerHTML = "";
      if (fileResults.length === 0) {
        const empty = document.createElement("div");
        empty.className = "file-empty";
        empty.textContent = i18n.noMatchingFiles;
        filePicker.appendChild(empty);
        filePicker.hidden = false;
        return;
      }

      selectedFileIndex = Math.max(0, Math.min(selectedFileIndex, fileResults.length - 1));
      fileResults.forEach((file, index) => {
        const row = document.createElement("button");
        row.className = "file-result" + (index === selectedFileIndex ? " selected" : "");
        row.type = "button";
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", index === selectedFileIndex ? "true" : "false");
        row.title = file.path;

        const icon = document.createElement("span");
        icon.textContent = "@";
        const label = document.createElement("span");
        label.className = "file-result-label";
        label.textContent = file.label;
        const directory = document.createElement("span");
        directory.className = "file-result-path";
        directory.textContent = file.description;
        row.append(icon, label, directory);
        row.addEventListener("mousedown", (event) => event.preventDefault());
        row.addEventListener("click", () => selectFile(file));
        filePicker.appendChild(row);
      });
      filePicker.hidden = false;
      filePicker.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
    }

    function selectFile(file) {
      if (!selectedFiles.some((selected) => selected.path === file.path)) {
        selectedFiles.push(file);
      }
      if (mentionRange) {
        prompt.value = prompt.value.slice(0, mentionRange.start) + prompt.value.slice(mentionRange.end);
        prompt.selectionStart = prompt.selectionEnd = mentionRange.start;
      }
      renderMentionChips();
      closeFilePicker();
      autoGrow();
      prompt.focus();
    }

    function removeSelectedFile(filePath) {
      selectedFiles = selectedFiles.filter((file) => file.path !== filePath);
      renderMentionChips();
      prompt.focus();
    }

    function renderMentionChips() {
      mentionRow.innerHTML = "";
      mentionRow.hidden = selectedFiles.length === 0;
      for (const file of selectedFiles) {
        const chip = document.createElement("span");
        chip.className = "mention-chip";
        chip.title = file.path;

        const label = document.createElement("span");
        label.className = "mention-chip-label";
        label.textContent = "@" + file.path;
        const remove = document.createElement("button");
        remove.className = "mention-remove";
        remove.type = "button";
        remove.textContent = "×";
        remove.title = i18n.removeReference;
        remove.addEventListener("click", () => removeSelectedFile(file.path));
        chip.append(label, remove);
        mentionRow.appendChild(chip);
      }
    }

    function addTransferValue(references, value) {
      if (!value) return;
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (typeof entry === "string") references.push(entry);
          }
          return;
        }
      } catch {
        // URI lists and absolute paths are commonly plain text rather than JSON.
      }
      for (const entry of value.split(/\\r?\\n/)) {
        const trimmed = entry.trim();
        if (trimmed && !trimmed.startsWith("#")) references.push(trimmed);
      }
    }

    function isUriTransferType(type) {
      const lower = String(type || "").toLowerCase();
      return lower.includes("uri-list")
        || lower === "codefiles"
        || lower === "resourceurls"
        || lower.includes("code.uri");
    }

    function isFileDrag(transfer) {
      if (!transfer) return false;
      const types = Array.from(transfer.types || []).map((type) => String(type).toLowerCase());
      return (transfer.files?.length || 0) > 0
        || Array.from(transfer.items || []).some((item) => item.kind === "file")
        || types.includes("files")
        || types.some(isUriTransferType);
    }

    function transferredFiles(transfer) {
      const files = [];
      const seen = new Set();
      const addFile = (file) => {
        if (!file) return;
        const key = [file.name, file.type, file.size, file.lastModified].join("\\n");
        if (seen.has(key)) return;
        seen.add(key);
        files.push(file);
      };
      for (const file of Array.from(transfer?.files || [])) addFile(file);
      for (const item of Array.from(transfer?.items || [])) {
        if (item.kind === "file") addFile(item.getAsFile());
      }
      return files;
    }

    function transferFileReferences(transfer, includePlainText) {
      const references = [];
      if (!transfer) return references;

      for (const file of transferredFiles(transfer)) {
        const filePath = file.path || file.webkitRelativePath;
        if (filePath) references.push(filePath);
      }

      const types = Array.from(transfer.types || []);
      const tried = new Set();
      for (const type of types) {
        if (!isUriTransferType(type)) continue;
        addTransferValue(references, transfer.getData(type));
        tried.add(type.toLowerCase());
      }

      // Some hosts omit MIME types from \`types\` even when getData still works on drop.
      for (const type of [
        "text/uri-list",
        "application/vnd.code.uri-list",
        "CodeFiles",
        "ResourceURLs",
        "codefiles",
        "resourceurls",
      ]) {
        if (tried.has(type.toLowerCase())) continue;
        try {
          const data = transfer.getData(type);
          if (data) addTransferValue(references, data);
        } catch {
          // Unsupported MIME types throw in some webview hosts.
        }
      }

      if (includePlainText && references.length === 0) {
        const plain = transfer.getData("text/plain").trim();
        if (
          plain.toLowerCase().startsWith("file:")
          || /^[a-zA-Z]:[\\\\/]/.test(plain)
          || /[\\\\/]/.test(plain)
        ) {
          addTransferValue(references, plain);
        }
      }
      return [...new Set(references)];
    }

    function fallbackFileName(file, index) {
      const original = String(file.name || "").trim();
      if (original) return original;
      const extension = {
        "image/avif": "avif",
        "image/bmp": "bmp",
        "image/gif": "gif",
        "image/heic": "heic",
        "image/heif": "heif",
        "image/jfif": "jfif",
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/svg+xml": "svg",
        "image/tiff": "tiff",
        "image/webp": "webp",
        "image/x-icon": "ico",
      }[String(file.type || "").toLowerCase()] || "bin";
      return "clipboard-image-" + String(index + 1) + "." + extension;
    }

    async function transferFileUploads(transfer) {
      const uploads = [];
      const files = transferredFiles(transfer).slice(0, 20);
      for (const [index, file] of files.entries()) {
        if (file.path || file.webkitRelativePath) continue;
        if (file.size > ${MAX_DROPPED_FILE_BYTES}) continue;
        try {
          uploads.push({
            name: fallbackFileName(file, index),
            data: new Uint8Array(await file.arrayBuffer()),
          });
        } catch {
          // The host may expose metadata without allowing the file contents to be read.
        }
      }
      return uploads;
    }

    function setDragActive(active) {
      composerCard.classList.toggle("drag-active", active);
    }

    async function resolveTransferredFiles(transfer, includePlainText, failureText) {
      const references = transferFileReferences(transfer, includePlainText);
      const uploads = references.length === 0
        ? await transferFileUploads(transfer)
        : [];
      if (references.length === 0 && uploads.length === 0) {
        status.textContent = failureText;
        return;
      }
      attachmentRequestId += 1;
      vscode.postMessage({
        type: "resolveAttachments",
        requestId: attachmentRequestId,
        references,
        uploads,
      });
    }

    function isNearBottom() {
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 48;
    }

    function scrollToBottom(force = false) {
      if (!force && !followOutput) return;
      followOutput = true;
      scroller.scrollTop = scroller.scrollHeight;
    }

    function indexedFileReference(raw) {
      const location = /(:\\d+(?::\\d+)?)$/.exec(raw);
      const suffix = location ? location[1] : "";
      let filePart = suffix ? raw.slice(0, -suffix.length) : raw;

      while (filePart) {
        const normalized = filePart.replaceAll("\\\\", "/").replace(/^\\.\\//, "");
        const lower = normalized.toLowerCase();
        const hasDirectory = normalized.includes("/");
        if (workspacePaths.has(lower) || (!hasDirectory && workspaceBasenames.has(lower))) {
          return {
            display: filePart + suffix,
            reference: normalized + suffix,
          };
        }
        if (!filePart.endsWith(".")) break;
        filePart = filePart.slice(0, -1);
      }
      return undefined;
    }

    function linkifyWorkspaceFiles(root) {
      if (workspacePaths.size === 0) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) {
        const parent = walker.currentNode.parentElement;
        if (!parent || parent.closest("a, pre, button, .files, .user-attachments, .copy-btn")) continue;
        textNodes.push(walker.currentNode);
      }

      const fileToken = /[\\p{L}\\p{N}_.@+\\\\/-]+(?::\\d+(?::\\d+)?)?/gu;
      for (const textNode of textNodes) {
        const text = textNode.nodeValue || "";
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let linked = false;
        fileToken.lastIndex = 0;
        for (const match of text.matchAll(fileToken)) {
          const resolved = indexedFileReference(match[0]);
          if (!resolved || match.index === undefined) continue;
          const start = match.index;
          const end = start + resolved.display.length;
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, start)));
          const link = document.createElement("a");
          link.href = "#";
          link.className = "workspace-file-link";
          link.dataset.workspaceFile = resolved.reference;
          link.title = i18n.openFile + ": " + resolved.reference;
          link.textContent = resolved.display;
          fragment.appendChild(link);
          lastIndex = end;
          linked = true;
        }
        if (linked) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
          textNode.parentNode?.replaceChild(fragment, textNode);
        }
      }
    }

    const COPY_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="7" height="8" rx="1"/><path d="M10.5 5.5V4.5a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h1"/></svg>';

    function createCopyButton(kind, label) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy-btn " + (kind === "code" ? "code-copy" : "message-copy");
      btn.dataset.copy = kind;
      btn.setAttribute("aria-label", label);
      btn.title = label;
      btn.innerHTML = COPY_SVG;
      return btn;
    }

    function messageBody(messageNode) {
      let body = messageNode.querySelector(":scope > .message-body");
      if (!body) {
        body = document.createElement("div");
        body.className = "message-body";
        const copyBtn = messageNode.querySelector(":scope > .message-copy");
        if (copyBtn) {
          copyBtn.before(body);
        } else {
          messageNode.appendChild(body);
        }
      }
      return body;
    }

    function ensureMessageCopy(messageNode) {
      if (messageNode.querySelector(":scope > .message-copy")) return;
      messageNode.appendChild(createCopyButton("message", i18n.copyMessage));
    }

    function enhanceCodeBlocks(root) {
      for (const pre of root.querySelectorAll("pre")) {
        if (pre.parentElement?.classList.contains("code-block")) continue;
        const wrap = document.createElement("div");
        wrap.className = "code-block";
        pre.replaceWith(wrap);
        wrap.append(createCopyButton("code", i18n.copyCode), pre);
      }
    }

    async function writeClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;left:-9999px;top:0";
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try {
          ok = document.execCommand("copy");
        } catch {
          ok = false;
        }
        ta.remove();
        return ok;
      }
    }

    function flashCopied(btn) {
      const prevLabel = btn.getAttribute("aria-label") || "";
      btn.classList.add("copied");
      btn.setAttribute("aria-label", i18n.copied);
      btn.title = i18n.copied;
      clearTimeout(btn._copyTimer);
      btn._copyTimer = setTimeout(() => {
        btn.classList.remove("copied");
        btn.setAttribute("aria-label", prevLabel);
        btn.title = prevLabel;
      }, 1200);
    }

    function copyTextForButton(btn) {
      if (btn.dataset.copy === "code") {
        return btn.closest(".code-block")?.querySelector("pre")?.innerText ?? "";
      }
      const message = btn.closest(".message");
      const body = message?.querySelector(":scope > .message-body");
      return body?.innerText?.trim() ?? "";
    }

    function renderMarkdown(messageNode, raw) {
      const body = messageBody(messageNode);
      body.innerHTML = DOMPurify.sanitize(marked.parse(raw));
      linkifyWorkspaceFiles(body);
      enhanceCodeBlocks(body);
      ensureMessageCopy(messageNode);
    }

    function addUserMessage(text, attachments = []) {
      const node = document.createElement("div");
      node.className = "message user";
      const body = document.createElement("div");
      body.className = "message-body";
      body.textContent = text;
      node.appendChild(body);
      linkifyWorkspaceFiles(body);
      if (attachments.length > 0) {
        const attachmentsNode = document.createElement("div");
        attachmentsNode.className = "user-attachments";
        for (const file of attachments) {
          const chip = document.createElement("button");
          chip.className = "user-attachment";
          chip.type = "button";
          chip.textContent = "@" + (file.label || file.path);
          chip.title = i18n.openFile + ": " + file.path;
          chip.addEventListener("click", () => vscode.postMessage({ type: "openFile", path: file.path }));
          attachmentsNode.appendChild(chip);
        }
        node.appendChild(attachmentsNode);
      }
      ensureMessageCopy(node);
      messages.appendChild(node);
      scrollToBottom();
      return node;
    }

    function progressSummary(state, count) {
      const label = state === "running"
        ? i18n.progressRunning
        : state === "stopped"
          ? i18n.progressStopped
          : state === "error"
            ? i18n.progressFailed
            : i18n.progressCompleted;
      return count > 0 ? label + " · " + count + " " + i18n.progressStep : label;
    }

    function setProgressRow(panel, step) {
      panel.empty?.remove();
      panel.empty = undefined;
      let row = panel.rows.get(step.id);
      if (!row) {
        const node = document.createElement("div");
        const statusNode = document.createElement("span");
        statusNode.className = "progress-status";
        const textNode = document.createElement("span");
        textNode.className = "progress-text";
        node.append(statusNode, textNode);
        panel.list.appendChild(node);
        row = { node, statusNode, textNode };
        panel.rows.set(step.id, row);
      }
      row.node.className = "progress-item " + step.status;
      row.statusNode.textContent = step.status === "completed"
        ? "✓"
        : step.status === "error" ? "!" : step.status === "stopped" ? "■" : "";
      row.textNode.textContent = step.text;
      panel.summaryText.textContent = progressSummary(panel.state, panel.rows.size);
    }

    function createProgressPanel(steps = [], state = "running") {
      const node = document.createElement("details");
      node.className = "chat-progress" + (state === "running" ? " running" : "");
      node.open = state === "running" || state === "error" || state === "stopped";
      const summary = document.createElement("summary");
      const spinner = document.createElement("span");
      spinner.className = "progress-spinner";
      spinner.setAttribute("aria-hidden", "true");
      const summaryText = document.createElement("span");
      summaryText.textContent = progressSummary(state, steps.length);
      summary.append(spinner, summaryText);
      const list = document.createElement("div");
      list.className = "progress-list";
      const panel = { node, summaryText, list, rows: new Map(), state, empty: undefined };
      node.append(summary, list);
      if (steps.length === 0) {
        const empty = document.createElement("div");
        empty.className = "progress-empty";
        empty.textContent = i18n.progressPreparing;
        list.appendChild(empty);
        panel.empty = empty;
      } else {
        for (const step of steps) setProgressRow(panel, step);
      }
      return panel;
    }

    function beginProgress() {
      if (view !== "chat" || !assistantNode) return;
      activeProgress = createProgressPanel();
      assistantNode.before(activeProgress.node);
      scrollToBottom();
    }

    function updateProgress(data) {
      if (view !== "chat") return;
      if (!activeProgress) beginProgress();
      if (!activeProgress) return;
      setProgressRow(activeProgress, {
        id: data.callId || data.text,
        text: data.text,
        status: data.status || "running",
      });
      scrollToBottom();
    }

    function finishProgress(state) {
      if (!activeProgress) return;
      activeProgress.state = state;
      activeProgress.node.classList.remove("running");
      for (const row of activeProgress.rows.values()) {
        if (row.node.classList.contains("running")) {
          row.node.className = "progress-item " + (state === "completed" ? "completed" : state);
          row.statusNode.textContent = state === "completed" ? "✓" : state === "stopped" ? "■" : "!";
        }
      }
      activeProgress.summaryText.textContent = progressSummary(state, activeProgress.rows.size);
      activeProgress.node.open = state !== "completed";
    }

    function addAssistantMessage(
      raw,
      isError = false,
      files = [],
      progress = [],
      progressState = "completed",
    ) {
      const node = document.createElement("div");
      node.className = "message assistant" + (isError ? " error" : "");
      if (raw) {
        renderMarkdown(node, raw);
      } else {
        messageBody(node);
        ensureMessageCopy(node);
      }
      if (progress.length > 0) {
        messages.appendChild(createProgressPanel(progress, progressState).node);
      }
      messages.appendChild(node);
      for (const file of files) addFileChip(node, file.path, file.label);
      scrollToBottom();
      return node;
    }

    function addFileChip(messageNode, filePath, label) {
      let filesNode = messageNode.nextElementSibling;
      if (!filesNode || !filesNode.classList.contains("files")) {
        filesNode = document.createElement("div");
        filesNode.className = "files";
        messageNode.after(filesNode);
      }
      const chip = document.createElement("button");
      chip.className = "file-chip";
      chip.type = "button";
      chip.textContent = label;
      chip.title = i18n.showDiff + ": " + filePath;
      chip.addEventListener("click", () => vscode.postMessage({ type: "openDiff", path: filePath }));
      filesNode.appendChild(chip);
    }

    function autoGrow() {
      prompt.style.height = "auto";
      prompt.style.height = Math.min(prompt.scrollHeight, 200) + "px";
    }

    function renderQueue() {
      queueRow.innerHTML = "";
      queueRow.hidden = queuedMessages.length === 0;
      if (queuedMessages.length === 0) return;

      const heading = document.createElement("div");
      heading.className = "queue-heading";
      heading.textContent = i18n.queuedMessages + " (" + queuedMessages.length + ")";
      queueRow.appendChild(heading);
      for (const item of queuedMessages) {
        const row = document.createElement("div");
        row.className = "queue-item " + (item.kind === "interrupt" ? "interrupt" : "queued");

        const kind = document.createElement("span");
        kind.className = "queue-kind";
        kind.textContent = item.kind === "interrupt" ? i18n.interruptQueued : i18n.queued;
        row.appendChild(kind);

        const text = document.createElement("span");
        text.className = "queue-text";
        text.textContent = item.prompt;
        text.title = item.prompt;
        row.appendChild(text);

        const remove = document.createElement("button");
        remove.className = "queue-remove";
        remove.type = "button";
        remove.textContent = "×";
        remove.title = i18n.removeQueued;
        remove.addEventListener("click", () => {
          vscode.postMessage({ type: "removeQueuedMessage", id: item.id });
        });
        row.appendChild(remove);
        queueRow.appendChild(row);
      }
    }

    function messagePayload(type, text, files) {
      return {
        type,
        prompt: text,
        attachContext: attach,
        files: files.map((file) => file.path),
        modelId: selectedModelId,
        modelParams: selectedModelDefinition()
          ? paramsForModel(selectedModelDefinition())
          : [],
        profile: runProfile,
        skills: selectedSkills.slice(),
      };
    }

    function clearComposerMessage() {
      prompt.value = "";
      selectedFiles = [];
      renderMentionChips();
      closeFilePicker();
      closeSlashPicker();
      autoGrow();
    }

    function ensureRunningAudioContext() {
      if (runningAudioContext) return runningAudioContext;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return undefined;
      runningAudioContext = new AudioContextClass();
      return runningAudioContext;
    }

    function primeRunningSound() {
      if (!runningSoundEnabled && !completionSoundEnabled && !errorSoundEnabled) return;
      const audio = ensureRunningAudioContext();
      if (audio?.state === "suspended") {
        void audio.resume().catch(() => {});
      }
    }

    function scheduleRunningSound(delay = 5000) {
      if (!running || !runningSoundEnabled || runningSoundTimer) return;
      runningSoundTimer = setTimeout(() => {
        runningSoundTimer = undefined;
        playRunningSound();
      }, delay);
    }

    function playRunningSound() {
      if (!running || !runningSoundEnabled) return;
      const audio = ensureRunningAudioContext();
      if (!audio) return;

      const playPulse = () => {
        if (!running || !runningSoundEnabled || audio.state !== "running") return;
        const now = audio.currentTime;
        const playTone = (frequency, start, duration, volume) => {
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          oscillator.type = "sine";
          oscillator.frequency.setValueAtTime(frequency, start);
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(volume, start + 0.16);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
          oscillator.connect(gain);
          gain.connect(audio.destination);
          oscillator.addEventListener("ended", () => {
            oscillator.disconnect();
            gain.disconnect();
          }, { once: true });
          oscillator.start(start);
          oscillator.stop(start + duration + 0.01);
        };
        playTone(261.63, now, 0.5, 0.025);
        playTone(329.63, now + 0.16, 0.65, 0.019);
      };

      if (audio.state === "suspended") {
        void audio.resume().then(playPulse).catch(() => {});
      } else {
        playPulse();
      }
      scheduleRunningSound();
    }

    function startRunningSound() {
      if (!runningSoundEnabled) return;
      primeRunningSound();
      playRunningSound();
    }

    function stopRunningSound() {
      if (runningSoundTimer) {
        clearTimeout(runningSoundTimer);
        runningSoundTimer = undefined;
      }
    }

    function playCompletionSound() {
      if (!completionSoundEnabled) return;
      const audio = ensureRunningAudioContext();
      if (!audio) return;

      const playChime = () => {
        if (!completionSoundEnabled || audio.state !== "running") return;
        const now = audio.currentTime;
        const playTone = (frequency, start, duration, volume) => {
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          oscillator.type = "sine";
          oscillator.frequency.setValueAtTime(frequency, start);
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(volume, start + 0.03);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
          oscillator.connect(gain);
          gain.connect(audio.destination);
          oscillator.addEventListener("ended", () => {
            oscillator.disconnect();
            gain.disconnect();
          }, { once: true });
          oscillator.start(start);
          oscillator.stop(start + duration + 0.01);
        };
        playTone(392, now, 0.3, 0.025);
        playTone(523.25, now + 0.14, 0.34, 0.022);
        playTone(659.25, now + 0.3, 0.4, 0.019);
      };

      if (audio.state === "suspended") {
        void audio.resume().then(playChime).catch(() => {});
      } else {
        playChime();
      }
    }

    function playErrorSound() {
      if (!errorSoundEnabled) return;
      const audio = ensureRunningAudioContext();
      if (!audio) return;

      const playAlert = () => {
        if (!errorSoundEnabled || audio.state !== "running") return;
        const now = audio.currentTime;
        const playTone = (frequency, start, duration, volume) => {
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          oscillator.type = "sine";
          oscillator.frequency.setValueAtTime(frequency, start);
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
          oscillator.connect(gain);
          gain.connect(audio.destination);
          oscillator.addEventListener("ended", () => {
            oscillator.disconnect();
            gain.disconnect();
          }, { once: true });
          oscillator.start(start);
          oscillator.stop(start + duration + 0.01);
        };
        playTone(415.3, now, 0.28, 0.028);
        playTone(311.13, now + 0.16, 0.3, 0.026);
        playTone(233.08, now + 0.34, 0.42, 0.024);
      };

      if (audio.state === "suspended") {
        void audio.resume().then(playAlert).catch(() => {});
      } else {
        playAlert();
      }
    }

    document.addEventListener("pointerdown", primeRunningSound, { once: true });
    document.addEventListener("keydown", primeRunningSound, { once: true });
    scroller.addEventListener("scroll", () => {
      followOutput = isNearBottom();
    }, { passive: true });

    function submitMessage(action = "send") {
      const consumed = consumeLeadingSlashCommand(prompt.value.trim());
      if (consumed.profile) {
        runProfile = consumed.profile;
        updateProfileChip();
      }
      const text = consumed.text;
      if (!text) {
        if (consumed.profile) {
          prompt.value = "";
          closeSlashPicker();
          autoGrow();
        }
        return;
      }
      const files = selectedFiles.slice();

      if (running) {
        const type = action === "interrupt" ? "interruptMessage" : "queueMessage";
        clearComposerMessage();
        vscode.postMessage(messagePayload(type, text, files));
        prompt.focus();
        return;
      }

      showChat();
      followOutput = true;
      addUserMessage(text, files);
      assistantRaw = "";
      assistantNode = addAssistantMessage("");
      clearComposerMessage();
      primeRunningSound();
      vscode.postMessage(messagePayload("send", text, files));
    }

    sendButton.addEventListener("click", () => {
      if (running) {
        vscode.postMessage({ type: "cancel" });
      } else {
        submitMessage();
      }
    });
    queueButton.addEventListener("click", () => submitMessage("queue"));
    interruptButton.addEventListener("click", () => submitMessage("interrupt"));
    newChatButton.addEventListener("click", () => vscode.postMessage({ type: "newChat" }));
    historyButton.addEventListener("click", () => vscode.postMessage({ type: "showHome" }));
    viewAll.addEventListener("click", () => {
      tasksExpanded = true;
      renderTasks();
    });
    attachButton.addEventListener("click", () => {
      if (addMenu.hidden) {
        openAddMenu();
      } else {
        closeAddMenu();
      }
    });
    profileChip.addEventListener("click", openAddMenu);
    ctxRemove.addEventListener("click", () => setAttach(false));
    approvalSelect.addEventListener("change", () => {
      setApprovalMode(approvalSelect.value);
      vscode.postMessage({ type: "selectApprovalMode", approvalMode: approvalSelect.value });
    });
    modelButton.addEventListener("click", () => {
      if (modelPicker.hidden) {
        openModelPicker();
      } else {
        closeModelPicker();
      }
    });
    modelSearch.addEventListener("input", renderModelList);
    window.addEventListener("resize", positionModelPicker);
    window.addEventListener("blur", () => {
      closeModelPicker();
      closeAddMenu();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        closeModelPicker();
        closeAddMenu();
      }
    });
    document.addEventListener("pointerdown", (event) => {
      if (!modelPicker.hidden && !document.querySelector(".model-control").contains(event.target)) {
        closeModelPicker();
      }
      if (!addMenu.hidden && !document.querySelector(".add-control").contains(event.target)) {
        closeAddMenu();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !modelPicker.hidden) {
        event.preventDefault();
        closeModelPicker();
        modelButton.focus();
      } else if (event.key === "Escape" && !addMenu.hidden) {
        event.preventDefault();
        closeAddMenu();
        attachButton.focus();
      }
    });
    document.getElementById("keyButton").addEventListener("click", () => vscode.postMessage({ type: "setApiKey" }));
    authChip.addEventListener("click", () => vscode.postMessage({ type: "setApiKey" }));
    document.getElementById("connectButton").addEventListener("click", () => vscode.postMessage({ type: "setApiKey" }));
    document.getElementById("dashboardButton").addEventListener("click", () => vscode.postMessage({ type: "openDashboard" }));
    messages.addEventListener("click", (event) => {
      const el = event.target instanceof Element ? event.target : null;
      const copyBtn = el?.closest("[data-copy]");
      if (copyBtn instanceof HTMLButtonElement) {
        event.preventDefault();
        const text = copyTextForButton(copyBtn);
        if (!text) return;
        void writeClipboard(text).then((ok) => {
          if (ok) flashCopied(copyBtn);
        });
        return;
      }

      const target = el?.closest("[data-workspace-file]");
      if (!(target instanceof HTMLElement) || !target.dataset.workspaceFile) return;
      event.preventDefault();
      vscode.postMessage({ type: "openReferencedFile", path: target.dataset.workspaceFile });
    });
    // VS Code disables webview pointer events during resource drags unless Shift is held.
    // Listen on document so the whole view accepts drops once Shift re-enables the webview.
    document.addEventListener("dragenter", (event) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      setDragActive(true);
    });
    document.addEventListener("dragover", (event) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDragActive(true);
    });
    document.addEventListener("dragleave", (event) => {
      const related = event.relatedTarget;
      if (related instanceof Node && document.documentElement.contains(related)) return;
      setDragActive(false);
    });
    document.addEventListener("drop", (event) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      setDragActive(false);
      void resolveTransferredFiles(event.dataTransfer, true, i18n.dropFailed);
    });
    window.addEventListener("dragend", () => setDragActive(false));
    window.addEventListener("blur", () => setDragActive(false));
    prompt.addEventListener("paste", (event) => {
      // Voice tools like Typeless paste polished text. Prefer that over file-drag
      // heuristics, which can otherwise swallow the paste when clipboard also
      // advertises file/URI payloads.
      const plain = event.clipboardData?.getData("text/plain") ?? "";
      if (plain.length > 0) return;
      if (!isFileDrag(event.clipboardData)) return;
      event.preventDefault();
      void resolveTransferredFiles(event.clipboardData, false, i18n.pasteFailed);
    });
    prompt.addEventListener("input", () => {
      autoGrow();
      updateComposerSuggestions();
    });
    prompt.addEventListener("compositionend", () => {
      autoGrow();
      updateComposerSuggestions();
    });
    prompt.addEventListener("click", updateComposerSuggestions);
    prompt.addEventListener("keydown", (event) => {
      // Dictation / IME confirmation uses Enter and keyCode 229; never treat as send.
      if (event.isComposing || event.keyCode === 229) return;
      if (!filePicker.hidden) {
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && fileResults.length > 0) {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          selectedFileIndex = (selectedFileIndex + direction + fileResults.length) % fileResults.length;
          renderFileResults();
          return;
        }
        if ((event.key === "Enter" || event.key === "Tab") && fileResults.length > 0) {
          event.preventDefault();
          selectFile(fileResults[selectedFileIndex]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeFilePicker();
          return;
        }
      }
      if (!slashPicker.hidden) {
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && slashResults.length > 0) {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          selectedSlashIndex = (selectedSlashIndex + direction + slashResults.length) % slashResults.length;
          renderSlashResults();
          return;
        }
        if ((event.key === "Enter" || event.key === "Tab") && slashResults.length > 0) {
          event.preventDefault();
          selectSlashCommand(slashResults[selectedSlashIndex]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeSlashPicker();
          return;
        }
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (running && event.ctrlKey) {
          submitMessage("interrupt");
        } else if (running) {
          submitMessage("queue");
        } else {
          submitMessage();
        }
      }
    });

    window.addEventListener("message", ({ data }) => {
      switch (data.type) {
        case "authState":
          auth.style.display = data.configured ? "none" : "block";
          authChip.style.display = data.configured ? "none" : "inline-flex";
          status.textContent = data.configured ? i18n.connected : i18n.apiKeyMissing;
          break;
        case "authRequired":
          auth.style.display = "block";
          authChip.style.display = "inline-flex";
          break;
        case "runningSoundSetting":
          runningSoundEnabled = data.enabled === true;
          if (runningSoundEnabled && running) {
            startRunningSound();
          } else {
            stopRunningSound();
          }
          break;
        case "completionSoundSetting":
          completionSoundEnabled = data.enabled === true;
          break;
        case "errorSoundSetting":
          errorSoundEnabled = data.enabled === true;
          break;
        case "workspace":
          if (data.name) workspaceLabel.textContent = data.name + " " + i18n.runningIn;
          break;
        case "workspaceFileIndex":
          workspacePaths = new Set((data.files || []).map((file) => file.toLowerCase()));
          workspaceBasenames = new Set(
            (data.files || []).map((file) => file.split(/[\\\\/]/).pop().toLowerCase()),
          );
          linkifyWorkspaceFiles(messages);
          break;
        case "contextInfo":
          if (attach) updateContextChip(data.label);
          break;
        case "fileResults":
          if (data.requestId !== fileRequestId || !activeMention()) break;
          fileResults = (data.files || []).filter(
            (file) => !selectedFiles.some((selected) => selected.path === file.path),
          );
          renderFileResults();
          break;
        case "resolvedAttachments":
          for (const file of data.files || []) {
            if (!selectedFiles.some((selected) => selected.path === file.path)) {
              selectedFiles.push(file);
            }
          }
          renderMentionChips();
          prompt.focus();
          break;
        case "integrations":
          availableSkills = data.skills || [];
          availableMcpServers = data.mcpServers || [];
          selectedSkills = selectedSkills.filter((name) =>
            availableSkills.some((skill) => skill.name === name));
          updateProfileChip();
          if (!addMenu.hidden) renderMainAddMenu();
          break;
        case "models": {
          availableModels = data.models || [];
          modelParamState = data.savedParams || {};
          selectedModelId = data.selected || "auto";
          const selected = selectedModelDefinition();
          if (selected) paramsForModel(selected);
          updateModelButton();
          renderModelList();
          renderModelOptions();
          break;
        }
        case "modelSelected":
          selectedModelId = data.id || "auto";
          updateModelButton();
          break;
        case "approvalModeSelected":
          setApprovalMode(data.mode);
          break;
        case "sandboxUnavailable":
          sandboxUnavailable = true;
          status.textContent = i18n.sandboxUnavailable;
          break;
        case "home":
          showHome(data.conversations);
          break;
        case "newChat":
          clearMessages();
          showChat();
          prompt.focus();
          break;
        case "chat": {
          clearMessages();
          showChat();
          for (const entry of data.entries) {
            if (entry.role === "user") {
              const attachments = (entry.attachments || []).map((attachment) => {
                if (typeof attachment === "string") {
                  return {
                    path: attachment,
                    label: attachment.split(/[\\\\/]/).pop() || attachment,
                  };
                }
                return {
                  path: attachment.path,
                  label: attachment.label || attachment.path.split(/[\\\\/]/).pop() || attachment.path,
                };
              });
              addUserMessage(entry.text, attachments);
            } else {
              const files = (entry.files || []).map((p) => ({ path: p, label: p.split(/[\\\\/]/).pop() || p }));
              addAssistantMessage(
                entry.text,
                entry.error === true,
                files,
                entry.progress || [],
                entry.progressState || (entry.error === true ? "error" : "completed"),
              );
            }
          }
          break;
        }
        case "queueState":
          queuedMessages = data.items || [];
          renderQueue();
          break;
        case "queuedStarted": {
          showChat();
          const attachments = (data.files || []).map((file) => ({
            path: file,
            label: file.split(/[\\/]/).pop() || file,
          }));
          addUserMessage(data.prompt, attachments);
          assistantRaw = "";
          assistantNode = addAssistantMessage("");
          break;
        }
        case "started":
          running = true;
          startRunningSound();
          runningIndicator.hidden = false;
          sendButton.classList.add("running");
          sendButton.title = i18n.stop;
          runningActions.hidden = false;
          status.textContent = i18n.running + "…";
          beginProgress();
          break;
        case "toolStatus":
          status.textContent = i18n.running + ": " + data.text;
          updateProgress(data);
          break;
        case "contextAttached": {
          const nodes = messages.querySelectorAll(".user");
          const lastUser = nodes[nodes.length - 1];
          if (lastUser) {
            const note = document.createElement("div");
            note.className = "context-note";
            note.textContent = i18n.attached + ": " + data.label;
            lastUser.appendChild(note);
          }
          break;
        }
        case "chunk":
          if (view !== "chat") break;
          if (!assistantNode) assistantNode = addAssistantMessage("");
          assistantRaw += data.text;
          renderMarkdown(assistantNode, assistantRaw);
          scrollToBottom();
          break;
        case "fileEdited":
          if (view !== "chat") break;
          if (!assistantNode) assistantNode = addAssistantMessage("");
          addFileChip(assistantNode, data.path, data.label);
          break;
        case "error":
          finishProgress("error");
          stopRunningSound();
          playErrorSound();
          if (assistantNode && !assistantRaw) {
            messageBody(assistantNode).textContent = data.text;
            assistantNode.classList.add("error");
            ensureMessageCopy(assistantNode);
          } else {
            addAssistantMessage(data.text, true);
          }
          break;
        case "cancelled":
          finishProgress("stopped");
          if (assistantNode && !assistantRaw) {
            messageBody(assistantNode).textContent = i18n.stopped;
            ensureMessageCopy(assistantNode);
          }
          break;
        case "finished":
          finishProgress("completed");
          stopRunningSound();
          playCompletionSound();
          break;
        case "idle":
          running = false;
          stopRunningSound();
          runningIndicator.hidden = true;
          sendButton.classList.remove("running");
          sendButton.title = i18n.send;
          runningActions.hidden = true;
          status.textContent = sandboxUnavailable ? i18n.sandboxUnavailable : i18n.connected;
          assistantNode = undefined;
          assistantRaw = "";
          activeProgress = undefined;
          prompt.focus();
          break;
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

function extractFilePaths(args: unknown): string[] {
  if (!args || typeof args !== "object") {
    return [];
  }

  const record = args as Record<string, unknown>;
  const keys = [
    "path",
    "file_path",
    "filePath",
    "target_file",
    "targetFile",
    "absolute_path",
    "absolutePath",
  ];

  const paths: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      paths.push(value);
    }
  }
  return paths;
}
