/** Shared, runtime-validated extension-host/webview message contract. */

export interface ModelParameterSelection {
  id?: unknown;
  value?: unknown;
}

export interface DroppedFileUpload {
  name?: unknown;
  data?: unknown;
}

export type RecoveryActionId = "retry" | "diagnostics" | "runCenter" | "logs";

interface ComposerPayload {
  prompt: string;
  attachContext?: boolean;
  files?: string[];
  modelId?: string;
  modelParams?: ModelParameterSelection[];
  profile?: string;
  skills?: string[];
  commandId?: string;
  includeProjectMemory?: boolean;
}

type MessageOf<TType extends string, TPayload extends object = object> = TType extends unknown
  ? { type: TType } & TPayload
  : never;

type EmptyWebviewMessageType =
  | "cancel"
  | "clearApiKey"
  | "dismissSetupChecklist"
  | "getContext"
  | "newChat"
  | "openDashboard"
  | "openMcpSettings"
  | "openSettings"
  | "openSkillsFolder"
  | "pickWorkspaceFolder"
  | "ready"
  | "sandboxLearnMore"
  | "setApiKey"
  | "showHome"
  | "showSetupChecklist";

type ComposerMessageType =
  "interruptMessage" | "queueMessage" | "send" | "startBestOfN" | "startOrchestrate";

type ConversationIdMessageType =
  | "cancelConversation"
  | "compareBestOfN"
  | "deleteConversation"
  | "openConversation"
  | "openOrchestrator"
  | "pickBestOfNWinner"
  | "removeQueuedMessage";

type FilePathMessageType = "openDiff" | "openFile" | "openReferencedFile";

export type WebviewToHostMessage =
  | MessageOf<EmptyWebviewMessageType>
  | MessageOf<ComposerMessageType, ComposerPayload>
  | ({ type: "estimateContext"; path?: string } & ComposerPayload)
  | { type: "promptDictationHotkey"; occurredAt: number }
  | MessageOf<ConversationIdMessageType, { id: string }>
  | { type: "pinConversation"; id: string; pinned?: boolean }
  | { type: "exportConversation"; id: string; format?: "markdown" | "json" }
  | { type: "launchQueuedParallel"; ids: string[]; id?: string }
  | { type: "pickImages"; requestId: number }
  | { type: "searchFiles"; query: string; requestId: number }
  | {
      type: "resolveAttachments";
      requestId: number;
      references: string[];
      uploads: DroppedFileUpload[];
    }
  | { type: "searchConversations"; query: string }
  | { type: "selectModel"; modelId: string; modelParams?: ModelParameterSelection[] }
  | MessageOf<FilePathMessageType, { path: string }>
  | { type: "openExternal"; path: string }
  | { type: "selectApprovalMode"; approvalMode: string }
  | {
      type: "setAlertSetting";
      setting:
        "notifyOnComplete" | "playSoundWhileRunning" | "playSoundOnComplete" | "playSoundOnError";
      enabled: boolean;
    }
  | { type: "confirmSetupChecklistStep"; id: "permissions" | "gh" }
  | {
      type: "setupChecklistAction";
      id:
        | "apiKey"
        | "gitWorkspace"
        | "permissions"
        | "gh"
        | "openGhSettings"
        | "openDashboard"
        | "workspaceTrust";
    }
  | { type: "runRecoveryAction"; action: RecoveryActionId };

export const WEBVIEW_TO_HOST_MESSAGE_TYPES = [
  "cancel",
  "cancelConversation",
  "clearApiKey",
  "compareBestOfN",
  "confirmSetupChecklistStep",
  "deleteConversation",
  "dismissSetupChecklist",
  "estimateContext",
  "exportConversation",
  "getContext",
  "interruptMessage",
  "launchQueuedParallel",
  "newChat",
  "openConversation",
  "openDashboard",
  "openDiff",
  "openExternal",
  "openFile",
  "openMcpSettings",
  "openOrchestrator",
  "openReferencedFile",
  "openSettings",
  "openSkillsFolder",
  "pickBestOfNWinner",
  "pickImages",
  "pickWorkspaceFolder",
  "pinConversation",
  "promptDictationHotkey",
  "queueMessage",
  "ready",
  "removeQueuedMessage",
  "resolveAttachments",
  "runRecoveryAction",
  "sandboxLearnMore",
  "searchConversations",
  "searchFiles",
  "selectApprovalMode",
  "selectModel",
  "send",
  "setAlertSetting",
  "setApiKey",
  "setupChecklistAction",
  "showHome",
  "showSetupChecklist",
  "startBestOfN",
  "startOrchestrate",
] as const satisfies readonly WebviewToHostMessage["type"][];

export type WebviewToHostMessageType = WebviewToHostMessage["type"];
export type WebviewIncomingType = WebviewToHostMessageType;
export type ParsedWebviewMessage = WebviewToHostMessage;
export type WebviewMessageHandler = (message: WebviewToHostMessage) => unknown;

const WEBVIEW_TO_HOST_MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(
  WEBVIEW_TO_HOST_MESSAGE_TYPES,
);
const SETUP_CHECKLIST_CONFIRM_IDS = new Set(["permissions", "gh"]);
const SETUP_CHECKLIST_ACTION_IDS = new Set([
  "apiKey",
  "gitWorkspace",
  "permissions",
  "gh",
  "openGhSettings",
  "openDashboard",
  "workspaceTrust",
]);
const ALERT_SETTINGS = new Set([
  "notifyOnComplete",
  "playSoundWhileRunning",
  "playSoundOnComplete",
  "playSoundOnError",
]);
const RECOVERY_ACTION_IDS: ReadonlySet<string> = new Set([
  "retry",
  "diagnostics",
  "runCenter",
  "logs",
]);

function asRecoveryActionIds(value: unknown): readonly RecoveryActionId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item): item is RecoveryActionId =>
    typeof item === "string" && RECOVERY_ACTION_IDS.has(item)
  )) {
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseComposerPayload(message: Record<string, unknown>): ComposerPayload | undefined {
  if (typeof message.prompt !== "string") return undefined;
  const files = message.files === undefined ? undefined : asStringArray(message.files);
  const skills = message.skills === undefined ? undefined : asStringArray(message.skills);
  if (message.files !== undefined && !files) return undefined;
  if (message.skills !== undefined && !skills) return undefined;
  if (message.modelParams !== undefined && !Array.isArray(message.modelParams)) return undefined;
  return {
    prompt: message.prompt,
    attachContext: message.attachContext === true,
    files,
    modelId: typeof message.modelId === "string" ? message.modelId : undefined,
    modelParams: Array.isArray(message.modelParams)
      ? (message.modelParams as ModelParameterSelection[])
      : undefined,
    profile: typeof message.profile === "string" ? message.profile : undefined,
    skills,
    commandId: typeof message.commandId === "string" ? message.commandId : undefined,
    includeProjectMemory: message.includeProjectMemory !== false,
  };
}

/** Validate and normalize an untrusted webview postMessage payload. */
export function parseWebviewMessage(raw: unknown): WebviewToHostMessage | undefined {
  if (!isRecord(raw) || typeof raw.type !== "string") return undefined;
  if (!WEBVIEW_TO_HOST_MESSAGE_TYPE_SET.has(raw.type)) return undefined;
  const type = raw.type as WebviewToHostMessageType;

  if (
    type === "cancel" ||
    type === "clearApiKey" ||
    type === "dismissSetupChecklist" ||
    type === "getContext" ||
    type === "newChat" ||
    type === "openDashboard" ||
    type === "openMcpSettings" ||
    type === "openSettings" ||
    type === "openSkillsFolder" ||
    type === "pickWorkspaceFolder" ||
    type === "ready" ||
    type === "sandboxLearnMore" ||
    type === "setApiKey" ||
    type === "showHome" ||
    type === "showSetupChecklist"
  ) {
    return { type };
  }

  if (
    type === "send" ||
    type === "queueMessage" ||
    type === "interruptMessage" ||
    type === "startBestOfN" ||
    type === "startOrchestrate" ||
    type === "estimateContext"
  ) {
    const payload = parseComposerPayload(raw);
    if (!payload) return undefined;
    return type === "estimateContext"
      ? { type, ...payload, path: typeof raw.path === "string" ? raw.path : undefined }
      : { type, ...payload };
  }

  if (type === "promptDictationHotkey") {
    const occurredAt = asFiniteNumber(raw.occurredAt);
    return occurredAt === undefined ? undefined : { type, occurredAt };
  }

  if (
    type === "removeQueuedMessage" ||
    type === "cancelConversation" ||
    type === "openConversation" ||
    type === "deleteConversation" ||
    type === "pickBestOfNWinner" ||
    type === "compareBestOfN" ||
    type === "openOrchestrator"
  ) {
    return typeof raw.id === "string" ? { type, id: raw.id } : undefined;
  }

  if (type === "pinConversation") {
    return typeof raw.id === "string"
      ? { type, id: raw.id, pinned: typeof raw.pinned === "boolean" ? raw.pinned : undefined }
      : undefined;
  }
  if (type === "exportConversation") {
    if (typeof raw.id !== "string") return undefined;
    const format =
      raw.format === "json" ? "json" : raw.format === "markdown" ? "markdown" : undefined;
    return { type, id: raw.id, format };
  }
  if (type === "launchQueuedParallel") {
    const ids = asStringArray(raw.ids)?.filter((id) => id.length > 0) ?? [];
    const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : undefined;
    if (ids.length === 0 && !id) return undefined;
    return { type, ids: ids.length > 0 ? ids : [id!], id };
  }
  if (type === "pickImages") {
    const requestId = asFiniteNumber(raw.requestId);
    return requestId === undefined ? undefined : { type, requestId };
  }
  if (type === "searchFiles") {
    const requestId = asFiniteNumber(raw.requestId);
    return typeof raw.query === "string" && requestId !== undefined
      ? { type, query: raw.query, requestId }
      : undefined;
  }
  if (type === "resolveAttachments") {
    const requestId = asFiniteNumber(raw.requestId);
    const references = asStringArray(raw.references);
    if (requestId === undefined || !references || !Array.isArray(raw.uploads)) return undefined;
    return {
      type,
      requestId,
      references,
      uploads: raw.uploads as DroppedFileUpload[],
    };
  }
  if (type === "searchConversations") {
    return typeof raw.query === "string" ? { type, query: raw.query } : undefined;
  }
  if (type === "selectModel") {
    if (typeof raw.modelId !== "string") return undefined;
    if (raw.modelParams !== undefined && !Array.isArray(raw.modelParams)) return undefined;
    return {
      type,
      modelId: raw.modelId,
      modelParams: Array.isArray(raw.modelParams)
        ? (raw.modelParams as ModelParameterSelection[])
        : undefined,
    };
  }
  if (type === "openFile" || type === "openReferencedFile" || type === "openDiff") {
    return typeof raw.path === "string" ? { type, path: raw.path } : undefined;
  }
  if (type === "openExternal") {
    return typeof raw.path === "string" ? { type, path: raw.path } : undefined;
  }
  if (type === "selectApprovalMode") {
    return typeof raw.approvalMode === "string"
      ? { type, approvalMode: raw.approvalMode }
      : undefined;
  }
  if (type === "setAlertSetting") {
    return typeof raw.setting === "string" &&
      ALERT_SETTINGS.has(raw.setting) &&
      typeof raw.enabled === "boolean"
      ? {
          type,
          setting: raw.setting as Extract<
            WebviewToHostMessage,
            { type: "setAlertSetting" }
          >["setting"],
          enabled: raw.enabled,
        }
      : undefined;
  }
  if (type === "confirmSetupChecklistStep") {
    return typeof raw.id === "string" && SETUP_CHECKLIST_CONFIRM_IDS.has(raw.id)
      ? {
          type,
          id: raw.id as Extract<WebviewToHostMessage, { type: "confirmSetupChecklistStep" }>["id"],
        }
      : undefined;
  }
  if (type === "setupChecklistAction") {
    return typeof raw.id === "string" && SETUP_CHECKLIST_ACTION_IDS.has(raw.id)
      ? {
          type,
          id: raw.id as Extract<WebviewToHostMessage, { type: "setupChecklistAction" }>["id"],
        }
      : undefined;
  }
  if (type === "runRecoveryAction") {
    return typeof raw.action === "string" && RECOVERY_ACTION_IDS.has(raw.action)
      ? { type, action: raw.action as RecoveryActionId }
      : undefined;
  }
  return undefined;
}

export function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  return parseWebviewMessage(value) !== undefined;
}

type HostNoPayloadMessageType =
  | "authRequired"
  | "cancelled"
  | "finished"
  | "focusApprovalModeMenu"
  | "hostWindowFocused"
  | "newChat"
  | "openFind"
  | "sandboxUnavailable";

export type HostToWebviewMessage =
  | MessageOf<HostNoPayloadMessageType>
  | { type: "approvalModeSelected"; mode: string }
  | { type: "authState"; configured: boolean }
  | { type: "bestOfNCompare"; experiment: unknown }
  | { type: "bestOfNExperiments"; experiments: unknown[] }
  | { type: "chat"; entries: unknown[]; running: boolean }
  | { type: "chunk"; text: string }
  | { type: "completionSoundSetting"; enabled: boolean }
  | { type: "contextAttached"; label: string }
  | { type: "contextInfo"; label: string | null }
  | { type: "contextPreview"; chips: unknown[] }
  | { type: "error"; text: string; recoveryActions?: readonly RecoveryActionId[] }
  | { type: "errorSoundSetting"; enabled: boolean }
  | { type: "fileEdited"; path: string; label: string }
  | { type: "fileResults"; requestId: number; files: unknown[] }
  | { type: "home"; conversations: unknown[]; searchQuery: string }
  | { type: "integrations"; skills: unknown[]; mcpServers: string[]; commands: unknown[] }
  | { type: "idle"; activeRuns?: number }
  | { type: "models"; models: unknown[]; selected: string; savedParams: unknown }
  | { type: "modelSelected"; id: string }
  | {
      type: "notificationAndSoundSettings";
      notification: boolean;
      running: boolean;
      completion: boolean;
      error: boolean;
      webviewPlayback: boolean;
    }
  | {
      type: "orchestratorActivity";
      experimentId: string;
      conversationId: string;
      role: string;
      subtaskId?: string;
      activity: unknown;
    }
  | { type: "orchestratorDetail"; experiment: unknown }
  | { type: "orchestratorExperiments"; experiments: unknown[] }
  | {
      type: "parallelState";
      activeRuns: number;
      maximumRuns: number;
      activeConversationId?: string;
      tasks: unknown[];
    }
  | { type: "queuedStarted"; prompt: string; files: string[]; kind?: string }
  | { type: "queueState"; items: unknown[] }
  | { type: "resolvedAttachments"; requestId: number; files: unknown[] }
  | { type: "runningSoundSetting"; enabled: boolean }
  | { type: "sandboxSupport"; supported: boolean }
  | {
      type: "setupChecklistState";
      visible: boolean;
      dismissed: boolean;
      sandboxSupported: boolean;
      approvalMode: string;
      steps: unknown;
    }
  | {
      type: "executionProfileState";
      profileId: string;
      label: string;
    }
  | { type: "started"; activeRuns?: number }
  | { type: "toolStatus"; callId: string; text: string; status?: string }
  | {
      type: "usageStats";
      summary: unknown;
      budget?: unknown;
      monthlyBudget?: unknown;
      estimatedCost?: unknown;
      inlineCompletion: unknown;
    }
  | { type: "workspace"; name?: string; selectable: boolean; path?: string }
  | { type: "workspaceFileIndex"; files: string[] };

export const HOST_TO_WEBVIEW_MESSAGE_TYPES = [
  "approvalModeSelected",
  "authRequired",
  "authState",
  "bestOfNCompare",
  "bestOfNExperiments",
  "cancelled",
  "chat",
  "chunk",
  "completionSoundSetting",
  "contextAttached",
  "contextInfo",
  "contextPreview",
  "error",
  "errorSoundSetting",
  "executionProfileState",
  "fileEdited",
  "fileResults",
  "finished",
  "focusApprovalModeMenu",
  "home",
  "hostWindowFocused",
  "idle",
  "integrations",
  "models",
  "modelSelected",
  "newChat",
  "notificationAndSoundSettings",
  "openFind",
  "orchestratorActivity",
  "orchestratorDetail",
  "orchestratorExperiments",
  "parallelState",
  "queuedStarted",
  "queueState",
  "resolvedAttachments",
  "runningSoundSetting",
  "sandboxSupport",
  "sandboxUnavailable",
  "setupChecklistState",
  "started",
  "toolStatus",
  "usageStats",
  "workspace",
  "workspaceFileIndex",
] as const satisfies readonly HostToWebviewMessage["type"][];

export type HostToWebviewMessageType = HostToWebviewMessage["type"];
const HOST_TO_WEBVIEW_MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(
  HOST_TO_WEBVIEW_MESSAGE_TYPES,
);

/** Runtime check at the final host-to-webview transport boundary. */
export function parseHostToWebviewMessage(raw: unknown): HostToWebviewMessage | undefined {
  if (!isRecord(raw) || typeof raw.type !== "string") return undefined;
  if (!HOST_TO_WEBVIEW_MESSAGE_TYPE_SET.has(raw.type)) return undefined;
  const type = raw.type as HostToWebviewMessageType;
  const hasString = (key: string): boolean => typeof raw[key] === "string";
  const hasBoolean = (key: string): boolean => typeof raw[key] === "boolean";
  const hasArray = (key: string): boolean => Array.isArray(raw[key]);
  const hasNumber = (key: string): boolean => asFiniteNumber(raw[key]) !== undefined;

  let valid = false;
  switch (type) {
    case "authRequired":
    case "cancelled":
    case "finished":
    case "focusApprovalModeMenu":
    case "hostWindowFocused":
    case "newChat":
    case "openFind":
    case "sandboxUnavailable":
      valid = true;
      break;
    case "approvalModeSelected":
      valid = hasString("mode");
      break;
    case "authState":
      valid = hasBoolean("configured");
      break;
    case "bestOfNCompare":
    case "orchestratorDetail":
      valid = "experiment" in raw;
      break;
    case "bestOfNExperiments":
    case "orchestratorExperiments":
      valid = hasArray("experiments");
      break;
    case "chat":
      valid = hasArray("entries") && hasBoolean("running");
      break;
    case "chunk":
      valid = hasString("text");
      break;
    case "error":
      valid =
        hasString("text") &&
        (raw.recoveryActions === undefined || asRecoveryActionIds(raw.recoveryActions) !== undefined);
      break;
    case "completionSoundSetting":
    case "errorSoundSetting":
    case "runningSoundSetting":
      valid = hasBoolean("enabled");
      break;
    case "contextAttached":
      valid = hasString("label");
      break;
    case "contextInfo":
      valid = raw.label === null || hasString("label");
      break;
    case "contextPreview":
      valid = hasArray("chips");
      break;
    case "fileEdited":
      valid = hasString("path") && hasString("label");
      break;
    case "fileResults":
    case "resolvedAttachments":
      valid = hasNumber("requestId") && hasArray("files");
      break;
    case "home":
      valid = hasArray("conversations") && hasString("searchQuery");
      break;
    case "integrations":
      valid = hasArray("skills") && hasArray("mcpServers") && hasArray("commands");
      break;
    case "idle":
      valid = raw.activeRuns === undefined || hasNumber("activeRuns");
      break;
    case "models":
      valid = hasArray("models") && hasString("selected") && "savedParams" in raw;
      break;
    case "modelSelected":
      valid = hasString("id");
      break;
    case "notificationAndSoundSettings":
      valid = ["notification", "running", "completion", "error", "webviewPlayback"].every(
        hasBoolean,
      );
      break;
    case "orchestratorActivity":
      valid =
        hasString("experimentId") &&
        hasString("conversationId") &&
        hasString("role") &&
        "activity" in raw;
      break;
    case "parallelState":
      valid = hasNumber("activeRuns") && hasNumber("maximumRuns") && hasArray("tasks");
      break;
    case "queuedStarted":
      valid = hasString("prompt") && isStringArray(raw.files);
      break;
    case "queueState":
      valid = hasArray("items");
      break;
    case "sandboxSupport":
      valid = hasBoolean("supported");
      break;
    case "setupChecklistState":
      valid =
        hasBoolean("visible") &&
        hasBoolean("dismissed") &&
        hasBoolean("sandboxSupported") &&
        hasString("approvalMode") &&
        "steps" in raw;
      break;
    case "executionProfileState":
      valid = hasString("profileId") && hasString("label");
      break;
    case "started":
      valid = raw.activeRuns === undefined || hasNumber("activeRuns");
      break;
    case "toolStatus":
      valid =
        hasString("callId") &&
        hasString("text") &&
        (raw.status === undefined || hasString("status"));
      break;
    case "usageStats":
      valid = "summary" in raw && "inlineCompletion" in raw;
      break;
    case "workspace":
      valid =
        hasBoolean("selectable") &&
        (raw.name === undefined || hasString("name")) &&
        (raw.path === undefined || hasString("path"));
      break;
    case "workspaceFileIndex":
      valid = isStringArray(raw.files);
      break;
  }
  return valid ? (raw as HostToWebviewMessage) : undefined;
}
