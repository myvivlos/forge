import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isValidOid,
  lookupTreePath,
  listCommitHistory,
  parseCommit,
  resolveRefOrSha,
} from './git-objects.ts';
import {
  MalformedJsonError,
  isAuthorized,
  parseRequestUrl,
  readJsonBody,
  sendError,
  sendJson,
  sendNoContent,
  sendRawJson,
} from './http.ts';
import {
  ConflictError,
  ForgeStore,
  MethodNotAllowedError,
  NotFoundError,
  UnprocessableError,
} from './store.ts';
import type { CommentRecord, IssueRecord, LabelRecord, PullRecord, RepoRecord, UserRecord } from './types.ts';

const API_PREFIX = '/api/v3';

function userJson(u: UserRecord) {
  return {
    id: u.id,
    node_id: u.nodeId,
    login: u.login,
    name: u.name,
    email: u.email,
    type: 'User',
  };
}

function repoJson(r: RepoRecord) {
  return {
    id: r.id,
    node_id: r.nodeId,
    name: r.name,
    full_name: r.fullName,
    private: r.isPrivate,
    description: r.description,
    default_branch: r.defaultBranch,
    owner: userJson(r.owner),
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

function labelJson(l: LabelRecord) {
  return {
    id: l.id,
    node_id: l.nodeId,
    name: l.name,
    color: l.color,
    description: l.description,
  };
}

function issueJsonObject(issue: IssueRecord) {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: userJson(issue.user),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

function issueSerialized(issue: IssueRecord): string {
  if (issue.cachedJson === undefined) {
    issue.cachedJson = `${JSON.stringify(issueJsonObject(issue))}\n`;
  }
  return issue.cachedJson;
}

function commentJson(c: CommentRecord) {
  return {
    id: c.id,
    node_id: c.nodeId,
    body: c.body,
    user: userJson(c.user),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

function pullJson(repo: RepoRecord, p: PullRecord) {
  const headSha = p.state === 'open' ? (resolveRefOrSha(repo, p.headRef) ?? p.headSha) : p.headSha;
  const baseSha = p.state === 'open' ? (resolveRefOrSha(repo, p.baseRef) ?? p.baseSha) : p.baseSha;
  return {
    id: p.id,
    node_id: p.nodeId,
    number: p.number,
    state: p.state,
    title: p.title,
    body: p.body,
    head: {
      ref: p.headRef,
      sha: headSha,
      label: `${repo.owner.login}:${p.headRef}`,
    },
    base: {
      ref: p.baseRef,
      sha: baseSha,
      label: `${repo.owner.login}:${p.baseRef}`,
    },
    merged: p.merged,
    merged_at: p.mergedAt,
    merge_commit_sha: p.mergeCommitSha,
    user: userJson(p.user),
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

function paginationParams(url: URL): { readonly page: number; readonly perPage: number } {
  const rawPage = Number(url.searchParams.get('page') ?? '1');
  const rawPerPage = Number(url.searchParams.get('per_page') ?? '30');
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.trunc(rawPage) : 1;
  const perPage = Number.isFinite(rawPerPage) && rawPerPage >= 1 ? Math.min(100, Math.trunc(rawPerPage)) : 30;
  return { page, perPage };
}

function paginate<T>(
  items: readonly T[],
  req: IncomingMessage,
  url: URL,
): { readonly slice: readonly T[]; readonly headers: Record<string, string> } {
  const { page, perPage } = paginationParams(url);
  const start = (page - 1) * perPage;
  const end = start + perPage;
  const slice = items.slice(start, end);
  const headers: Record<string, string> = {};
  if (end < items.length) {
    const host = req.headers.host ?? '127.0.0.1';
    const nextUrl = new URL(`http://${host}${url.pathname}`);
    for (const [k, v] of url.searchParams.entries()) {
      nextUrl.searchParams.set(k, v);
    }
    nextUrl.searchParams.set('per_page', String(perPage));
    nextUrl.searchParams.set('page', String(page + 1));
    headers.link = `<${nextUrl.toString()}>; rel="next"`;
  }
  return { slice, headers };
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new UnprocessableError('Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export async function handleRestRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  store: ForgeStore,
  expectedToken: string,
): Promise<void> {
  if (!isAuthorized(req, expectedToken)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const rel = pathname.slice(API_PREFIX.length);

  // Root: GET /api/v3 or /api/v3/
  if (method === 'GET' && (rel === '' || rel === '/')) {
    sendJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        user_url: '/api/v3/users/{user}',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }

  if (method === 'GET' && rel === '/meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }

  if (method === 'GET' && rel === '/user') {
    sendJson(res, 200, userJson(store.viewer));
    return;
  }

  if (rel === '/user/repos') {
    if (method === 'GET') {
      const url = parseRequestUrl(req);
      const { slice, headers } = paginate(store.viewerRepos, req, url);
      sendJson(res, 200, slice.map(repoJson), headers);
      return;
    }
    if (method === 'POST') {
      try {
        const body = asObject(await readJsonBody(req, true));
        const name = typeof body.name === 'string' ? body.name : '';
        const repo = store.createRepo({
          name,
          description: typeof body.description === 'string' ? body.description : undefined,
          private: typeof body.private === 'boolean' ? body.private : undefined,
          defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : undefined,
        });
        sendJson(res, 201, repoJson(repo));
      } catch (err) {
        handleDomainError(res, err);
      }
      return;
    }
  }

  if (rel.startsWith('/repos/')) {
    const rest = rel.slice('/repos/'.length);
    const parts = rest.split('/');
    if (parts.length < 2 || parts[0] === '' || parts[1] === '') {
      sendError(res, 404, 'Not Found');
      return;
    }
    const owner = safeDecode(parts[0]!);
    const repoName = safeDecode(parts[1]!);
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }

    // Fast path for hot read/write benchmark: /repos/{o}/{r}/issues[/{n}]
    if (parts.length === 4 && parts[2] === 'issues' && method === 'GET') {
      const num = Number(parts[3]);
      if (!Number.isInteger(num) || num <= 0) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const issue = repo.issueByNumber.get(num);
      if (issue === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendRawJson(res, 200, issueSerialized(issue));
      return;
    }

    // /repos/{o}/{r}
    if (parts.length === 2) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        try {
          const body = asObject(await readJsonBody(req));
          store.updateRepo(repo, {
            description: typeof body.description === 'string' ? body.description : undefined,
            private: typeof body.private === 'boolean' ? body.private : undefined,
            defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : undefined,
          });
          sendJson(res, 200, repoJson(repo));
        } catch (err) {
          handleDomainError(res, err);
        }
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        sendNoContent(res);
        return;
      }
    }

    const sub = parts.slice(2);

    // /branches and /branches/{branch}
    if (sub[0] === 'branches') {
      if (sub.length === 1 && method === 'GET') {
        const list = [];
        for (const [refName, oid] of repo.refs) {
          if (!refName.startsWith('refs/heads/')) continue;
          list.push({
            name: refName.slice('refs/heads/'.length),
            commit: { sha: oid },
            protected: false,
          });
        }
        sendJson(res, 200, list);
        return;
      }
      if (sub.length >= 2 && method === 'GET') {
        const branchName = sub.slice(1).map(safeDecode).join('/');
        const oid = repo.refs.get(`refs/heads/${branchName}`);
        if (oid === undefined) {
          sendError(res, 404, 'Branch not found');
          return;
        }
        sendJson(res, 200, { name: branchName, commit: { sha: oid }, protected: false });
        return;
      }
    }

    // /commits
    if (sub.length === 1 && sub[0] === 'commits' && method === 'GET') {
      const url = parseRequestUrl(req);
      const shaParam = url.searchParams.get('sha') ?? repo.defaultBranch;
      const startOid = resolveRefOrSha(repo, shaParam);
      if (startOid === undefined) {
        if (url.searchParams.has('sha')) {
          sendError(res, 404, 'No commit found for SHA');
        } else {
          sendJson(res, 200, []);
        }
        return;
      }
      const history = listCommitHistory(repo, startOid, 500);
      const { slice, headers } = paginate(history, req, url);
      const out = slice.map((oid) => {
        const obj = repo.objects.get(oid)!;
        const parsed = parseCommit(obj.data);
        return {
          sha: oid,
          commit: {
            message: parsed.message.replace(/\n$/, ''),
            author: { name: store.viewer.name, email: store.viewer.email, date: repo.createdAt },
            committer: { name: store.viewer.name, email: store.viewer.email, date: repo.createdAt },
          },
          parents: parsed.parents.map((p) => ({ sha: p })),
        };
      });
      sendJson(res, 200, out, headers);
      return;
    }

    // /git/refs and /git/refs/...
    if (sub[0] === 'git' && (sub[1] === 'refs' || sub[1] === 'ref')) {
      if (sub.length === 2 && sub[1] === 'refs' && method === 'POST') {
        try {
          const body = asObject(await readJsonBody(req, true));
          const rawRef = typeof body.ref === 'string' ? body.ref.trim() : '';
          const sha = typeof body.sha === 'string' ? body.sha.trim().toLowerCase() : '';
          if (rawRef === '' || !isValidOid(sha)) {
            throw new UnprocessableError('Invalid ref or sha');
          }
          const refName = rawRef.startsWith('refs/') ? rawRef : `refs/${rawRef}`;
          if (!repo.objects.has(sha)) {
            throw new UnprocessableError(`Object ${sha} does not exist`);
          }
          if (repo.refs.has(refName)) {
            throw new UnprocessableError(`Reference ${refName} already exists`);
          }
          repo.refs.set(refName, sha);
          repo.shallowPackCache.clear();
          sendJson(res, 201, {
            ref: refName,
            node_id: `ref:${repo.id}:${refName}`,
            object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' },
          });
        } catch (err) {
          handleDomainError(res, err);
        }
        return;
      }
      if (sub.length >= 3 && method === 'GET') {
        const refTail = sub.slice(2).map(safeDecode).join('/');
        const fullRef = refTail.startsWith('refs/') ? refTail : `refs/${refTail}`;
        const oid = repo.refs.get(fullRef);
        if (oid === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, {
          ref: fullRef,
          object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' },
        });
        return;
      }
    }

    // /contents/{path...}
    if (sub[0] === 'contents') {
      const filePath = sub.slice(1).map(safeDecode).join('/');
      if (method === 'GET') {
        const url = parseRequestUrl(req);
        const refParam = url.searchParams.get('ref') ?? repo.defaultBranch;
        const commitOid = resolveRefOrSha(repo, refParam);
        if (commitOid === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const commitObj = repo.objects.get(commitOid);
        if (commitObj === undefined || commitObj.type !== 'commit') {
          sendError(res, 404, 'Not Found');
          return;
        }
        const treeOid = parseCommit(commitObj.data).tree;
        const found = lookupTreePath(repo, treeOid, filePath);
        if (found === null) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (found.kind === 'file') {
          const blob = repo.objects.get(found.oid);
          const data = blob?.data ?? Buffer.alloc(0);
          const baseName = filePath.split('/').pop() ?? filePath;
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name: baseName,
            path: filePath,
            content: data.toString('base64'),
            sha: found.oid,
          });
          return;
        }
        const entries = found.entries.map((entry) => {
          const isDir = entry.mode === '40000' || entry.mode === '040000';
          const entryPath = filePath === '' ? entry.name : `${filePath}/${entry.name}`;
          const size = isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0);
          return {
            type: isDir ? 'dir' : 'file',
            name: entry.name,
            path: entryPath,
            sha: entry.oid,
            size,
          };
        });
        sendJson(res, 200, entries);
        return;
      }
      if (method === 'PUT') {
        try {
          const body = asObject(await readJsonBody(req, true));
          const message = typeof body.message === 'string' ? body.message : '';
          const rawContent = typeof body.content === 'string' ? body.content : '';
          if (message === '' || typeof body.content !== 'string') {
            throw new UnprocessableError('message and base64 content are required');
          }
          const contentBuf = Buffer.from(rawContent.replace(/[\r\n\t ]+/g, ''), 'base64');
          const result = store.putContent(repo, {
            path: filePath,
            content: contentBuf,
            message,
            branch: typeof body.branch === 'string' ? body.branch : undefined,
            sha: typeof body.sha === 'string' ? body.sha : undefined,
          });
          const baseName = filePath.split('/').pop() ?? filePath;
          sendJson(res, result.status, {
            content: {
              name: baseName,
              path: filePath,
              sha: result.contentSha,
              size: contentBuf.length,
              type: 'file',
              encoding: 'base64',
            },
            commit: {
              sha: result.commitSha,
              message,
            },
          });
        } catch (err) {
          handleDomainError(res, err);
        }
        return;
      }
      if (method === 'DELETE') {
        try {
          const body = asObject(await readJsonBody(req, true));
          const message = typeof body.message === 'string' ? body.message : 'delete file';
          const sha = typeof body.sha === 'string' ? body.sha : '';
          if (sha === '') throw new UnprocessableError('sha is required');
          const result = store.deleteContent(repo, {
            path: filePath,
            message,
            sha,
            branch: typeof body.branch === 'string' ? body.branch : undefined,
          });
          sendJson(res, 200, {
            content: null,
            commit: {
              sha: result.commitSha,
              message,
            },
          });
        } catch (err) {
          handleDomainError(res, err);
        }
        return;
      }
    }

    // /labels
    if (sub.length === 1 && sub[0] === 'labels') {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map(labelJson));
        return;
      }
      if (method === 'POST') {
        try {
          const body = asObject(await readJsonBody(req, true));
          const name = typeof body.name === 'string' ? body.name : '';
          const label = store.createLabel(repo, {
            name,
            color: typeof body.color === 'string' ? body.color : undefined,
            description: typeof body.description === 'string' ? body.description : undefined,
          });
          sendJson(res, 201, labelJson(label));
        } catch (err) {
          handleDomainError(res, err);
        }
        return;
      }
    }

    // /issues
    if (sub[0] === 'issues') {
      if (sub.length === 1) {
        if (method === 'POST') {
          try {
            const body = asObject(await readJsonBody(req, true));
            const title = typeof body.title === 'string' ? body.title : '';
            if (title === '') throw new UnprocessableError('title is required');
            const labels = Array.isArray(body.labels)
              ? body.labels.filter((l): l is string => typeof l === 'string')
              : undefined;
            const issue = store.createIssue(repo, {
              title,
              body: typeof body.body === 'string' ? body.body : '',
              labels,
            });
            sendRawJson(res, 201, issueSerialized(issue));
          } catch (err) {
            handleDomainError(res, err);
          }
          return;
        }
        if (method === 'GET') {
          const url = parseRequestUrl(req);
          const stateParam = (url.searchParams.get('state') ?? 'open').toLowerCase();
          const directionParam = (url.searchParams.get('direction') ?? 'desc').toLowerCase();
          let filtered = repo.issues.filter((i) => stateParam === 'all' || i.state === stateParam);
          filtered = directionParam === 'asc' ? [...filtered] : [...filtered].reverse();
          const { slice, headers } = paginate(filtered, req, url);
          sendJson(res, 200, slice.map(issueJsonObject), headers);
          return;
        }
      }
      if (sub.length >= 2) {
        const num = Number(sub[1]);
        if (!Number.isInteger(num) || num <= 0) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const issue = repo.issueByNumber.get(num);
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (sub.length === 2 && method === 'PATCH') {
          try {
            const body = asObject(await readJsonBody(req, true));
            const state = body.state === 'open' || body.state === 'closed' ? body.state : undefined;
            store.updateIssue(repo, num, {
              title: typeof body.title === 'string' ? body.title : undefined,
              body: typeof body.body === 'string' ? body.body : undefined,
              state,
            });
            sendRawJson(res, 200, issueSerialized(issue));
          } catch (err) {
            handleDomainError(res, err);
          }
          return;
        }
        if (sub.length === 3 && sub[2] === 'comments') {
          if (method === 'GET') {
            const url = parseRequestUrl(req);
            const { slice, headers } = paginate(issue.comments, req, url);
            sendJson(res, 200, slice.map(commentJson), headers);
            return;
          }
          if (method === 'POST') {
            try {
              const body = asObject(await readJsonBody(req, true));
              const text = typeof body.body === 'string' ? body.body : '';
              if (text === '') throw new UnprocessableError('comment body is required');
              const comment = store.addComment(repo, num, text)!;
              sendJson(res, 201, commentJson(comment));
            } catch (err) {
              handleDomainError(res, err);
            }
            return;
          }
        }
      }
    }

    // /pulls
    if (sub[0] === 'pulls') {
      if (sub.length === 1) {
        if (method === 'POST') {
          try {
            const body = asObject(await readJsonBody(req, true));
            const title = typeof body.title === 'string' ? body.title : '';
            const head = typeof body.head === 'string' ? body.head : '';
            const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
            if (title === '' || head === '') throw new UnprocessableError('title and head are required');
            const pull = store.createPull(repo, {
              title,
              body: typeof body.body === 'string' ? body.body : '',
              head,
              base,
            });
            sendJson(res, 201, pullJson(repo, pull));
          } catch (err) {
            handleDomainError(res, err);
          }
          return;
        }
        if (method === 'GET') {
          const url = parseRequestUrl(req);
          const stateParam = (url.searchParams.get('state') ?? 'open').toLowerCase();
          const filtered = repo.pulls.filter((p) => stateParam === 'all' || p.state === stateParam);
          const { slice, headers } = paginate(filtered, req, url);
          sendJson(res, 200, slice.map((p) => pullJson(repo, p)), headers);
          return;
        }
      }
      if (sub.length >= 2) {
        const num = Number(sub[1]);
        if (!Number.isInteger(num) || num <= 0) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const pull = repo.pullByNumber.get(num);
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (sub.length === 2 && method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
        if (sub.length === 2 && method === 'PATCH') {
          try {
            const body = asObject(await readJsonBody(req, true));
            const state = body.state === 'open' || body.state === 'closed' ? body.state : undefined;
            store.updatePull(repo, num, {
              title: typeof body.title === 'string' ? body.title : undefined,
              body: typeof body.body === 'string' ? body.body : undefined,
              state,
              base: typeof body.base === 'string' ? body.base : undefined,
            });
            sendJson(res, 200, pullJson(repo, pull));
          } catch (err) {
            handleDomainError(res, err);
          }
          return;
        }
        if (sub.length === 3 && sub[2] === 'files' && method === 'GET') {
          const files = store.getPullFiles(repo, pull);
          sendJson(res, 200, files);
          return;
        }
        if (sub.length === 3 && sub[2] === 'merge' && method === 'PUT') {
          try {
            const body = asObject(await readJsonBody(req, false));
            const result = store.mergePull(repo, pull, {
              commitTitle: typeof body.commit_title === 'string' ? body.commit_title : undefined,
              commitMessage: typeof body.commit_message === 'string' ? body.commit_message : undefined,
              mergeMethod: typeof body.merge_method === 'string' ? body.merge_method : undefined,
            });
            sendJson(res, 200, result);
          } catch (err) {
            handleDomainError(res, err);
          }
          return;
        }
      }
    }
  }

  sendError(res, 404, 'Not Found');
}

function handleDomainError(res: ServerResponse, err: unknown): void {
  if (err instanceof MalformedJsonError) {
    sendError(res, 400, 'Problems parsing JSON');
  } else if (err instanceof NotFoundError) {
    sendError(res, 404, err.message || 'Not Found');
  } else if (err instanceof ConflictError) {
    sendError(res, 409, err.message || 'Conflict');
  } else if (err instanceof UnprocessableError) {
    sendError(res, 422, err.message || 'Validation Failed');
  } else if (err instanceof MethodNotAllowedError) {
    sendError(res, 405, err.message || 'Method Not Allowed');
  } else {
    sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
  }
}
