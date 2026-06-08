import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { DEFAULT_I18N, type I18n } from "../i18n.js";
import { renderBoardHtml } from "./static.js";
import {
  buildBoardSessionDetail,
  buildBoardSnapshot,
  type BoardScope,
  type BoardSnapshot,
} from "./model.js";

export const DEFAULT_BOARD_HOST = "127.0.0.1";
export const DEFAULT_BOARD_PORT = 41738;

export interface BoardServerOptions {
  host?: string;
  port?: number;
  registryDir?: string;
  cwd?: string;
  i18n?: I18n;
}

export interface BoardServerHandle {
  url: string;
  host: string;
  port: number;
  server: Server;
  close: () => Promise<void>;
}

export async function createBoardOnceSnapshot(input: {
  registryDir?: string;
  cwd?: string;
  scope: BoardScope;
  now?: Date;
}): Promise<BoardSnapshot> {
  return await buildBoardSnapshot(input);
}

export async function startBoardServer(options: BoardServerOptions): Promise<BoardServerHandle> {
  const host = options.host ?? DEFAULT_BOARD_HOST;
  const port = options.port ?? DEFAULT_BOARD_PORT;
  const cwd = options.cwd ?? process.cwd();
  const i18n = options.i18n ?? DEFAULT_I18N;
  const server = createServer(async (request, response) => {
    try {
      await routeRequest(request, response, {
        ...(options.registryDir !== undefined && { registryDir: options.registryDir }),
        cwd,
        i18n,
      });
    } catch (error) {
      sendRouteError(response, error);
    }
  });
  await listen(server, port, host);
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  const url = `http://${host}:${actualPort}/`;
  return {
    url,
    host,
    port: actualPort,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: { registryDir?: string; cwd: string; i18n: I18n },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method !== "GET") {
    methodNotAllowed(response);
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    sendHtml(response, renderBoardHtml(context.i18n));
    return;
  }
  if (url.pathname === "/api/health") {
    sendJson(response, { ok: true, service: "loaf-board" });
    return;
  }
  if (url.pathname === "/api/sessions") {
    const scope = parseScope(url.searchParams.get("scope"));
    const snapshot = await buildBoardSnapshot({
      ...(context.registryDir !== undefined && { registryDir: context.registryDir }),
      scope,
      cwd: context.cwd,
    });
    sendJson(response, snapshot);
    return;
  }
  const detailMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (detailMatch) {
    const detail = await buildBoardSessionDetail({
      ...(context.registryDir !== undefined && { registryDir: context.registryDir }),
      sessionId: decodeURIComponent(detailMatch[1]!),
    });
    sendJson(response, detail, detail.ok ? 200 : 404);
    return;
  }
  notFound(response);
}

function parseScope(value: string | null): BoardScope {
  if (value === null || value === "" || value === "all") return "all";
  if (value === "cwd") return "cwd";
  throw new BoardHttpError(400, `invalid scope: ${value}`);
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(html);
}

function sendJson(response: ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function methodNotAllowed(response: ServerResponse): void {
  response.writeHead(405, {
    Allow: "GET",
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end("Method not allowed");
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end("Not found");
}

function sendRouteError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const status = error instanceof BoardHttpError ? error.status : 500;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(
    JSON.stringify({
      ok: false,
      code: status === 400 ? "BAD_REQUEST" : "BOARD_SERVER_ERROR",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export function parseBoardPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new BoardHttpError(400, `invalid board port: ${value}`);
  }
  return port;
}

export function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

export function boardPortFromAddress(address: string | AddressInfo | null, fallback: number): number {
  return typeof address === "object" && address !== null ? address.port : fallback;
}

export class BoardHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "BoardHttpError";
    this.status = status;
  }
}
