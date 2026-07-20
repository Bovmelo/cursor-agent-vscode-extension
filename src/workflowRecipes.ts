export type WorkflowIntent = "ask" | "change" | "delegate" | "review";

export interface WorkflowRecipe {
  id: WorkflowIntent;
  label: string;
  description: string;
  command: string;
  trustRequired: boolean;
}

const RECIPES: readonly WorkflowRecipe[] = [
  {
    id: "ask",
    label: "Ask",
    description: "Discuss code, plans, and trade-offs without starting an autonomous task.",
    command: "cursorSubscription.openChat",
    trustRequired: false,
  },
  {
    id: "change",
    label: "Change",
    description: "Make a reviewed workspace change with verification and checkpoints.",
    command: "cursorSubscription.runAutopilot",
    trustRequired: true,
  },
  {
    id: "delegate",
    label: "Delegate",
    description: "Send a long-running task to an isolated background agent.",
    command: "cursorSubscription.startBackgroundJob",
    trustRequired: true,
  },
  {
    id: "review",
    label: "Review and apply",
    description: "Inspect pending sessions, verification, and recoverable results.",
    command: "cursorSubscription.focusWorkspaceSessions",
    trustRequired: false,
  },
];

export function workflowRecipes(): readonly WorkflowRecipe[] {
  return RECIPES;
}

export function workflowRecipe(id: unknown): WorkflowRecipe | undefined {
  return RECIPES.find((recipe) => recipe.id === id);
}

export function localizeWorkflowRecipe(
  recipe: WorkflowRecipe,
  japanese: boolean,
): Pick<WorkflowRecipe, "label" | "description"> {
  if (!japanese) return { label: recipe.label, description: recipe.description };
  const values: Record<WorkflowIntent, [string, string]> = {
    ask: ["質問する", "コード、計画、選択肢を相談します。自律タスクは開始しません。"],
    change: ["変更する", "検証とチェックポイント付きでワークスペースを変更します。"],
    delegate: ["任せる", "長時間タスクを隔離バックグラウンドAgentへ渡します。"],
    review: ["確認・適用する", "確認待ちセッション、検証、復旧可能な結果を確認します。"],
  };
  return { label: values[recipe.id][0], description: values[recipe.id][1] };
}
