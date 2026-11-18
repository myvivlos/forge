import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  isAncestor,
  isValidOid,
  parseCommit,
  parseTag,
  parseTree,
  peelOid,
} from './git-objects.ts';
import { isAuthorized, parseRequestUrl, readBodyBuffer, sendError } from './http.ts';
import {
  PKT_FLUSH,
  PackError,
  PktLineError,
  encodePktLines,
  encodeSideband,
  parsePktLineStream,
  readPack,
  writePack,
} from './pack.ts';
import type { ForgeStore } from './store.ts';
import type { GitObjectRecord, RepoRecord } from './types.ts';

const SERVICE_UPLOAD_PACK = 'git-upload-pack';
const SERVICE_RECEIVE_PACK = 'git-receive-pack';
const AGENT_STRING = 'entry-forge/1.0';
const MAX_SHALLOW_CACHE_ENTRIES = 16;

/** Static protocol v2 capability advertisement (does not depend on repo state). */
const V2_UPLOAD_PACK_ADV = encodePktLines([
  'version 2\n',
  `agent=${AGENT_STRING}\n`,
  'ls-refs=unborn\n',
  'fetch=shallow\n',
  'object-format=sha1\n',
  'flush',
]);

function sendGitBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

function isProtocolV2Request(req: IncomingMessage): boolean {
  const header = req.headers['git-protocol'];
  if (typeof header !== 'string') return false;
  return header.split(':').some((part) => part.trim() === 'version=2');
}

function sortedRefEntries(repo: RepoRecord): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function buildUploadPackV0Advertisement(repo: RepoRecord): Buffer {
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const caps = [
    'multi_ack_detailed',
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'shallow',
    'no-progress',
    'include-tag',
    `symref=HEAD:${headTarget}`,
    'object-format=sha1',
    `agent=${AGENT_STRING}`,
  ].join(' ');

  const lines: Array<string | 'flush'> = [`# service=${SERVICE_UPLOAD_PACK}\n`, 'flush'];
  if (repo.refs.size === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`, 'flush');
    return encodePktLines(lines);
  }

  let sentCaps = false;
  const headOid = repo.refs.get(headTarget);
  if (headOid !== undefined) {
    lines.push(`${headOid} HEAD\0${caps}\n`);
    sentCaps = true;
  }
  for (const [name, oid] of sortedRefEntries(repo)) {
    if (!sentCaps) {
      lines.push(`${oid} ${name}\0${caps}\n`);
      sentCaps = true;
    } else {
      lines.push(`${oid} ${name}\n`);
    }
    if (repo.objects.get(oid)?.type === 'tag') {
      const peeled = peelOid(repo, oid);
      if (peeled !== undefined) {
        lines.push(`${peeled} ${name}^{}\n`);
      }
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function buildReceivePackAdvertisement(repo: RepoRecord): Buffer {
  const caps = [
    'report-status',
    'report-status-v2',
    'delete-refs',
    'side-band-64k',
    'ofs-delta',
    `agent=${AGENT_STRING}`,
  ].join(' ');

  const lines: Array<string | 'flush'> = [`# service=${SERVICE_RECEIVE_PACK}\n`, 'flush'];
  if (repo.refs.size === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`, 'flush');
    return encodePktLines(lines);
  }

  let first = true;
  for (const [name, oid] of sortedRefEntries(repo)) {
    if (first) {
      lines.push(`${oid} ${name}\0${caps}\n`);
      first = false;
    } else {
      lines.push(`${oid} ${name}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function handleLsRefs(repo: RepoRecord, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];

  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }

  const matchesPrefix = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const lines: Array<string | 'flush'> = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (matchesPrefix('HEAD')) {
    if (headOid !== undefined) {
      lines.push(symrefs ? `${headOid} HEAD symref-target:${headTarget}\n` : `${headOid} HEAD\n`);
    } else if (unborn) {
      lines.push(symrefs ? `unborn HEAD symref-target:${headTarget}\n` : 'unborn HEAD\n');
    }
  }

  for (const [name, oid] of sortedRefEntries(repo)) {
    if (!matchesPrefix(name)) continue;
    let line = `${oid} ${name}`;
    if (peel && repo.objects.get(oid)?.type === 'tag') {
      const peeled = peelOid(repo, oid);
      if (peeled !== undefined) {
        line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function collectHaveClosure(
  repo: RepoRecord,
  haves: readonly string[],
  clientShallowSet: ReadonlySet<string>,
): Set<string> {
  const haveSet = new Set<string>();
  const stack: string[] = [];
  for (const oid of haves) {
    if (repo.objects.has(oid)) stack.push(oid);
  }
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (haveSet.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    haveSet.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      if (commit.tree !== '') stack.push(commit.tree);
      if (!clientShallowSet.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag.object !== '') stack.push(tag.object);
    }
  }
  return haveSet;
}

function collectTreeAndBlobs(
  repo: RepoRecord,
  treeOid: string,
  haveSet: ReadonlySet<string>,
  sentSet: Set<string>,
  out: GitObjectRecord[],
): void {
  if (treeOid === '' || haveSet.has(treeOid) || sentSet.has(treeOid)) return;
  const stack: string[] = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (haveSet.has(oid) || sentSet.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    sentSet.add(oid);
    out.push(obj);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        if (!haveSet.has(entry.oid) && !sentSet.has(entry.oid)) {
          stack.push(entry.oid);
        }
      }
    }
  }
}

interface FetchPlan {
  readonly objects: GitObjectRecord[];
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly acks: string[];
}

function computeFetchPlan(
  repo: RepoRecord,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const clientShallowSet = new Set(clientShallow);
  const haveSet = collectHaveClosure(repo, haves, clientShallowSet);
  const acks = haves.filter((oid) => repo.objects.has(oid));

  const sentSet = new Set<string>();
  const objects: GitObjectRecord[] = [];
  const newShallow: string[] = [];
  const unshallow: string[] = [];

  if (depth !== undefined) {
    const maxDepth = Math.max(1, depth);
    const bfsQueue: Array<{ readonly oid: string; readonly d: number }> = [];
    const bestDepth = new Map<string, number>();

    for (const want of wants) {
      let cur = want;
      for (let i = 0; i < 16; i += 1) {
        const obj = repo.objects.get(cur);
        if (obj === undefined) break;
        if (obj.type === 'tag') {
          if (!haveSet.has(cur) && !sentSet.has(cur)) {
            sentSet.add(cur);
            objects.push(obj);
          }
          cur = parseTag(obj.data).object;
          continue;
        }
        if (obj.type === 'commit') {
          if (!bestDepth.has(cur)) {
            bestDepth.set(cur, 1);
            bfsQueue.push({ oid: cur, d: 1 });
          }
        } else {
          collectTreeAndBlobs(repo, cur, haveSet, sentSet, objects);
        }
        break;
      }
    }

    const newShallowSet = new Set<string>();
    const includedCommits: string[] = [];
    for (let head = 0; head < bfsQueue.length; head += 1) {
      const item = bfsQueue[head]!;
      if (item.d > maxDepth) continue;
      const obj = repo.objects.get(item.oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      includedCommits.push(item.oid);
      const commit = parseCommit(obj.data);
      if (item.d === maxDepth) {
        if (commit.parents.length > 0) {
          newShallowSet.add(item.oid);
        }
      } else {
        for (const parent of commit.parents) {
          if (!bestDepth.has(parent)) {
            bestDepth.set(parent, item.d + 1);
            bfsQueue.push({ oid: parent, d: item.d + 1 });
          }
        }
      }
    }

    for (const oid of newShallowSet) newShallow.push(oid);
    for (const oldShallow of clientShallow) {
      if (bestDepth.has(oldShallow) && !newShallowSet.has(oldShallow)) {
        unshallow.push(oldShallow);
      }
    }

    for (const commitOid of includedCommits) {
      if (haveSet.has(commitOid) || sentSet.has(commitOid)) continue;
      const obj = repo.objects.get(commitOid);
      if (obj === undefined || obj.type !== 'commit') continue;
      sentSet.add(commitOid);
      objects.push(obj);
      const commit = parseCommit(obj.data);
      collectTreeAndBlobs(repo, commit.tree, haveSet, sentSet, objects);
    }

    return { objects, shallow: newShallow, unshallow, acks };
  }

  // Non-shallow fetch: traverse all reachable objects excluding `haveSet` and stopping at `clientShallowSet`.
  const stack: string[] = [];
  for (const want of wants) {
    if (!haveSet.has(want) && !sentSet.has(want)) {
      stack.push(want);
    }
  }

  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (haveSet.has(oid) || sentSet.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    sentSet.add(oid);
    objects.push(obj);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      if (commit.tree !== '' && !haveSet.has(commit.tree) && !sentSet.has(commit.tree)) {
        stack.push(commit.tree);
      }
      if (!clientShallowSet.has(oid)) {
        for (const parent of commit.parents) {
          if (!haveSet.has(parent) && !sentSet.has(parent)) {
            stack.push(parent);
          }
        }
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        if (!haveSet.has(entry.oid) && !sentSet.has(entry.oid)) {
          stack.push(entry.oid);
        }
      }
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag.object !== '' && !haveSet.has(tag.object) && !sentSet.has(tag.object)) {
        stack.push(tag.object);
      }
    }
  }

  return { objects, shallow: newShallow, unshallow, acks };
}

function handleFetchV2(repo: RepoRecord, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | undefined;
  let done = false;

  for (const arg of args) {
    if (arg.startsWith('want ')) {
      const oid = arg.slice(5).trim();
      if (!isValidOid(oid) || !repo.objects.has(oid)) {
        return encodePktLines([`ERR want ${oid} not valid\n`, 'flush']);
      }
      wants.push(oid);
    } else if (arg.startsWith('have ')) {
      const oid = arg.slice(5).trim();
      if (isValidOid(oid)) haves.push(oid);
    } else if (arg.startsWith('shallow ')) {
      const oid = arg.slice(8).trim();
      if (isValidOid(oid)) clientShallow.push(oid);
    } else if (arg.startsWith('deepen ')) {
      const parsed = Number.parseInt(arg.slice(7).trim(), 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return encodePktLines(['ERR invalid deepen value\n', 'flush']);
      }
      depth = parsed;
    } else if (arg === 'done') {
      done = true;
    }
  }

  if (!done) {
    const ackLines: Array<string | 'flush'> = ['acknowledgments\n'];
    let anyAck = false;
    for (const have of haves) {
      if (repo.objects.has(have)) {
        ackLines.push(`ACK ${have}\n`);
        anyAck = true;
      }
    }
    if (!anyAck) ackLines.push('NAK\n');
    ackLines.push('flush');
    return encodePktLines(ackLines);
  }

  const canCache = haves.length === 0 && clientShallow.length === 0;
  const cacheKey = canCache ? `v2:${wants.join(',')}:d=${depth ?? ''}` : '';
  if (canCache) {
    const cached = repo.shallowPackCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  const plan = computeFetchPlan(repo, wants, haves, clientShallow, depth);
  const pack = writePack(plan.objects);
  const parts: Array<string | Buffer | 'flush' | 'delim'> = [];

  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push('shallow-info\n');
    for (const oid of plan.shallow) parts.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) parts.push(`unshallow ${oid}\n`);
    parts.push('delim');
  }

  parts.push('packfile\n');
  for (const pkt of encodeSideband(1, pack)) {
    parts.push(pkt);
  }

  // Sideband packets are already pkt-lined; assemble final response cleanly.
  const prePack: Array<string | 'delim'> = [];
  for (let i = 0; i < parts.length; i += 1) {
    const item = parts[i]!;
    if (typeof item === 'string') prePack.push(item);
    else break;
  }
  const headBuf = encodePktLines(prePack);
  const sidebandBufs = parts.slice(prePack.length) as Buffer[];
  const response = Buffer.concat([headBuf, ...sidebandBufs, PKT_FLUSH]);

  if (canCache) {
    if (repo.shallowPackCache.size >= MAX_SHALLOW_CACHE_ENTRIES) {
      repo.shallowPackCache.clear();
    }
    repo.shallowPackCache.set(cacheKey, response);
  }
  return response;
}

function handleUploadPackV0(repo: RepoRecord, packets: ReturnType<typeof parsePktLineStream>['packets']): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | undefined;
  let done = false;
  let inFirstSection = true;

  for (const pkt of packets) {
    if (pkt.kind === 'flush') {
      inFirstSection = false;
      continue;
    }
    if (pkt.kind !== 'data') continue;
    const line = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (inFirstSection) {
      if (line.startsWith('want ')) {
        const oid = line.slice(5).split(' ')[0] ?? '';
        if (!isValidOid(oid) || !repo.objects.has(oid)) {
          return encodePktLines([`ERR want ${oid} not valid\n`, 'flush']);
        }
        wants.push(oid);
      } else if (line.startsWith('shallow ')) {
        const oid = line.slice(8).trim();
        if (isValidOid(oid)) clientShallow.push(oid);
      } else if (line.startsWith('deepen ')) {
        const parsed = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(parsed) && parsed >= 1) depth = parsed;
      }
    } else {
      if (line.startsWith('have ')) {
        const oid = line.slice(5).trim();
        if (isValidOid(oid)) haves.push(oid);
      } else if (line === 'done') {
        done = true;
      }
    }
  }

  if (!done) {
    return encodePktLines(['NAK\n', 'flush']);
  }

  const plan = computeFetchPlan(repo, wants, haves, clientShallow, depth);
  const pack = writePack(plan.objects);
  const preLines: Array<string | 'flush'> = [];
  for (const oid of plan.shallow) preLines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) preLines.push(`unshallow ${oid}\n`);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    preLines.push('flush');
  }
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) preLines.push(`ACK ${ack}\n`);
  } else {
    preLines.push('NAK\n');
  }

  const headerBuf = encodePktLines(preLines);
  const sidebandBufs = encodeSideband(1, pack);
  return Buffer.concat([headerBuf, ...sidebandBufs, PKT_FLUSH]);
}

function handleUploadPackPost(req: IncomingMessage, repo: RepoRecord, body: Buffer): { readonly status: number; readonly body: Buffer } {
  let packets;
  try {
    packets = parsePktLineStream(body, false).packets;
  } catch (err) {
    const msg = err instanceof PktLineError ? err.message : 'invalid pkt-line';
    return { status: 400, body: encodePktLines([`ERR ${msg}\n`, 'flush']) };
  }

  const firstData = packets.find((p) => p.kind === 'data');
  const firstText = firstData && firstData.kind === 'data' ? firstData.payload.toString('utf8').replace(/\n$/, '') : '';
  const isV2 = isProtocolV2Request(req) || firstText.startsWith('command=');

  if (!isV2) {
    return { status: 200, body: handleUploadPackV0(repo, packets) };
  }

  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const pkt of packets) {
    if (pkt.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (pkt.kind === 'flush') break;
    if (pkt.kind !== 'data') continue;
    const line = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (line.startsWith('command=')) {
        command = line.slice('command='.length);
      }
    } else {
      args.push(line);
    }
  }

  if (command === 'ls-refs') {
    return { status: 200, body: handleLsRefs(repo, args) };
  }
  if (command === 'fetch') {
    return { status: 200, body: handleFetchV2(repo, args) };
  }
  return { status: 400, body: encodePktLines([`ERR unknown command ${command}\n`, 'flush']) };
}

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function handleReceivePackPost(store: ForgeStore, repo: RepoRecord, body: Buffer): { readonly status: number; readonly body: Buffer } {
  let packets;
  let packOffset: number;
  try {
    const parsed = parsePktLineStream(body, true);
    packets = parsed.packets;
    packOffset = parsed.restOffset;
  } catch (err) {
    const msg = err instanceof PktLineError ? err.message : 'invalid pkt-line';
    return { status: 400, body: encodePktLines([`ERR ${msg}\n`, 'flush']) };
  }

  const commands: PushCommand[] = [];
  const caps = new Set<string>();
  let firstCmd = true;

  for (const pkt of packets) {
    if (pkt.kind !== 'data') continue;
    let line = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (firstCmd) {
      firstCmd = false;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        for (const cap of line.slice(nul + 1).split(' ')) {
          if (cap !== '') caps.add(cap);
        }
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length !== 3) {
      return { status: 400, body: encodePktLines(['ERR malformed receive-pack command\n', 'flush']) };
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }

  const wantsSideband = caps.has('side-band-64k');
  const packBytes = body.subarray(packOffset);

  const formatReport = (reportLines: Array<string | 'flush'>): Buffer => {
    const encoded = encodePktLines(reportLines);
    if (!wantsSideband) return encoded;
    return Buffer.concat([...encodeSideband(1, encoded), PKT_FLUSH]);
  };

  if (packBytes.length > 0) {
    try {
      const unpacked = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of unpacked) {
        if (!repo.objects.has(oid)) {
          repo.objects.set(oid, obj);
        }
      }
    } catch (err) {
      const msg = err instanceof PackError ? err.message : 'unpack failed';
      const reportLines: Array<string | 'flush'> = [`unpack error ${msg}\n`];
      for (const cmd of commands) {
        reportLines.push(`ng ${cmd.ref} unpack failed\n`);
      }
      reportLines.push('flush');
      return { status: 200, body: formatReport(reportLines) };
    }
  }

  const reportLines: Array<string | 'flush'> = ['unpack ok\n'];
  let refsChanged = false;

  for (const cmd of commands) {
    if (!isValidOid(cmd.oldOid) || !isValidOid(cmd.newOid) || !cmd.ref.startsWith('refs/')) {
      reportLines.push(`ng ${cmd.ref} invalid ref or oid\n`);
      continue;
    }
    const currentOid = repo.refs.get(cmd.ref);

    if (cmd.newOid === ZERO_OID) {
      if (currentOid === undefined || (cmd.oldOid !== ZERO_OID && cmd.oldOid !== currentOid)) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.delete(cmd.ref);
      refsChanged = true;
      reportLines.push(`ok ${cmd.ref}\n`);
      continue;
    }

    if (!repo.objects.has(cmd.newOid)) {
      reportLines.push(`ng ${cmd.ref} missing object\n`);
      continue;
    }

    if (cmd.oldOid === ZERO_OID) {
      if (currentOid !== undefined) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      refsChanged = true;
      reportLines.push(`ok ${cmd.ref}\n`);
      continue;
    }

    if (currentOid === undefined || currentOid !== cmd.oldOid) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }

    const oldTarget = peelOid(repo, currentOid) ?? currentOid;
    const newTarget = peelOid(repo, cmd.newOid) ?? cmd.newOid;
    if (!isAncestor(repo, oldTarget, newTarget)) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }

    repo.refs.set(cmd.ref, cmd.newOid);
    refsChanged = true;
    reportLines.push(`ok ${cmd.ref}\n`);
  }

  if (refsChanged) {
    repo.shallowPackCache.clear();
    repo.updatedAt = store.nextTimestamp().iso;
  }

  reportLines.push('flush');
  return { status: 200, body: formatReport(reportLines) };
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export interface GitRouteMatch {
  readonly owner: string;
  readonly repoName: string;
  readonly action: 'info/refs' | 'git-upload-pack' | 'git-receive-pack';
}

const GIT_PATH_RE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function matchGitRoute(pathname: string): GitRouteMatch | null {
  const m = GIT_PATH_RE.exec(pathname);
  if (m === null) return null;
  return {
    owner: safeDecode(m[1]!),
    repoName: safeDecode(m[2]!),
    action: m[3] as GitRouteMatch['action'],
  };
}

/** Handle Git smart HTTP requests (`info/refs`, `git-upload-pack`, `git-receive-pack`). */
export async function handleGitRequest(
  req: IncomingMessage,
  res: ServerResponse,
  route: GitRouteMatch,
  store: ForgeStore,
  expectedToken: string,
): Promise<void> {
  if (!isAuthorized(req, expectedToken)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }

  const repo = store.getRepo(route.owner, route.repoName);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }

  const method = (req.method ?? 'GET').toUpperCase();

  if (route.action === 'info/refs' && method === 'GET') {
    const url = parseRequestUrl(req);
    const service = url.searchParams.get('service');
    if (service === SERVICE_UPLOAD_PACK) {
      const body = isProtocolV2Request(req) ? V2_UPLOAD_PACK_ADV : buildUploadPackV0Advertisement(repo);
      sendGitBytes(res, 200, 'application/x-git-upload-pack-advertisement', body);
      return;
    }
    if (service === SERVICE_RECEIVE_PACK) {
      const body = buildReceivePackAdvertisement(repo);
      sendGitBytes(res, 200, 'application/x-git-receive-pack-advertisement', body);
      return;
    }
    sendError(res, 403, 'Unsupported git service');
    return;
  }

  if (route.action === SERVICE_UPLOAD_PACK && method === 'POST') {
    const body = await readBodyBuffer(req, 64 * 1024 * 1024);
    const reply = handleUploadPackPost(req, repo, body);
    sendGitBytes(res, reply.status, 'application/x-git-upload-pack-result', reply.body);
    return;
  }

  if (route.action === SERVICE_RECEIVE_PACK && method === 'POST') {
    const body = await readBodyBuffer(req, 64 * 1024 * 1024);
    const reply = handleReceivePackPost(store, repo, body);
    sendGitBytes(res, reply.status, 'application/x-git-receive-pack-result', reply.body);
    return;
  }

  sendError(res, 404, 'Not Found');
}
