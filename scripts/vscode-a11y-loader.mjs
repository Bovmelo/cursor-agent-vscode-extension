const mockUrl = new URL("./vscode-a11y-mock.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "vscode") {
    return { shortCircuit: true, url: mockUrl };
  }
  return nextResolve(specifier, context);
}
