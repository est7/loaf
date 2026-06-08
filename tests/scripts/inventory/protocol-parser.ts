import { readFileSync } from "node:fs";

export type ParseErrorKind =
  | "MARKER_MISSING"
  | "MARKER_DUPLICATED"
  | "MARKER_UNCLOSED"
  | "ROW_MALFORMED"
  | "PLACEHOLDER_NO_REASON"
  | "FUTURE_NO_REASON";

export type ParseError = {
  kind: ParseErrorKind;
  location: string;
  detail: string;
};

export type RowSkipReason =
  | { type: "placeholder"; reason: string }
  | { type: "future"; reason: string };

export type ParsedRow = {
  /** First column normalized — backtick-stripped name token, e.g. 'loaf start' or '--json' */
  name: string;
  /** Raw cell content of the first column (with backticks) */
  rawFirstCell: string;
  /** Full raw row as written in the source markdown */
  rawLine: string;
  /** 1-indexed line number in the source file */
  lineNumber: number;
  /** Whether the row is a markdown table separator (\`|---|---|\`); separators are filtered before output */
  isSeparator: boolean;
  /** Skip annotation found inline in the row, if any */
  skipReason: RowSkipReason | null;
};

export type ParsedBlock = {
  /** The marker tag — e.g. 'v0.1.0 globalFlags' or 'v0.1.0 commands' */
  tag: string;
  /** 1-indexed line range in the source file */
  beginLine: number;
  endLine: number;
  /** Filter: only data rows (separators removed) */
  rows: ParsedRow[];
};

export type ParserResult = {
  blocks: ParsedBlock[];
  errors: ParseError[];
};

const BEGIN_RE = /<!--\s*inventory:current-begin\s+(.+?)\s*-->/;
const END_RE = /<!--\s*inventory:current-end\s*-->/;
const FUTURE_RE = /<!--\s*inventory:future\b(.*?)-->/;
const PLACEHOLDER_RE = /<!--\s*inventory:placeholder\b(.*?)-->/;

/**
 * Parse `docs/protocol.md` (or any markdown file) for inventory:current-begin /
 * current-end blocks. Returns parsed rows + a `errors` array of fail-closed
 * diagnostics (missing markers, duplicated markers, malformed rows, etc.).
 *
 * Callers MUST inspect `result.errors`: when non-empty, the harness should
 * fail closed and NOT proceed to inventory diffing — drift hidden by a
 * malformed marker is exactly what SC-0 is meant to catch.
 */
export function parseProtocolMarkers(filePath: string): ParserResult {
  const text = readFileSync(filePath, "utf8");
  return parseProtocolMarkersFromText(text, filePath);
}

export function parseProtocolMarkersFromText(text: string, sourceLabel = "<inline>"): ParserResult {
  const lines = text.split(/\r?\n/);
  const errors: ParseError[] = [];
  const blocks: ParsedBlock[] = [];

  let openBlock: {
    tag: string;
    beginLine: number;
    rows: ParsedRow[];
    sawSeparator: boolean;
  } | null = null;
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const raw = lines[lineIndex] ?? "";
    const lineNum = lineIndex + 1;

    const beginMatch = raw.match(BEGIN_RE);
    if (beginMatch) {
      if (openBlock !== null) {
        errors.push({
          kind: "MARKER_DUPLICATED",
          location: `${sourceLabel}:${lineNum}`,
          detail: `inventory:current-begin nested inside an unclosed block (previous begin at ${sourceLabel}:${openBlock.beginLine})`,
        });
      }
      openBlock = {
        tag: (beginMatch[1] ?? "").trim(),
        beginLine: lineNum,
        rows: [],
        sawSeparator: false,
      };
      lineIndex++;
      continue;
    }

    const endMatch = raw.match(END_RE);
    if (endMatch) {
      if (openBlock === null) {
        errors.push({
          kind: "MARKER_MISSING",
          location: `${sourceLabel}:${lineNum}`,
          detail: "inventory:current-end without a preceding inventory:current-begin",
        });
      } else {
        blocks.push({
          tag: openBlock.tag,
          beginLine: openBlock.beginLine,
          endLine: lineNum,
          rows: openBlock.rows,
        });
        openBlock = null;
      }
      lineIndex++;
      continue;
    }

    if (openBlock !== null && raw.trim().startsWith("|")) {
      const row = parseTableRow(raw, lineNum, sourceLabel, errors);
      if (row !== null) {
        if (row.isSeparator) {
          // GFM `|---|---|` separator immediately following the header.
          // Mark the block as "data-rows from here onward"; previously
          // accumulated rows are header(s) — drop them.
          openBlock.sawSeparator = true;
          openBlock.rows = [];
        } else if (openBlock.sawSeparator) {
          // Only collect rows AFTER the separator; rows before are
          // table-column headers (e.g. "| Flag | Short | Type | Notes |").
          openBlock.rows.push(row);
        }
      }
    }

    lineIndex++;
  }

  if (openBlock !== null) {
    errors.push({
      kind: "MARKER_UNCLOSED",
      location: `${sourceLabel}:${openBlock.beginLine}`,
      detail: "inventory:current-begin without a matching inventory:current-end before EOF",
    });
  }

  return { blocks, errors };
}

function parseTableRow(
  line: string,
  lineNumber: number,
  sourceLabel: string,
  errors: ParseError[],
): ParsedRow | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;

  // Strip leading/trailing pipes then split, treating `\|` as an escaped
  // pipe (per GFM — common inside code spans containing alternatives like
  // `--policy <...> \| --input ...`). Without this, cells split early and
  // names parse as malformed without raising ROW_MALFORMED. (codex r191 BLOCKER 1)
  const inner = trimmed.replace(/^\|/, "").replace(/\|\s*$/, "");
  const cells = inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());

  if (cells.length === 0 || (cells.length === 1 && cells[0] === "")) {
    return null;
  }

  // Detect separator row: cells composed of dashes (with optional colons for alignment).
  const isSeparator = cells.every((c) => /^:?-{3,}:?$/.test(c.replace(/\s/g, "")));
  if (isSeparator) {
    return {
      name: "",
      rawFirstCell: "",
      rawLine: line,
      lineNumber,
      isSeparator: true,
      skipReason: null,
    };
  }

  const rawFirstCell = cells[0] ?? "";

  // Validate first cell has balanced backticks. An unmatched backtick almost
  // always indicates an early-truncated split (e.g. escaped-pipe miss) and
  // would otherwise let a malformed name slip silently past the diff gate.
  // (codex r191 BLOCKER 1 defensive check)
  const backtickCount = (rawFirstCell.match(/`/g) ?? []).length;
  if (backtickCount % 2 !== 0) {
    errors.push({
      kind: "ROW_MALFORMED",
      location: `${sourceLabel}:${lineNumber}`,
      detail: `unmatched backticks in first cell — likely an early-truncated split: ${truncate(rawFirstCell, 80)}`,
    });
  }
  let skipReason: RowSkipReason | null = null;

  const futureMatch = rawFirstCell.match(FUTURE_RE);
  if (futureMatch) {
    const reason = extractAttribute(futureMatch[1] ?? "", "reason");
    if (reason === null) {
      errors.push({
        kind: "FUTURE_NO_REASON",
        location: `${sourceLabel}:${lineNumber}`,
        detail: 'inventory:future annotation missing reason="..." attribute',
      });
    } else {
      skipReason = { type: "future", reason };
    }
  } else {
    const placeholderMatch = rawFirstCell.match(PLACEHOLDER_RE);
    if (placeholderMatch) {
      const reason = extractAttribute(placeholderMatch[1] ?? "", "reason");
      if (reason === null) {
        errors.push({
          kind: "PLACEHOLDER_NO_REASON",
          location: `${sourceLabel}:${lineNumber}`,
          detail: 'inventory:placeholder annotation missing reason="..." attribute',
        });
      } else {
        skipReason = { type: "placeholder", reason };
      }
    }
  }

  const name = extractNameToken(stripInlineComments(rawFirstCell));
  if (name === "") {
    errors.push({
      kind: "ROW_MALFORMED",
      location: `${sourceLabel}:${lineNumber}`,
      detail: `table row with empty name token in column 0: ${truncate(rawFirstCell, 80)}`,
    });
  }

  return {
    name,
    rawFirstCell,
    rawLine: line,
    lineNumber,
    isSeparator: false,
    skipReason,
  };
}

function stripInlineComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function extractAttribute(attrBlob: string, name: string): string | null {
  const re = new RegExp(`${name}=(?:"([^"]*)"|'([^']*)')`);
  const m = attrBlob.match(re);
  if (!m) return null;
  return (m[1] ?? m[2] ?? "").trim();
}

/**
 * Extract the canonical name from a first-cell content. For commands, this is
 * the `loaf <verb> [<subverb>]` prefix stripped of backticks and trailing args
 * / flags. For flags, this is `--name`.
 *
 * Examples (input → output):
 *   "`loaf start <feature> [--ceremony ...]`" → "loaf start"
 *   "`loaf tasks step done --task T-N --step <s>`" → "loaf tasks step done"
 *   "`--json`" → "--json"
 *   "`--format <fmt>`" → "--format"
 *   "`<artifact> schema --json`" → "<artifact> schema"  (placeholder row)
 */
function extractNameToken(stripped: string): string {
  // Pull content between first pair of backticks if present; else fall back to full text.
  const tickMatch = stripped.match(/`([^`]+)`/);
  const inner = tickMatch ? (tickMatch[1] ?? "").trim() : stripped;

  if (inner.startsWith("--")) {
    // Flag — take first whitespace-bounded token, stop at any of <, =, ,
    const flagMatch = inner.match(/^(--[a-zA-Z0-9][a-zA-Z0-9-]*)/);
    return flagMatch ? (flagMatch[1] ?? "") : "";
  }

  if (inner.startsWith("loaf ")) {
    // Command — strip 'loaf ', then take the longest prefix of identifier-shaped tokens.
    const rest = inner.slice(5);
    const parts = rest.split(/\s+/);
    const verbParts: string[] = [];
    for (const part of parts) {
      // Stop at first arg/option token.
      if (part.startsWith("--") || part.startsWith("-")) break;
      if (part.startsWith("<") || part.startsWith("[")) break;
      if (part === "|") break;
      verbParts.push(part);
    }
    return verbParts.length > 0 ? `loaf ${verbParts.join(" ")}` : "loaf";
  }

  // Placeholder rows like `<artifact> schema --json`
  if (inner.startsWith("<")) {
    const stopAt = inner.search(/\s+--/);
    if (stopAt > 0) return inner.slice(0, stopAt).trim();
    return inner;
  }

  return inner;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
