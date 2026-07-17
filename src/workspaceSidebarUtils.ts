export const WORKSPACE_TREE_VIEW_ID = "cursorSubscription.workspaceTree";

export type SidebarGroupId =
  | "sessions"
  | "inbox"
  | "integrations"
  | "background"
  | "audit";

export interface WorkspaceGroupNode {
  kind: "group";
  groupId: SidebarGroupId;
}

export interface WorkspaceChildNode {
  kind: "child";
  groupId: SidebarGroupId;
  node: unknown;
}

export type WorkspaceTreeNode = WorkspaceGroupNode | WorkspaceChildNode;

export const SIDEBAR_GROUP_ORDER: readonly SidebarGroupId[] = [
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
    sessions: "history",
    inbox: "inbox",
    integrations: "extensions",
    background: "server-process",
    audit: "checklist",
  };
  return icons[groupId];
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
