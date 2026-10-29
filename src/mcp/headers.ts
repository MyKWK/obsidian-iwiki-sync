/** Case-insensitive header lookup; `requestUrl` and test doubles may return
 * headers with any casing. */
export function getHeader(
  headers: Record<string, string> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return headers[key];
  }
  return undefined;
}
