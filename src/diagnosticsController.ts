import { formatDiagnosticsMarkdown, type DiagnosticsBundle } from "./diagnosticsBundle.js";

export interface DiagnosticsExportOptions {
  readonly defaultFileName: string;
  readonly filters: Readonly<Record<string, readonly string[]>>;
}

export interface DiagnosticsControllerDependencies<Target> {
  readonly japanese: boolean;
  readonly collectBundle: () => Promise<DiagnosticsBundle> | DiagnosticsBundle;
  readonly chooseExportTarget: (options: DiagnosticsExportOptions) => Promise<Target | undefined>;
  readonly writeText: (target: Target, content: string) => Promise<void>;
  readonly targetPath: (target: Target) => string;
  readonly showInformationMessage: (
    message: string,
    actions: readonly string[],
  ) => Promise<string | undefined>;
  readonly openTarget: (target: Target) => Promise<void>;
}

export type DiagnosticsExportResult =
  { readonly status: "cancelled" } | { readonly status: "exported"; readonly opened: boolean };

/** Collects, redacts, and exports diagnostics through host-provided I/O callbacks. */
export class DiagnosticsController<Target> {
  public constructor(private readonly dependencies: DiagnosticsControllerDependencies<Target>) {}

  public async exportDiagnostics(): Promise<DiagnosticsExportResult> {
    const bundle = await this.dependencies.collectBundle();
    const target = await this.dependencies.chooseExportTarget({
      defaultFileName: "cursor-agent-diagnostics.md",
      filters: { Markdown: ["md"] },
    });
    if (target === undefined) {
      return { status: "cancelled" };
    }

    await this.dependencies.writeText(target, formatDiagnosticsMarkdown(bundle));
    const openLabel = this.localize("Open diagnostics", "診断を開く");
    const answer = await this.dependencies.showInformationMessage(
      this.localize(
        `Exported redacted diagnostics to ${this.dependencies.targetPath(target)}`,
        `機密情報を除外した診断を書き出しました: ${this.dependencies.targetPath(target)}`,
      ),
      [openLabel],
    );
    const opened = answer === openLabel;
    if (opened) {
      await this.dependencies.openTarget(target);
    }
    return { status: "exported", opened };
  }

  private localize(english: string, japanese: string): string {
    return this.dependencies.japanese ? japanese : english;
  }
}
