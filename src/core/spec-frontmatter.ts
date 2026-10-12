// Frontmatter block must be the first non-empty content. Opening `---`
// on its own line (with optional trailing whitespace), then any number of
// lines until a closing `---` on its own line. Tolerates LF or CRLF.
//
// Shared with the SC-A2 projection writer (composeSpecMdFrontmatter /
// writeDerivedSpecMd) via splitFrontmatter() — reader and writer MUST
// agree on the fence grammar (codex r90).
export const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

/**
 * Splits a spec.md raw string into (frontmatter_yaml, body) using the
 * shared FRONTMATTER_RE grammar. `body` is everything AFTER the closing
 * `---\n` (preserves trailing content verbatim). If no frontmatter block
 * is present, frontmatter is null and body is the whole input.
 *
 * Callers validate YAML / SpecFrontmatter separately.
 */
export function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { frontmatter: null, body: raw };
  // match[0] is the entire matched fence block; everything AFTER is body.
  const body = raw.slice(match[0].length);
  return { frontmatter: match[1]!, body };
}
