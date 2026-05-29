// Phase 16 SC-14 — thin Ink TUI for `loaf tui` MVP.
//
// Renders the 4-column session table from `format-row.ts` pure
// formatters. Hotkeys:
//   - `q` / Ctrl-C → exit
//   - `r`          → reload registry via injected `loadRows` closure
//
// All behavioral logic (status precedence, label truncation, width
// computation) sits in pure helpers — this component is intentionally
// thin per codex r355 Q3 + r356 layering ack.

import { useState, useCallback, type ReactElement } from "react";
import { Box, Text, useApp, useInput } from "ink";

import type { SessionRow } from "../sessions-list.js";
import {
  type ColumnWidths,
  computeColumnWidths,
  formatIteration,
  formatLabel,
  formatPhaseSub,
  formatStatus,
} from "./format-row.js";

export interface AppProps {
  /** Initial rows captured at startup; r reloads via loadRows. */
  initialRows: ReadonlyArray<SessionRow>;
  /** Closure to re-read registry on [r] press. Preserves
   *  deps.registryDir / LOAF_REGISTRY_DIR per codex r357 guardrail 2 —
   *  the App does NOT silently fall back to the real user registry
   *  during tests. */
  loadRows: () => Promise<ReadonlyArray<SessionRow>>;
}

export function App({ initialRows, loadRows }: AppProps): ReactElement {
  const { exit } = useApp();
  const [rows, setRows] = useState<ReadonlyArray<SessionRow>>(initialRows);
  const [reloading, setReloading] = useState(false);

  const handleReload = useCallback(async () => {
    if (reloading) return;
    setReloading(true);
    try {
      const next = await loadRows();
      setRows(next);
    } finally {
      setReloading(false);
    }
  }, [loadRows, reloading]);

  useInput((input, key) => {
    if (input === "q" || key.ctrl && input === "c" || key.escape) {
      exit();
      return;
    }
    if (input === "r") {
      void handleReload();
    }
  });

  const widths: ColumnWidths = computeColumnWidths(rows);

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>loaf sessions ({rows.length})</Text>
        {reloading && <Text dimColor> · reloading…</Text>}
      </Box>
      {rows.length === 0 ? (
        <Text dimColor>(no sessions found)</Text>
      ) : (
        <>
          <Box>
            <Text bold>{padCell("LABEL", widths.label)}</Text>
            <Text>  </Text>
            <Text bold>{padCell("PHASE.SUB", widths.phase_sub)}</Text>
            <Text>  </Text>
            <Text bold>{padCell("ITER", widths.iter)}</Text>
            <Text>  </Text>
            <Text bold>STATUS</Text>
          </Box>
          {rows.map((row) => (
            <Box key={row.session_id}>
              <Text>{padCell(formatLabel(row, widths.label), widths.label)}</Text>
              <Text>  </Text>
              <Text>{padCell(formatPhaseSub(row), widths.phase_sub)}</Text>
              <Text>  </Text>
              <Text>{padCell(formatIteration(row), widths.iter)}</Text>
              <Text>  </Text>
              <Text>{formatStatus(row)}</Text>
            </Box>
          ))}
        </>
      )}
      <Box marginTop={1}>
        <Text dimColor>[q] quit · [r] refresh</Text>
      </Box>
    </Box>
  );
}

/** Right-pad a column cell with spaces. Truncation handled by
 *  formatLabel; PHASE.SUB / ITER / STATUS use computed widths so the
 *  raw content always fits (no truncation needed). */
function padCell(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}
