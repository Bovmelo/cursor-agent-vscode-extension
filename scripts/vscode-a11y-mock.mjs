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

  toString() {
    return this.fsPath;
  }
}
