/**
 * Parsing for the free-text "custom scopes" field (see docs/custom-scopes.md). The browser
 * and the completion-summary rendering both need the same split, so it lives here rather
 * than inside form-state.ts.
 */

/** Comma- or whitespace-separated, deduplicated, in the order the person typed them. */
export function parseCustomScopesText(text: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of text.split(/[,\s]+/)) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
