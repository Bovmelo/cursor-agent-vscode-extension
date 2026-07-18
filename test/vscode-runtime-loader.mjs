import { pathToFileURL } from "node:url";

const mockUrl = new URL("./vscode-runtime-mock.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "vscode") {
    return { url: mockUrl, shortCircuit: true };
  }
  if (/^[A-Za-z]:[\\/]/u.test(specifier)) {
    return nextResolve(pathToFileURL(specifier).href, context);
  }
  return nextResolve(specifier, context);
}
