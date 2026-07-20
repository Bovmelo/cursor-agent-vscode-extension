const mockUrl = new URL("./runCenter-vscode-mock.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "vscode") {
    return { url: mockUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
