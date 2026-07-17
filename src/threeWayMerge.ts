import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { minimalShellEnv } from "./shellEnv.js";

const MAX_MERGE_OUTPUT = 32 * 1024 * 1024;

export interface ThreeWayMergeResult {
  clean: boolean;
  /** Clean output, or conflict-marker output that must stay outside the workspace. */
  bytes?: Uint8Array;
}

export function hasConflictMarkers(bytes: Uint8Array): boolean {
  for (const line of Buffer.from(bytes).toString("utf8").split(/\r?\n/)) {
    if (/^<<<<<<<(?: .*)?$/.test(line) || line === "=======" || /^>>>>>>>(?: .*)?$/.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Merge `proposed` into `current` using the content both sides started from.
 * Overlapping edits are reported as unclean. Their marker output may be used
 * inside an isolated worktree for AI-assisted resolution, but must never be
 * written directly to the user's workspace.
 */
export async function threeWayMergeBytes(
  current: Uint8Array,
  baseline: Uint8Array,
  proposed: Uint8Array,
  label = "file",
): Promise<ThreeWayMergeResult> {
  if (
    Buffer.from(current).includes(0)
    || Buffer.from(baseline).includes(0)
    || Buffer.from(proposed).includes(0)
  ) {
    return { clean: false };
  }

  const temporary = await mkdtemp(path.join(tmpdir(), "cursor-agent-merge-"));
  const currentPath = path.join(temporary, "current");
  const baselinePath = path.join(temporary, "baseline");
  const proposedPath = path.join(temporary, "proposed");
  try {
    await Promise.all([
      writeFile(currentPath, current),
      writeFile(baselinePath, baseline),
      writeFile(proposedPath, proposed),
    ]);
    return await new Promise<ThreeWayMergeResult>((resolve, reject) => {
      execFile(
        "git",
        [
          "merge-file",
          "--stdout",
          "-L",
          "workspace",
          "-L",
          `base:${label}`,
          "-L",
          "parallel-agent",
          currentPath,
          baselinePath,
          proposedPath,
        ],
        {
          windowsHide: true,
          encoding: "buffer",
          maxBuffer: MAX_MERGE_OUTPUT,
          env: minimalShellEnv(),
        },
        (error, stdout) => {
          if (!error) {
            resolve({
              clean: true,
              bytes: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
            });
            return;
          }
          const exitCode = typeof error.code === "number" ? error.code : undefined;
          // git merge-file reports the number of conflicts (capped at 127).
          if (exitCode !== undefined && exitCode > 0 && exitCode <= 127) {
            resolve({
              clean: false,
              bytes: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
            });
            return;
          }
          reject(error);
        },
      );
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
