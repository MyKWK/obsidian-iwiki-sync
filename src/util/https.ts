/**
 * Minimal endpoint validation: the plugin is only allowed to talk HTTPS, and
 * only to whatever single endpoint the user has configured in settings. No
 * generic domain allow/deny list, no redirects to other hosts — this is
 * deliberately not a policy framework.
 */
export function isHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Normalizes a user-provided endpoint: trims whitespace and strips a
 * trailing slash. Does not change scheme/host. Returns null if the result is
 * not a valid https URL.
 */
export function normalizeHttpsEndpoint(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "");
  return isHttpsUrl(trimmed) ? trimmed : null;
}
