import assert from "node:assert/strict";
import test from "node:test";

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
    return filePath.replaceAll("\\", "/");
  }
  const slash = filePath.replaceAll("\\", "/");
  const slashIndex = slash.indexOf("/");
  if (slashIndex > 0) {
    const folderName = slash.slice(0, slashIndex);
    const rest = slash.slice(slashIndex + 1);
    const folder = folders.find((candidate) => candidate.name === folderName);
    if (folder) {
      return `${folder.root.replaceAll("\\", "/")}/${rest}`;
    }
  }
  const ordered = preferredName
    ? [
      ...folders.filter((folder) => folder.name === preferredName),
      ...folders.filter((folder) => folder.name !== preferredName),
    ]
    : folders;
  return `${ordered[0].root.replaceAll("\\", "/")}/${slash}`;
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
    resolveAbsoluteInWorkspace("C:/abs/file.ts", folders),
    "C:/abs/file.ts",
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
