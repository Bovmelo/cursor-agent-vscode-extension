import { runExecutableCommand } from "./shellCommand.js";
import { githubCliEnv } from "./shellEnv.js";

export type GhIssue = {
  number: number;
  title: string;
  body: string;
  url: string;
};

export function parseGhIssueListStdout(stdout: string): GhIssue[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const number = typeof record.number === "number" ? record.number : 0;
    const title = typeof record.title === "string" ? record.title : "";
    const body = typeof record.body === "string" ? record.body : "";
    const url = typeof record.url === "string" ? record.url : "";
    if (!(number > 0) || !title) {
      return [];
    }
    return [{ number, title, body, url }];
  });
}

export async function listGhIssues(root: string): Promise<GhIssue[]> {
  try {
    const { stdout } = await runExecutableCommand(
      "gh",
      ["issue", "list", "--limit", "20", "--json", "number,title,body,url"],
      {
        cwd: root,
        maxBuffer: 4 * 1024 * 1024,
        env: githubCliEnv(),
      },
    );
    return parseGhIssueListStdout(stdout);
  } catch {
    return [];
  }
}
