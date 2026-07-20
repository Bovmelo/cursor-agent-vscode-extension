export const WORKSPACE_TREE_VIEW_ID = "cursorSubscription.workspaceTree";

export type SidebarGroupId =
  | "runCenter"
  | "sessions"
  | "inbox"
  | "integrations"
  | "background"
  | "audit";

export type ExistingSidebarGroupId = Exclude<SidebarGroupId, "runCenter">;

export interface WorkspaceGroupNode {
  kind: "group";
  groupId: SidebarGroupId;
}

export interface WorkspaceChildNode {
  kind: "child";
  groupId: SidebarGroupId;
  node: unknown;
}

export interface WorkspacePlaceholderNode {
  kind: "placeholder";
  groupId: SidebarGroupId;
}

export type WorkspaceTreeNode =
  | WorkspaceGroupNode
  | WorkspaceChildNode
  | WorkspacePlaceholderNode;

export const SIDEBAR_GROUP_ORDER: readonly SidebarGroupId[] = [
  "runCenter",
  "sessions",
  "inbox",
  "integrations",
  "background",
  "audit",
];

export function sidebarGroupContextValue(groupId: SidebarGroupId): string {
  return `cursorSidebar.group.${groupId}`;
}

export function sidebarGroupLabel(groupId: SidebarGroupId, japanese: boolean): string {
  const labels: Record<SidebarGroupId, [string, string]> = {
    runCenter: ["Run Center", "Run Center"],
    sessions: ["Sessions", "Sessions"],
    inbox: ["Inbox", "Inbox"],
    integrations: ["Rules / Skills / MCP", "Rules / Skills / MCP"],
    background: ["Background", "Background"],
    audit: ["Audit", "Audit"],
  };
  return japanese ? labels[groupId][1] : labels[groupId][0];
}

export function sidebarGroupIcon(groupId: SidebarGroupId): string {
  const icons: Record<SidebarGroupId, string> = {
    runCenter: "pulse",
    sessions: "history",
    inbox: "inbox",
    integrations: "extensions",
    background: "server-process",
    audit: "checklist",
  };
  return icons[groupId];
}

export function sidebarGroupDescription(count: number): string {
  return String(Math.max(0, Math.trunc(count)));
}

export function sidebarGroupEmptyLabel(groupId: SidebarGroupId, japanese: boolean): string {
  const labels: Record<SidebarGroupId, [string, string]> = {
    runCenter: [
      "Next: start a run from Chat or Inbox",
      "次へ: Chat または Inbox から実行を開始",
    ],
    sessions: ["Next: start a chat", "次へ: チャットを開始"],
    inbox: ["Next: create or scan for a task", "次へ: タスクを作成またはスキャン"],
    integrations: [
      "Next: refresh integrations",
      "次へ: インテグレーションを更新",
    ],
    background: ["Next: start a background job", "次へ: バックグラウンドジョブを開始"],
    audit: ["Next: run an agent task", "次へ: エージェントタスクを実行"],
  };
  return japanese ? labels[groupId][1] : labels[groupId][0];
}

export function sidebarGroupEmptyCommand(groupId: SidebarGroupId): string {
  const commands: Record<SidebarGroupId, string> = {
    runCenter: "cursorSubscription.chooseWorkflow",
    sessions: "cursorSubscription.openChat",
    inbox: "cursorSubscription.createSupervisorTask",
    integrations: "cursorSubscription.refreshIntegrations",
    background: "cursorSubscription.startBackgroundJob",
    audit: "cursorSubscription.chooseWorkflow",
  };
  return commands[groupId];
}

export function sidebarGroupTooltip(
  groupId: SidebarGroupId,
  count: number,
  japanese: boolean,
): string {
  const label = sidebarGroupLabel(groupId, japanese);
  const normalizedCount = Math.max(0, Math.trunc(count));
  if (japanese) {
    return normalizedCount === 0
      ? `${label}: 0 件。${sidebarGroupEmptyLabel(groupId, true)}`
      : `${label}: ${normalizedCount} 件`;
  }
  return normalizedCount === 0
    ? `${label}: 0 items. ${sidebarGroupEmptyLabel(groupId, false)}`
    : `${label}: ${normalizedCount} ${normalizedCount === 1 ? "item" : "items"}`;
}

export function sidebarGroupAccessibilityLabel(
  groupId: SidebarGroupId,
  count: number,
  japanese: boolean,
): string {
  return sidebarGroupTooltip(groupId, count, japanese);
}

export function isWorkspaceChildNode(value: unknown): value is WorkspaceChildNode {
  return Boolean(
    value
    && typeof value === "object"
    && (value as WorkspaceChildNode).kind === "child"
    && "node" in (value as object),
  );
}

export function unwrapWorkspaceNode<T = unknown>(target: unknown): T {
  return (isWorkspaceChildNode(target) ? target.node : target) as T;
}
