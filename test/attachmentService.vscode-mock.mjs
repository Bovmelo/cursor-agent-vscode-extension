import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const FileType = Object.freeze({ Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 });

export class Uri {
  constructor(fsPath, scheme = "file") {
    this.fsPath = fsPath;
    this.scheme = scheme;
  }

  static file(fsPath) {
    return new Uri(fsPath);
  }

  static joinPath(base, ...parts) {
    return new Uri(path.join(base.fsPath, ...parts));
  }
}

function fileType(entry) {
  if (entry.isSymbolicLink()) return FileType.SymbolicLink;
  if (entry.isFile()) return FileType.File;
  if (entry.isDirectory()) return FileType.Directory;
  return FileType.Unknown;
}

export const workspace = {
  workspaceFolders: [],
  getWorkspaceFolder: (uri) => workspace.workspaceFolders.find((folder) => {
    const relative = path.relative(path.resolve(folder.uri.fsPath), path.resolve(uri.fsPath));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }),
  asRelativePath: (uri) => uri.fsPath,
  fs: {
    createDirectory: (uri) => mkdir(uri.fsPath, { recursive: true }),
    readDirectory: async (uri) => (await readdir(uri.fsPath, { withFileTypes: true }))
      .map((entry) => [entry.name, fileType(entry)]),
    readFile: (uri) => readFile(uri.fsPath),
    writeFile: (uri, bytes) => writeFile(uri.fsPath, bytes),
    delete: (uri, options) => rm(uri.fsPath, { recursive: options?.recursive ?? false, force: true }),
    stat: async (uri) => {
      const stat = await lstat(uri.fsPath);
      return {
        type: stat.isSymbolicLink()
          ? FileType.SymbolicLink
          : stat.isFile() ? FileType.File : stat.isDirectory() ? FileType.Directory : FileType.Unknown,
        ctime: stat.ctimeMs,
        mtime: stat.mtimeMs,
        size: stat.size,
      };
    },
  },
};

export const window = {
  activeTextEditor: undefined,
  showOpenDialog: async () => undefined,
  showWarningMessage: async () => undefined,
};
