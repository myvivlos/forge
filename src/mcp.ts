import type { IncomingMessage, ServerResponse } from 'node:http';
import { MalformedJsonError, isAuthorized, readJsonBody, sendJson } from './http.ts';
import { ForgeStore, MethodNotAllowedError, UnprocessableError } from './store.ts';

interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, { readonly type: string; readonly description: string }>>;
    readonly required: readonly string[];
  };
}

const TOOLS: readonly McpToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get repository metadata by owner and repository name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request between two branches in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

const TOOLS_BY_NAME = new Map<string, McpToolDef>(TOOLS.map((t) => [t.name, t]));

const SERVER_INFO = Object.freeze({ name: 'entry-forge', version: '1.0.0' });
const SUPPORTED_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18']);

function sendMcpReply(req: IncomingMessage, res: ServerResponse, status: number, payload: unknown): void {
  const accept = (req.headers.accept ?? '').toLowerCase();
  const wantsSseOnly =
    status === 200 &&
    accept.includes('text/event-stream') &&
    !accept.includes('application/json') &&
    !accept.includes('*/*');
  if (wantsSseOnly) {
    const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }
  sendJson(res, status, payload);
}

function rpcSuccess(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function toolOk(payload: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolErr(message: string) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function reqString(args: Record<string, unknown>, key: string): string | null {
  const val = args[key];
  return typeof val === 'string' && val.trim() !== '' ? val : null;
}

function reqInt(args: Record<string, unknown>, key: string): number | null {
  const val = args[key];
  if (typeof val === 'number' && Number.isInteger(val) && val > 0) return val;
  if (typeof val === 'string' && /^\d+$/.test(val)) {
    const n = Number(val);
    return n > 0 ? n : null;
  }
  return null;
}

function executeTool(store: ForgeStore, name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'create_repo': {
      const repoName = reqString(args, 'name');
      if (repoName === null) throw new InvalidParamsError('missing required argument: name');
      const repo = store.createRepo({
        name: repoName,
        description: typeof args.description === 'string' ? args.description : undefined,
        private: typeof args.private === 'boolean' ? args.private : undefined,
      });
      return toolOk({
        id: repo.id,
        node_id: repo.nodeId,
        name: repo.name,
        full_name: repo.fullName,
        private: repo.isPrivate,
        description: repo.description,
        default_branch: repo.defaultBranch,
        owner: { login: repo.owner.login, id: repo.owner.id },
      });
    }
    case 'get_repo': {
      const owner = reqString(args, 'owner');
      const repoName = reqString(args, 'repo');
      if (owner === null || repoName === null) throw new InvalidParamsError('missing required arguments: owner, repo');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`Repository ${owner}/${repoName} not found`);
      return toolOk({
        id: repo.id,
        node_id: repo.nodeId,
        name: repo.name,
        full_name: repo.fullName,
        private: repo.isPrivate,
        description: repo.description,
        default_branch: repo.defaultBranch,
        owner: { login: repo.owner.login, id: repo.owner.id },
      });
    }
    case 'create_issue': {
      const owner = reqString(args, 'owner');
      const repoName = reqString(args, 'repo');
      const title = reqString(args, 'title');
      if (owner === null || repoName === null || title === null) {
        throw new InvalidParamsError('missing required arguments: owner, repo, title');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`Repository ${owner}/${repoName} not found`);
      const issue = store.createIssue(repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
      });
      return toolOk({
        id: issue.id,
        node_id: issue.nodeId,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
      });
    }
    case 'list_issues': {
      const owner = reqString(args, 'owner');
      const repoName = reqString(args, 'repo');
      if (owner === null || repoName === null) {
        throw new InvalidParamsError('missing required arguments: owner, repo');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const items = repo.issues
        .filter((i) => state === 'all' || i.state === state)
        .map((i) => ({
          id: i.id,
          node_id: i.nodeId,
          number: i.number,
          title: i.title,
          body: i.body,
          state: i.state,
        }));
      return toolOk(items);
    }
    case 'create_pull_request': {
      const owner = reqString(args, 'owner');
      const repoName = reqString(args, 'repo');
      const title = reqString(args, 'title');
      const head = reqString(args, 'head');
      const base = reqString(args, 'base');
      if (owner === null || repoName === null || title === null || head === null || base === null) {
        throw new InvalidParamsError('missing required arguments: owner, repo, title, head, base');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`Repository ${owner}/${repoName} not found`);
      const pull = store.createPull(repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
      });
      return toolOk({
        id: pull.id,
        node_id: pull.nodeId,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
      });
    }
    case 'merge_pull_request': {
      const owner = reqString(args, 'owner');
      const repoName = reqString(args, 'repo');
      const pullNumber = reqInt(args, 'pull_number');
      if (owner === null || repoName === null || pullNumber === null) {
        throw new InvalidParamsError('missing required arguments: owner, repo, pull_number');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`Repository ${owner}/${repoName} not found`);
      const pull = repo.pullByNumber.get(pullNumber);
      if (pull === undefined) return toolErr(`Pull request #${pullNumber} not found`);
      const result = store.mergePull(repo, pull, { mergeMethod: 'squash' });
      return toolOk(result);
    }
    default:
      throw new MethodNotFoundError(`Unknown tool: ${name}`);
  }
}

class InvalidParamsError extends Error {}
class MethodNotFoundError extends Error {}

export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  expectedToken: string,
): Promise<void> {
  if (!isAuthorized(req, expectedToken)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  const method = (req.method ?? 'POST').toUpperCase();
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = await readJsonBody(req, true);
  } catch (err) {
    if (err instanceof MalformedJsonError) {
      sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
      return;
    }
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }

  const msg = asRecord(parsed);
  if (msg === null || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    sendJson(res, 400, rpcError(msg?.id ?? null, -32600, 'Invalid Request'));
    return;
  }

  const id = msg.id;
  const rpcMethod = msg.method;
  const params = asRecord(msg.params) ?? {};

  // Notification (no id)
  if (id === undefined) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }

  switch (rpcMethod) {
    case 'server/discover': {
      sendMcpReply(req, res, 200, rpcSuccess(id, {
        resultType: 'discover',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }));
      return;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      sendMcpReply(req, res, 200, rpcSuccess(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }));
      return;
    }
    case 'ping': {
      sendMcpReply(req, res, 200, rpcSuccess(id, {}));
      return;
    }
    case 'tools/list': {
      sendMcpReply(req, res, 200, rpcSuccess(id, { tools: TOOLS }));
      return;
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = asRecord(params.arguments) ?? {};
      if (toolName === '' || !TOOLS_BY_NAME.has(toolName)) {
        sendMcpReply(req, res, 200, rpcError(id, -32601, `Unknown tool: ${toolName}`));
        return;
      }
      try {
        const result = executeTool(store, toolName, toolArgs);
        sendMcpReply(req, res, 200, rpcSuccess(id, result));
      } catch (err) {
        if (err instanceof InvalidParamsError) {
          sendMcpReply(req, res, 200, rpcError(id, -32602, err.message));
        } else if (err instanceof MethodNotFoundError) {
          sendMcpReply(req, res, 200, rpcError(id, -32601, err.message));
        } else if (err instanceof UnprocessableError || err instanceof MethodNotAllowedError) {
          sendMcpReply(req, res, 200, rpcSuccess(id, toolErr(err.message)));
        } else {
          sendMcpReply(req, res, 200, rpcSuccess(id, toolErr(err instanceof Error ? err.message : String(err))));
        }
      }
      return;
    }
    default: {
      sendMcpReply(req, res, 200, rpcError(id, -32601, `Method not found: ${rpcMethod}`));
      return;
    }
  }
}
