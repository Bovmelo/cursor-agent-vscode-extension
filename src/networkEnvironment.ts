const PROXY_ENVIRONMENT_VARIABLES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

export interface BlockedProxyEnvironment {
  variable: string;
  address: string;
}

function isLoopbackDiscardProxy(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const loopback =
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "::1";
    return loopback && url.port === "9";
  } catch {
    return false;
  }
}

/**
 * Detects the loopback discard proxy used by restricted launch environments.
 * It must not be removed automatically because doing so would bypass the
 * launcher's network policy.
 */
export function detectBlockedProxyEnvironment(): BlockedProxyEnvironment | undefined {
  for (const variable of PROXY_ENVIRONMENT_VARIABLES) {
    const value = process.env[variable]?.trim();
    if (value && isLoopbackDiscardProxy(value)) {
      return {
        variable,
        address: value,
      };
    }
  }
  return undefined;
}
