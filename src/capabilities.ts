/**
 * Backend capability tags.
 *
 * Backends declare which capability tags they offer (JSON config only);
 * workflows declare which tags they require via a `[CAPABILITY]` marker node.
 * A backend accepts a workflow when it offers every required tag; backends
 * without a declared capability list accept anything, so tags only ever
 * narrow automatic selection.
 */

/** Normalize a tag list: trim, lowercase, dedupe, drop empties. */
export function normalizeCapabilityList(values: Iterable<string> | undefined): string[] {
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const normalized = value.trim().toLowerCase();
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

/** Split a comma-separated tag string (the `[CAPABILITY]` node value). */
export function splitCapabilityText(text: string): string[] {
  return normalizeCapabilityList(text.split(","));
}

/** True when a backend offers every required tag. */
export function backendSupportsCapabilities(
  offered: string[] | undefined,
  required: string[],
): boolean {
  if (required.length === 0) return true;
  if (offered === undefined) return true; // undeclared = accepts everything
  if (offered.length === 0) return false; // empty = soft-disabled
  const set = new Set(offered);
  return required.every((tag) => set.has(tag));
}

/** Tags a backend does not offer, for diagnostics. Empty when it accepts all. */
export function missingCapabilities(
  offered: string[] | undefined,
  required: string[],
): string[] {
  if (required.length === 0 || offered === undefined) return [];
  const set = new Set(offered);
  return required.filter((tag) => !set.has(tag));
}
