import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGitRequest, matchGitRoute } from './git.ts';
import { handleGraphqlRequest } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';
import { handleRestRequest } from './rest.ts';
import type { ForgeStore } from './store.ts';

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** Deterministic-format unique request id for X-GitHub-Request-Id. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Write a JSON response with X-GitHub-Request-Id and Content-Length. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): void {
  const payload = `${JSON.stringify(body)}\n`;
  sendRawJson(res, status, payload, headers);
}

/** Write an already-serialized JSON string (hot-path friendly). */
export function sendRawJson(
  res: ServerResponse,
  status: number,
  jsonTextWithNewline: string,
  headers?: Readonly<Record<string, string>>,
): void {
  const len = Buffer.byteLength(jsonTextWithNewline);
  const outHeaders: Record<string, string | number> = {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': len,
    'x-github-request-id': nextRequestId(),
  };
  if (headers !== undefined) {
    for (const [k, v] of Object.entries(headers)) {
      outHeaders[k] = v;
    }
  }
  res.writeHead(status, outHeaders);
  res.end(jsonTextWithNewline);
}

/** Write a 204 No Content response with X-GitHub-Request-Id. */
export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, {
    'x-github-request-id': nextRequestId(),
  });
  res.end();
}

/** Write a GitHub-style JSON error response. */
export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  headers?: Readonly<Record<string, string>>,
): void {
  sendJson(res, status, { message }, headers);
}

/** Check Authorization: Bearer <token> against the expected token. */
export function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  if (expectedToken === '') return true;
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return false;
  const space = auth.indexOf(' ');
  if (space <= 0) return false;
  const scheme = auth.slice(0, space).toLowerCase();
  if (scheme !== 'bearer') return false;
  const presented = auth.slice(space + 1).trim();
  return presented === expectedToken;
}

/** Read the full request body into a Buffer. */
export async function readBodyBuffer(req: IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
    total += buf.length;
    if (total > maxBytes) {
      throw new BodyTooLargeError(`request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return Buffer.alloc(0);
  if (chunks.length === 1) return chunks[0]!;
  return Buffer.concat(chunks, total);
}

export class BodyTooLargeError extends Error {}

export class MalformedJsonError extends Error {}

/** Read and parse a JSON body; returns `{}` on empty body unless `requireNonEmpty` is true. */
export async function readJsonBody(req: IncomingMessage, requireNonEmpty = false): Promise<unknown> {
  const buf = await readBodyBuffer(req);
  const text = buf.toString('utf8').trim();
  if (text === '') {
    if (requireNonEmpty) throw new MalformedJsonError('empty JSON body');
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MalformedJsonError('malformed JSON body');
  }
}

/** Safe URL parser for an incoming request. */
export function parseRequestUrl(req: IncomingMessage): URL {
  const raw = req.url ?? '/';
  try {
    return new URL(raw, 'http://localhost');
  } catch {
    return new URL('/', 'http://localhost');
  }
}

function pathOf(req: IncomingMessage): string {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  const path = q >= 0 ? raw.slice(0, q) : raw;
  return path === '' ? '/' : path;
}

/** Central HTTP request dispatcher for REST v3, MCP, and future Git/GraphQL surfaces. */
export function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  expectedToken: string,
): void {
  const pathname = pathOf(req);
  const method = req.method ?? 'GET';

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    void handleRestRequest(req, res, pathname, store, expectedToken).catch((err) => {
      if (!res.headersSent) {
        sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
      }
    });
    return;
  }

  if (pathname === '/api/graphql') {
    void handleGraphqlRequest(req, res, store, expectedToken).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          errors: [{ message: err instanceof Error ? err.message : 'Internal Server Error' }],
        });
      }
    });
    return;
  }

  if (pathname === '/mcp') {
    void handleMcpRequest(req, res, store, expectedToken).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
        });
      }
    });
    return;
  }

  const gitRoute = matchGitRoute(pathname);
  if (gitRoute !== null) {
    void handleGitRequest(req, res, gitRoute, store, expectedToken).catch((err) => {
      if (!res.headersSent) {
        sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
      }
    });
    return;
  }

  sendError(res, 404, 'Not Found');
}
