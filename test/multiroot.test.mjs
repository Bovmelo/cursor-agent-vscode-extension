import assert from "node:assert/strict";
import test from "node:test";

function isPathInside(root, candidate) {
  const relative = candidate.replaceAll("\\", "/").slice(root.replaceAll("\\", "/").length);
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
  const normalizedCandidate = candidate.replaceAll("\\", "/");
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function resolveAbsoluteInWorkspace(
  filePath,
  folders,
  preferredName,
) {
  if (folders.length === 0) {
    return undefined;
  }
  const isAbsolute = /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(filePath);
  if (isAbsolute) {
    const absolute = filePath.replaceAll("\\", "/");
    return folders.some((folder) => isPathInside(folder.root, absolute)) ? absolute : undefined;
  }
  const slash = filePath.replaceAll("\\", "/");
  const slashIndex = slash.indexOf("/");
  if (slashIndex > 0) {
    const folderName = slash.slice(0, slashIndex);
    const rest = slash.slice(slashIndex + 1);
    const folder = folders.find((candidate) => candidate.name === folderName);
    if (folder) {
      const absolute = `${folder.root.replaceAll("\\", "/")}/${rest}`;
      return isPathInside(folder.root, absolute) ? absolute : undefined;
    }
  }
  const ordered = preferredName
    ? [
      ...folders.filter((folder) => folder.name === preferredName),
      ...folders.filter((folder) => folder.name !== preferredName),
    ]
    : folders;
  for (const folder of ordered) {
    const absolute = `${folder.root.replaceAll("\\", "/")}/${slash}`;
    if (isPathInside(folder.root, absolute) && !slash.includes("..")) {
      return absolute;
    }
  }
  return undefined;
}

test("multi-root paths resolve folder-prefixed and preferred roots", () => {
  const folders = [
    { name: "app", root: "C:/ws/app" },
    { name: "api", root: "C:/ws/api" },
  ];
  assert.equal(
    resolveAbsoluteInWorkspace("api/src/main.ts", folders),
    "C:/ws/api/src/main.ts",
  );
  assert.equal(
    resolveAbsoluteInWorkspace("src/main.ts", folders, "api"),
    "C:/ws/api/src/main.ts",
  );
  assert.equal(
    resolveAbsoluteInWorkspace("C:/ws/api/src/main.ts", folders),
    "C:/ws/api/src/main.ts",
  );
  assert.equal(
    resolveAbsoluteInWorkspace("C:/abs/file.ts", folders),
    undefined,
  );
  assert.equal(
    resolveAbsoluteInWorkspace("../escape.ts", folders, "api"),
    undefined,
  );
});

function matchFolderUri(folders, uriString) {
  if (!uriString) {
    return undefined;
  }
  return folders.find(
    (folder) => folder.uri === uriString || folder.fsPath === uriString,
  );
}

test("persisted chat workspace URI matches the intended multi-root folder", () => {
  const folders = [
    { name: "app", uri: "file:///C:/ws/app", fsPath: "C:/ws/app" },
    { name: "api", uri: "file:///C:/ws/api", fsPath: "C:/ws/api" },
  ];
  assert.equal(matchFolderUri(folders, "file:///C:/ws/api")?.name, "api");
  assert.equal(matchFolderUri(folders, "C:/ws/app")?.name, "app");
  assert.equal(matchFolderUri(folders, "file:///C:/ws/other"), undefined);
});
