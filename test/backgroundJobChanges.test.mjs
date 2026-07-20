import assert from "node:assert/strict";
import test from "node:test";
import {
  backgroundChangeContextValue,
  backgroundChangeDescription,
  buildBackgroundJobChildDrafts,
  canPreviewBackgroundChanges,
} from "../out/backgroundJobChanges.js";
import { readFile } from "node:fs/promises";

const backgroundJobsSource = await readFile(
  new URL("../src/backgroundJobs.ts", import.meta.url),
  "utf8",
);

test("only completed background jobs expose pending-change previews", () => {
  assert.equal(canPreviewBackgroundChanges("completed"), true);
  assert.equal(canPreviewBackgroundChanges("running"), false);
  assert.equal(canPreviewBackgroundChanges("applied"), false);
});

test("background change descriptions mark excluded files", () => {
  assert.equal(
    backgroundChangeDescription(
      { relative: "a.ts", kind: "modified", added: 2, deleted: 1, excluded: false },
      false,
    ),
    "modified +2/-1",
  );
  assert.equal(
    backgroundChangeDescription(
      { relative: "secret.env", kind: "added", added: 1, deleted: 0, excluded: true },
      true,
    ),
    "added +1/-0 · 除外",
  );
  assert.equal(
    backgroundChangeContextValue({
      relative: "secret.env",
      kind: "added",
      added: 1,
      deleted: 0,
      excluded: true,
    }),
    "cursorBackground.change.excluded",
  );
});

test("background job children list pending files once the cache is ready", () => {
  const drafts = buildBackgroundJobChildDrafts({
    summaryLabel: "Done",
    workspaceRoot: "/tmp/ws",
    changes: [
      { relative: "src/a.ts", kind: "modified", added: 1, deleted: 0, excluded: false },
      { relative: ".env", kind: "added", added: 1, deleted: 0, excluded: true },
    ],
    loading: false,
    japanese: false,
  });

  assert.equal(drafts[0]?.kind, "summary");
  assert.deepEqual(
    drafts.slice(1).map((draft) => ({
      kind: draft.kind,
      label: draft.label,
      description: draft.description,
      relative: draft.relative,
      excluded: draft.excluded,
    })),
    [
      {
        kind: "change",
        label: "src/a.ts",
        description: "modified +1/-0",
        relative: "src/a.ts",
        excluded: false,
      },
      {
        kind: "change",
        label: ".env",
        description: "added +1/-0 · excluded",
        relative: ".env",
        excluded: true,
      },
    ],
  );
});

test("background job children show loading and error states", () => {
  assert.equal(
    buildBackgroundJobChildDrafts({
      summaryLabel: "Done",
      workspaceRoot: "/tmp/ws",
      loading: true,
      japanese: true,
    })[1]?.label,
    "変更を読み込み中…",
  );
  assert.equal(
    buildBackgroundJobChildDrafts({
      summaryLabel: "Done",
      workspaceRoot: "/tmp/ws",
      loadError: "boom",
      loading: false,
      japanese: false,
    })[1]?.label,
    "boom",
  );
});

test("completed background summaries open a picker-backed diff preview", () => {
  const treeItemSource = backgroundJobsSource.slice(
    backgroundJobsSource.indexOf("public getTreeItem("),
    backgroundJobsSource.indexOf("public getChildren("),
  );
  assert.match(
    treeItemSource,
    /node\.kind === "summary"[\s\S]*?cursorSubscription\.openBackgroundChange[\s\S]*?jobId: node\.job\.id/u,
  );

  const openChangeSource = backgroundJobsSource.slice(
    backgroundJobsSource.indexOf("public async openChange("),
    backgroundJobsSource.indexOf("public async create("),
  );
  assert.match(openChangeSource, /await this\.ensurePendingChanges\(job\)/u);
  assert.match(openChangeSource, /changes\.length === 1/u);
  assert.match(openChangeSource, /showQuickPick/u);
  assert.match(openChangeSource, /vscode\.diff/u);
});

test("background diff preview validates current job, pending membership, and safe path first", () => {
  const openChangeSource = backgroundJobsSource.slice(
    backgroundJobsSource.indexOf("public async openChange("),
    backgroundJobsSource.indexOf("public async create("),
  );
  assert.match(openChangeSource, /const currentJob = this\.jobs\.get\(job\.id\)/u);
  assert.match(openChangeSource, /const previewJob = this\.jobs\.get\(job\.id\)/u);
  assert.match(openChangeSource, /previewChanges\?\.some\(\(change\) => change\.relative === relative\)/u);
  assert.match(openChangeSource, /beginJobOperation\(job\.id\)[\s\S]*?finally[\s\S]*?finishJobOperation\(job\.id\)/u);
  assert.ok(
    openChangeSource.indexOf("const previewJob = this.jobs.get(job.id)")
      > openChangeSource.indexOf("showQuickPick("),
  );
  assert.ok(
    openChangeSource.indexOf("proposedPath = safePath(")
      < openChangeSource.indexOf("await readIsolatedBaseline("),
  );

  const resolverSource = backgroundJobsSource.slice(
    backgroundJobsSource.indexOf("private resolveChangeTarget("),
    backgroundJobsSource.indexOf("private requestPendingChanges("),
  );
  assert.match(resolverSource, /this\.jobs\.get\(jobId\)/u);
  assert.doesNotMatch(resolverSource, /return \{ job: target\.job/u);
});
