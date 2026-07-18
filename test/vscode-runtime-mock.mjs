import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
  }

  static file(fsPath) {
    return new Uri(fsPath);
  }

  static joinPath(base, ...parts) {
    return new Uri(path.join(base.fsPath, ...parts));
  }
}

export const workspace = {
  fs: {
    createDirectory: (uri) => mkdir(uri.fsPath, { recursive: true }),
    readFile: (uri) => readFile(uri.fsPath),
    writeFile: (uri, bytes) => writeFile(uri.fsPath, bytes),
    delete: (uri, options) => rm(uri.fsPath, { recursive: options?.recursive ?? false, force: true }),
    copy: (source, target, options) => cp(source.fsPath, target.fsPath, { force: options?.overwrite ?? false }),
  },
};
