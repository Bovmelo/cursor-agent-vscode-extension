import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

register(new URL("./vscode-runtime-loader.mjs", import.meta.url), import.meta.url);

const {
  ChangeSessionController,
  MAX_PERSISTED_IGNORED_INDEX_BYTES,
  createRevisionPathIndex,
  runVerification,
  trackedRelativePath,
} = await import("../out/aiNative.js");
const { Uri } = await import("vscode");
const execFileAsync = promisify(execFile);

async function runGit(cwd, args) {
  await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Change Session Test",
      GIT_AUTHOR_EMAIL: "change-session@example.test",
      GIT_COMMITTER_NAME: "Change Session Test",
      GIT_COMMITTER_EMAIL: "change-session@example.test",
    },
  });
}

async function initializeRepository(repository) {
  await mkdir(repository, { recursive: true });
  await runGit(repository, ["init", "--quiet"]);
}

function createState(history = [], onUpdate) {
  const values = new Map([
    ["cursorSubscription.changeSessionHistory", history],
  ]);
  return {
    get(key) {
      return values.get(key);
    },
    async update(key, value) {
      values.set(key, value);
      await onUpdate?.(key, value);
    },
  };
}

function createOutput() {
  return { appendLine() {} };
}

test("revision path indexes provide exact and folded constant-time lookup", () => {
  const insensitive = createRevisionPathIndex(["Src/Foo.ts", "src/bar.ts"], true);
  const sensitive = createRevisionPathIndex(["Src/Foo.ts"], false);

  assert.equal(trackedRelativePath("Src/Foo.ts", insensitive), "Src/Foo.ts");
  assert.equal(trackedRelativePath("src\\foo.ts", insensitive), "Src/Foo.ts");
  assert.equal(trackedRelativePath("src/Foo.ts", sensitive), undefined);
  assert.equal(insensitive.exact instanceof Map, true);
  assert.equal(insensitive.folded instanceof Map, true);
  assert.equal("paths" in insensitive, false);
});

test("checkpoint-time ignored files remain unknown after ignore rules change", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "change-session-baseline-"));
  const repository = path.join(temporary, "repository");
  const storage = path.join(temporary, "storage");
  try {
    await initializeRepository(repository);
    await writeFile(path.join(repository, ".gitignore"), "ignored.txt\n", "utf8");
    await writeFile(path.join(repository, "tracked.txt"), "tracked\n", "utf8");
    await runGit(repository, ["add", ".gitignore", "tracked.txt"]);
    await runGit(repository, ["commit", "--quiet", "-m", "baseline"]);
    const ignoredFile = path.join(repository, "ignored.txt");
    await writeFile(ignoredFile, "original ignored content\n", "utf8");

    const controller = new ChangeSessionController(
      createState(),
      createOutput(),
      false,
      Uri.file(storage),
    );
    const session = await controller.begin("test ignored baseline", repository);
    assert.deepEqual(session.ignoredPathIndexAtCheckpoint, {
      version: 1,
      entries: ["ignored.txt"],
    });
    assert.equal(session.ignoredFilesAtCheckpoint, undefined);

    await writeFile(path.join(repository, ".gitignore"), "", "utf8");
    await writeFile(ignoredFile, "changed ignored content\n", "utf8");
    const newFile = path.join(repository, "created.txt");
    await writeFile(newFile, "created later\n", "utf8");

    assert.equal(await controller.baselineFileExists(session.id, ignoredFile), undefined);
    assert.equal(await controller.baselineFileExists(session.id, newFile), false);
    assert.equal(
      await controller.baselineFileExists(session.id, path.join(repository, "tracked.txt")),
      true,
    );

    await controller.detectChangedFiles([ignoredFile, newFile], session.id, true);
    assert.deepEqual(session.nonRestorableFiles, [ignoredFile]);
    assert.equal(controller.canRestoreFile(ignoredFile, session.id), false);
    assert.equal(controller.canRestoreFile(newFile, session.id), true);
    controller.dispose();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("real Git checkpoints compact a large ignored directory and match its descendants", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "change-session-ignored-directory-"));
  const repository = path.join(temporary, "repository");
  const storage = path.join(temporary, "storage");
  try {
    await initializeRepository(repository);
    await writeFile(path.join(repository, ".gitignore"), "node_modules/\n", "utf8");
    await writeFile(path.join(repository, "tracked.txt"), "tracked\n", "utf8");
    await runGit(repository, ["add", ".gitignore", "tracked.txt"]);
    await runGit(repository, ["commit", "--quiet", "-m", "baseline"]);

    const packageFolder = path.join(repository, "node_modules", "package", "generated");
    await mkdir(packageFolder, { recursive: true });
    await Promise.all(
      Array.from({ length: 512 }, (_, index) =>
        writeFile(path.join(packageFolder, `artifact-${index}.js`), `${index}\n`, "utf8")),
    );
    const nestedIgnoredFile = path.join(packageFolder, "artifact-0.js");

    const controller = new ChangeSessionController(
      createState(),
      createOutput(),
      false,
      Uri.file(storage),
    );
    const session = await controller.begin("test compact ignored directory", repository);

    assert.deepEqual(session.ignoredPathIndexAtCheckpoint, {
      version: 1,
      entries: ["node_modules/"],
    });
    assert.equal(
      JSON.stringify(session.ignoredPathIndexAtCheckpoint).includes("artifact-511.js"),
      false,
    );

    await writeFile(path.join(repository, ".gitignore"), "", "utf8");
    await writeFile(nestedIgnoredFile, "changed after checkpoint\n", "utf8");
    assert.equal(
      await controller.baselineFileExists(session.id, nestedIgnoredFile),
      undefined,
    );
    assert.equal(controller.ignoredPathIndexCache.size, 1);

    await controller.detectChangedFiles([nestedIgnoredFile], session.id, true);
    assert.deepEqual(session.nonRestorableFiles, [nestedIgnoredFile]);
    assert.equal(controller.canRestoreFile(nestedIgnoredFile, session.id), false);

    await controller.deleteCheckpoint(session.id);
    assert.equal(controller.ignoredPathIndexCache.size, 0);
    assert.equal(controller.revisionPathCache.size, 0);
    controller.dispose();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("scattered ignored files use a bounded Bloom index without losing known-new paths", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "change-session-ignored-bloom-"));
  const repository = path.join(temporary, "repository");
  const storage = path.join(temporary, "storage");
  try {
    await initializeRepository(repository);
    await writeFile(path.join(repository, ".gitignore"), "*.log\n", "utf8");
    await writeFile(path.join(repository, "tracked.txt"), "tracked\n", "utf8");
    await runGit(repository, ["add", ".gitignore", "tracked.txt"]);
    await runGit(repository, ["commit", "--quiet", "-m", "baseline"]);

    const ignoredNames = Array.from(
      { length: 2_200 },
      (_, index) => `scattered-build-output-${index.toString().padStart(5, "0")}.log`,
    );
    await Promise.all(
      ignoredNames.map((name, index) =>
        writeFile(path.join(repository, name), `${index}\n`, "utf8")),
    );
    const existingIgnoredFile = path.join(repository, ignoredNames[0]);

    const controller = new ChangeSessionController(
      createState(),
      createOutput(),
      false,
      Uri.file(storage),
    );
    const session = await controller.begin("test bounded ignored Bloom index", repository);
    const index = session.ignoredPathIndexAtCheckpoint;

    assert.equal(index.version, 2);
    assert.equal(index.entryCount, ignoredNames.length);
    assert.ok(
      Buffer.byteLength(JSON.stringify(index)) <= MAX_PERSISTED_IGNORED_INDEX_BYTES,
    );

    await writeFile(path.join(repository, ".gitignore"), "", "utf8");
    const ordinaryNewFile = path.join(repository, "ordinary-new-file.ts");
    await writeFile(ordinaryNewFile, "created after checkpoint\n", "utf8");
    assert.equal(
      await controller.baselineFileExists(session.id, existingIgnoredFile),
      undefined,
    );
    assert.equal(
      await controller.baselineFileExists(session.id, ordinaryNewFile),
      false,
    );
    controller.dispose();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("legacy ignored-file indexes remain readable and pre-index sessions stay safe", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "change-session-legacy-index-"));
  const repository = path.join(temporary, "repository");
  const storage = path.join(temporary, "storage");
  try {
    await initializeRepository(repository);
    await writeFile(path.join(repository, "tracked.txt"), "tracked\n", "utf8");
    await runGit(repository, ["add", "tracked.txt"]);
    await runGit(repository, ["commit", "--quiet", "-m", "baseline"]);

    const legacyIgnoredFile = path.join(repository, "legacy-ignored.txt");
    const ordinaryNewFile = path.join(repository, "ordinary-new.txt");
    const baseSession = {
      goal: "legacy ignored index",
      root: repository,
      startedAt: Date.now(),
      phase: "review",
      baselineClean: true,
      checkpointReady: true,
      files: [],
      baselineFiles: {},
    };
    const legacyIndexedSession = {
      ...baseSession,
      id: "legacy-indexed-session",
      ignoredFilesAtCheckpoint: ["legacy-ignored.txt"],
    };
    const preIndexSession = {
      ...baseSession,
      id: "pre-index-session",
    };
    const controller = new ChangeSessionController(
      createState([legacyIndexedSession, preIndexSession]),
      createOutput(),
      false,
      Uri.file(storage),
    );

    assert.deepEqual(
      controller.snapshot(legacyIndexedSession.id).ignoredPathIndexAtCheckpoint,
      { version: 1, entries: ["legacy-ignored.txt"] },
    );
    assert.equal(
      controller.snapshot(legacyIndexedSession.id).ignoredFilesAtCheckpoint,
      undefined,
    );
    assert.equal(
      await controller.baselineFileExists(legacyIndexedSession.id, legacyIgnoredFile),
      undefined,
    );
    assert.equal(
      await controller.baselineFileExists(legacyIndexedSession.id, ordinaryNewFile),
      false,
    );
    assert.equal(
      await controller.baselineFileExists(preIndexSession.id, ordinaryNewFile),
      undefined,
    );
    controller.dispose();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("begin honors an already-aborted preparation signal without saving a session", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "change-session-aborted-begin-"));
  const repository = path.join(temporary, "repository");
  const storage = path.join(temporary, "storage");
  try {
    await initializeRepository(repository);
    const controller = new ChangeSessionController(
      createState(),
      createOutput(),
      false,
      Uri.file(storage),
    );
    const abort = new AbortController();
    abort.abort(new Error("preparation stopped"));

    await assert.rejects(
      controller.begin("aborted checkpoint", repository, abort.signal),
      /preparation stopped/u,
    );
    assert.deepEqual(controller.history(), []);
    controller.dispose();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("begin rolls back state and checkpoint files when aborted during persistence", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "change-session-aborted-persist-"));
  const repository = path.join(temporary, "repository");
  const storage = path.join(temporary, "storage");
  try {
    await initializeRepository(repository);
    await writeFile(path.join(repository, "tracked.txt"), "tracked\n", "utf8");
    await runGit(repository, ["add", "tracked.txt"]);
    await runGit(repository, ["commit", "--quiet", "-m", "baseline"]);

    const abort = new AbortController();
    let updateCount = 0;
    const state = createState([], () => {
      updateCount += 1;
      if (updateCount === 1) {
        abort.abort(new Error("persistence interrupted"));
      }
    });
    const controller = new ChangeSessionController(
      state,
      createOutput(),
      false,
      Uri.file(storage),
    );

    await assert.rejects(
      controller.begin("interrupted persistence", repository, abort.signal),
      /persistence interrupted/u,
    );
    assert.deepEqual(controller.history(), []);
    assert.deepEqual(state.get("cursorSubscription.changeSessionHistory"), []);
    assert.equal(state.get("cursorSubscription.lastChangeSession"), undefined);
    assert.deepEqual(
      await readdir(path.join(storage, "change-sessions")),
      [],
    );
    controller.dispose();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("verification forwards abort signals to a running configured command", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "change-session-aborted-verification-"));
  try {
    await writeFile(
      path.join(temporary, "wait-for-abort.mjs"),
      "setTimeout(() => {}, 10_000);\n",
      "utf8",
    );
    const abort = new AbortController();
    const verification = runVerification(
      temporary,
      ["node wait-for-abort.mjs"],
      createOutput(),
      abort.signal,
    );
    setTimeout(() => abort.abort(new Error("verification stopped")), 100);

    await assert.rejects(verification, /verification stopped/u);
  } finally {
    await rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
});

test("failed revision enumeration is retried and session deletion evicts its index", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "change-session-retry-"));
  const repository = path.join(temporary, "repository");
  const storage = path.join(temporary, "storage");
  await mkdir(repository, { recursive: true });
  const trackedFile = path.join(repository, "tracked.txt");
  const session = {
    id: "retry-session",
    goal: "retry revision enumeration",
    root: repository,
    startedAt: Date.now(),
    phase: "review",
    baselineClean: true,
    checkpointReady: true,
    files: [],
    baselineFiles: {},
    ignoredFilesAtCheckpoint: [],
  };
  const controller = new ChangeSessionController(
    createState([session]),
    createOutput(),
    false,
    Uri.file(storage),
  );
  try {
    assert.equal(await controller.baselineFileExists(session.id, trackedFile), undefined);
    assert.equal(controller.revisionPathCache.size, 0);

    await initializeRepository(repository);
    await writeFile(trackedFile, "tracked\n", "utf8");
    await runGit(repository, ["add", "tracked.txt"]);
    await runGit(repository, ["commit", "--quiet", "-m", "baseline"]);

    assert.equal(await controller.baselineFileExists(session.id, trackedFile), true);
    assert.equal(controller.revisionPathCache.size, 1);

    await controller.deleteCheckpoint(session.id);
    assert.equal(controller.revisionPathCache.size, 0);
  } finally {
    controller.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
