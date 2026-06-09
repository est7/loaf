// `loaf board` — open the local read-only loaf board in a browser.
//
// W8 family file. Read-only: walks the session registry and serves / snapshots
// a board view; it does NOT mutate the journal, so it takes no CommandMutator.
// Ported from the original inline registration onto the post-W8 seam — the
// presentation helpers it used (rejectIfDryRun / emitFailure) are now ctx
// methods; argv comes from ctx.argv; now / i18n / registry / browser seams are
// injected via BoardDeps.

import type { Command } from "commander";
import type { CommandContext } from "../command-context.js";
import type { I18n } from "../i18n.js";
import { collectPresentSelectors } from "../selectors.js";
import { defaultOpenUrl, type OpenUrl } from "../board/open-url.js";
import {
  createBoardOnceSnapshot,
  DEFAULT_BOARD_HOST,
  DEFAULT_BOARD_PORT,
  isAddressInUse,
  parseBoardPort,
  startBoardServer,
} from "../board/server.js";

export interface BoardDeps {
  i18n: I18n;
  now: () => Date;
  registryDir?: string;
  openUrl?: OpenUrl;
  boardKeepAlive?: (url: string) => Promise<void>;
}

function waitForever(): Promise<void> {
  return new Promise(() => {
    // The board server is an interactive local surface. Production keeps the
    // process alive until SIGINT; tests inject BoardDeps.boardKeepAlive.
  });
}

export function registerBoard(program: Command, ctx: CommandContext, deps: BoardDeps): void {
  program
    .command("board")
    .description("Open the local read-only loaf board in a browser")
    .option("--port <port>", `Loopback port (default: ${DEFAULT_BOARD_PORT}; use 0 for ephemeral)`)
    .option("--in-cwd", "Only show sessions whose registered cwd matches the current cwd")
    .option("--once", "Print one board snapshot and exit without starting a server")
    .option("--open", "Open the board URL in the default browser")
    .action(
      async (opts: { port?: string; inCwd?: boolean; once?: boolean; open?: boolean }) => {
        // no-feature — board walks the registry across sessions.
        if (ctx.rejectIfDryRun("board")) return;
        const selectors = collectPresentSelectors(ctx.argv, process.env);
        if (selectors.length > 0) {
          ctx.emitFailure(
            "USAGE",
            `board does not accept ${selectors.join(" / ")} — it lists across sessions; use --in-cwd to filter`,
            { conflicting: selectors },
          );
          return;
        }
        const scope = opts.inCwd ? "cwd" : "all";
        let port: number;
        try {
          port = opts.port === undefined ? DEFAULT_BOARD_PORT : parseBoardPort(opts.port);
        } catch (error) {
          ctx.emitFailure("USAGE", error instanceof Error ? error.message : String(error), {
            port: opts.port,
          });
          return;
        }
        if (opts.once) {
          const snapshot = await createBoardOnceSnapshot({
            ...(deps.registryDir !== undefined && { registryDir: deps.registryDir }),
            cwd: process.cwd(),
            scope,
            now: deps.now(),
          });
          ctx.success(snapshot, () => {
            const plural = snapshot.totals.sessions === 1 ? "session" : "sessions";
            return `loaf board: ${snapshot.totals.sessions} ${plural} (${snapshot.totals.active} active, ${snapshot.totals.blocked} blocked)\n`;
          });
          return;
        }
        try {
          const board = await startBoardServer({
            host: DEFAULT_BOARD_HOST,
            port,
            ...(deps.registryDir !== undefined && { registryDir: deps.registryDir }),
            cwd: process.cwd(),
            i18n: deps.i18n,
          });
          ctx.success(
            { ok: true, url: board.url, host: board.host, port: board.port },
            () => `loaf board: ${board.url}\n`,
          );
          if (opts.open) {
            const openUrl = deps.openUrl ?? defaultOpenUrl;
            await openUrl(board.url);
          }
          const keepAlive = deps.boardKeepAlive ?? waitForever;
          try {
            await keepAlive(board.url);
          } finally {
            await board.close();
          }
        } catch (error) {
          if (isAddressInUse(error)) {
            ctx.emitFailure("USAGE", `loaf board port ${port} is already in use; retry with --port 0`, {
              port,
            });
            return;
          }
          throw error;
        }
      },
    );
}
