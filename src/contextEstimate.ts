export interface ContextPreviewInput {
  prompt: string;
  profile: string;
  includeProjectMemory: boolean;
  attachContext: boolean;
  contextLabel?: string;
  files: string[];
  skills: string[];
  commandId?: string;
  commandBodyLength?: number;
}

export interface ContextPreviewChip {
  id: string;
  label: string;
  kind: "profile" | "memory" | "editor" | "files" | "skills" | "command" | "estimate";
  removable?: boolean;
}

/** Rough token estimate: ~4 characters per token for Latin-heavy text. */
export function estimateTokens(text: string): number {
  const length = text.trim().length;
  if (length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(length / 4));
}

export function buildContextPreview(input: ContextPreviewInput): {
  chips: ContextPreviewChip[];
  estimatedTokens: number;
} {
  const chips: ContextPreviewChip[] = [];
  let composedLength = input.prompt.length + (input.commandBodyLength ?? 0);

  if (input.profile && input.profile !== "agent") {
    chips.push({
      id: "profile",
      label: input.profile,
      kind: "profile",
    });
    composedLength += 80;
  }
  if (input.commandId) {
    chips.push({
      id: "command",
      label: `/${input.commandId}`,
      kind: "command",
    });
  }
  chips.push({
    id: "memory",
    label: input.includeProjectMemory ? "memory:on" : "memory:off",
    kind: "memory",
  });
  if (input.includeProjectMemory) {
    composedLength += 160;
  }
  if (input.attachContext) {
    chips.push({
      id: "editor",
      label: input.contextLabel || "editor",
      kind: "editor",
      removable: true,
    });
    composedLength += Math.min(4000, (input.contextLabel?.length ?? 20) + 200);
  }
  if (input.files.length > 0) {
    chips.push({
      id: "files",
      label: `files:${input.files.length}`,
      kind: "files",
    });
    composedLength += input.files.length * 40;
  }
  if (input.skills.length > 0) {
    chips.push({
      id: "skills",
      label: `skills:${input.skills.length}`,
      kind: "skills",
    });
    composedLength += input.skills.length * 30;
  }

  const estimatedTokens = estimateTokens("x".repeat(composedLength));
  chips.push({
    id: "estimate",
    label: `~${estimatedTokens} tok`,
    kind: "estimate",
  });

  return { chips, estimatedTokens };
}
