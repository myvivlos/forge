import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleHttpRequest } from './src/http.ts';
import { ForgeStore } from './src/store.ts';

/** Build the forge HTTP server backed by a single shared in-memory store. */
export function createApp(): Server {
  const store = new ForgeStore();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handleHttpRequest(req, res, store, expectedToken);
  });

  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  return server;
}
