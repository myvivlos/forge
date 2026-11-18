import { createHash } from 'node:crypto';
import type {
  GitObjectRecord,
  GitObjectType,
  ParsedCommit,
  ParsedTag,
  PullFileDiff,
  RepoRecord,
  TreeEntry,
} from './types.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

export function isValidOid(oid: string): boolean {
  return OID_RE.test(oid);
}

/** Compute the 40-char lowercase SHA-1 git object id. */
export function hashGitObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store a git object into a repository map if not already present, returning its OID. */
export function putGitObject(repo: RepoRecord, type: GitObjectType, data: Buffer): string {
  const oid = hashGitObject(type, data);
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { type, data });
  }
  return oid;
}

/** Canonical Git tree entry sort comparison (directories sort as `${name}/`). */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const aKey = a.mode === '40000' || a.mode === '040000' ? `${a.name}/` : a.name;
  const bKey = b.mode === '40000' || b.mode === '040000' ? `${b.name}/` : b.name;
  const aBuf = Buffer.from(aKey, 'utf8');
  const bBuf = Buffer.from(bKey, 'utf8');
  return aBuf.compare(bBuf);
}

/** Build a canonical binary Git tree object from entries. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    const mode = entry.mode === '040000' ? '40000' : entry.mode;
    chunks.push(Buffer.from(`${mode} ${entry.name}\0`, 'utf8'));
    chunks.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

/** Parse a binary Git tree object into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('corrupt tree: missing space');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('corrupt tree: missing nul');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oidStart = nul + 1;
    if (oidStart + 20 > data.length) throw new Error('corrupt tree: truncated oid');
    const oid = data.subarray(oidStart, oidStart + 20).toString('hex');
    entries.push({ mode, name, oid });
    offset = oidStart + 20;
  }
  return entries;
}

/** Build a Git commit object payload. */
export function buildCommit(options: {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly timestampSec: number;
  readonly message: string;
}): Buffer {
  const lines: string[] = [`tree ${options.tree}`];
  for (const parent of options.parents) {
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${options.author} ${options.timestampSec} +0000`);
  lines.push(`committer ${options.committer} ${options.timestampSec} +0000`);
  const msg = options.message.endsWith('\n') ? options.message : `${options.message}\n`;
  lines.push('');
  lines.push(msg);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Parse a Git commit object payload. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const headerText = sep < 0 ? text : text.slice(0, sep);
  const message = sep < 0 ? '' : text.slice(sep + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Parse a Git annotated tag object payload. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const headerText = sep < 0 ? text : text.slice(0, sep);
  const message = sep < 0 ? '' : text.slice(sep + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5) as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Peel an annotated tag (possibly chained) to the underlying non-tag object OID. */
export function peelOid(repo: RepoRecord, oid: string): string | undefined {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return undefined;
    if (obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

/** Resolve a branch, tag, full ref name, or commit SHA in a repository to a commit OID. */
export function resolveRefOrSha(repo: RepoRecord, refOrSha: string): string | undefined {
  if (repo.refs.has(refOrSha)) {
    return peelOid(repo, repo.refs.get(refOrSha)!);
  }
  const asHead = `refs/heads/${refOrSha}`;
  if (repo.refs.has(asHead)) {
    return peelOid(repo, repo.refs.get(asHead)!);
  }
  const asTag = `refs/tags/${refOrSha}`;
  if (repo.refs.has(asTag)) {
    return peelOid(repo, repo.refs.get(asTag)!);
  }
  const lower = refOrSha.toLowerCase();
  if (isValidOid(lower) && repo.objects.has(lower)) {
    return peelOid(repo, lower);
  }
  return undefined;
}

/** Walk tree objects recursively, returning path -> { mode, oid } for all blobs. */
export function flattenTree(repo: RepoRecord, treeOid: string): Map<string, { mode: string; oid: string }> {
  const files = new Map<string, { mode: string; oid: string }>();
  const visit = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const fullPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') {
        visit(entry.oid, fullPath);
      } else {
        files.set(fullPath, { mode: entry.mode, oid: entry.oid });
      }
    }
  };
  if (treeOid !== '') visit(treeOid, '');
  return files;
}

/** Build nested Git tree objects from a flat path -> { mode, oid } map and store them in `repo`. */
export function buildTreeFromFlatFiles(
  repo: RepoRecord,
  files: ReadonlyMap<string, { readonly mode: string; readonly oid: string }>,
): string {
  interface DirNode {
    readonly files: Map<string, { mode: string; oid: string }>;
    readonly dirs: Map<string, DirNode>;
  }
  const makeDir = (): DirNode => ({ files: new Map(), dirs: new Map() });
  const root = makeDir();
  for (const [path, info] of files) {
    const parts = path.split('/').filter((p) => p !== '');
    if (parts.length === 0) continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const seg = parts[i]!;
      let child = node.dirs.get(seg);
      if (child === undefined) {
        child = makeDir();
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1]!, { mode: info.mode, oid: info.oid });
  }
  const persist = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, info] of node.files) {
      entries.push({ mode: info.mode, name, oid: info.oid });
    }
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', name, oid: persist(child) });
    }
    const buf = buildTree(entries);
    return putGitObject(repo, 'tree', buf);
  };
  return persist(root);
}

/** Walk tree at `treeOid` by path segments; returns entry info if found. */
export function lookupTreePath(
  repo: RepoRecord,
  treeOid: string,
  relPath: string,
): { kind: 'file'; oid: string; mode: string } | { kind: 'dir'; oid: string; entries: TreeEntry[] } | null {
  const parts = relPath.split('/').filter((p) => p !== '');
  let currentOid = treeOid;
  if (parts.length === 0) {
    const obj = repo.objects.get(currentOid);
    if (obj === undefined || obj.type !== 'tree') return null;
    return { kind: 'dir', oid: currentOid, entries: parseTree(obj.data) };
  }
  for (let i = 0; i < parts.length; i += 1) {
    const obj = repo.objects.get(currentOid);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entries = parseTree(obj.data);
    const match = entries.find((e) => e.name === parts[i]);
    if (match === undefined) return null;
    const isDir = match.mode === '40000' || match.mode === '040000';
    if (i === parts.length - 1) {
      if (isDir) {
        const dirObj = repo.objects.get(match.oid);
        if (dirObj === undefined || dirObj.type !== 'tree') return null;
        return { kind: 'dir', oid: match.oid, entries: parseTree(dirObj.data) };
      }
      return { kind: 'file', oid: match.oid, mode: match.mode };
    }
    if (!isDir) return null;
    currentOid = match.oid;
  }
  return null;
}

/** Return true if `ancestorOid` is reachable from `descendantOid` via parent pointers. */
export function isAncestor(repo: RepoRecord, ancestorOid: string, descendantOid: string): boolean {
  if (ancestorOid === descendantOid) return true;
  const visited = new Set<string>([descendantOid]);
  const queue: string[] = [descendantOid];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    for (const parent of commit.parents) {
      if (parent === ancestorOid) return true;
      if (!visited.has(parent)) {
        visited.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** Collect all ancestor commit OIDs of `startOid` (including `startOid`). */
function collectAncestors(repo: RepoRecord, startOid: string): Set<string> {
  const seen = new Set<string>([startOid]);
  const queue: string[] = [startOid];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return seen;
}

/** Find a lowest common ancestor commit between `aOid` and `bOid` (BFS from bOid). */
export function findMergeBase(repo: RepoRecord, aOid: string, bOid: string): string | null {
  const aAncestors = collectAncestors(repo, aOid);
  const visited = new Set<string>([bOid]);
  const queue: string[] = [bOid];
  for (let head = 0; head < queue.length; head += 1) {
    const oid = queue[head]!;
    if (aAncestors.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!visited.has(p)) {
        visited.add(p);
        queue.push(p);
      }
    }
  }
  return null;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < data.length - 1; i += 1) {
    if (data[i] === 0x0a) count += 1;
  }
  return count;
}

/** Diff two tree OIDs into GitHub pull-file entries. */
export function diffTrees(repo: RepoRecord, baseTreeOid: string, headTreeOid: string): PullFileDiff[] {
  const baseFiles = baseTreeOid === '' ? new Map() : flattenTree(repo, baseTreeOid);
  const headFiles = headTreeOid === '' ? new Map() : flattenTree(repo, headTreeOid);
  const allPaths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const sortedPaths = [...allPaths].sort();
  const diffs: PullFileDiff[] = [];
  for (const filename of sortedPaths) {
    const b = baseFiles.get(filename);
    const h = headFiles.get(filename);
    if (b === undefined && h !== undefined) {
      const lines = Math.max(1, lineCount(repo.objects.get(h.oid)?.data ?? Buffer.alloc(0)));
      diffs.push({ filename, status: 'added', additions: lines, deletions: 0, changes: lines, sha: h.oid });
    } else if (b !== undefined && h === undefined) {
      const lines = Math.max(1, lineCount(repo.objects.get(b.oid)?.data ?? Buffer.alloc(0)));
      diffs.push({ filename, status: 'removed', additions: 0, deletions: lines, changes: lines, sha: b.oid });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const oldLines = lineCount(repo.objects.get(b.oid)?.data ?? Buffer.alloc(0));
      const newLines = lineCount(repo.objects.get(h.oid)?.data ?? Buffer.alloc(0));
      const additions = Math.max(1, newLines);
      const deletions = Math.max(1, oldLines);
      diffs.push({
        filename,
        status: 'modified',
        additions,
        deletions,
        changes: additions + deletions,
        sha: h.oid,
      });
    }
  }
  return diffs;
}

/** 3-way file-level merge of `oursTreeOid` and `theirsTreeOid` against `baseTreeOid`. */
export function threeWayMergeTrees(
  repo: RepoRecord,
  baseTreeOid: string,
  oursTreeOid: string,
  theirsTreeOid: string,
): { readonly ok: true; readonly treeOid: string } | { readonly ok: false; readonly conflicts: readonly string[] } {
  const baseFiles = baseTreeOid === '' ? new Map() : flattenTree(repo, baseTreeOid);
  const oursFiles = oursTreeOid === '' ? new Map() : flattenTree(repo, oursTreeOid);
  const theirsFiles = theirsTreeOid === '' ? new Map() : flattenTree(repo, theirsTreeOid);
  const merged = new Map<string, { mode: string; oid: string }>();
  const conflicts: string[] = [];
  const allPaths = new Set<string>([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);

  for (const path of allPaths) {
    const b = baseFiles.get(path);
    const o = oursFiles.get(path);
    const t = theirsFiles.get(path);

    if (o?.oid === t?.oid && o?.mode === t?.mode) {
      if (o !== undefined) merged.set(path, o);
      continue;
    }
    if (o?.oid === b?.oid && o?.mode === b?.mode) {
      if (t !== undefined) merged.set(path, t);
      continue;
    }
    if (t?.oid === b?.oid && t?.mode === b?.mode) {
      if (o !== undefined) merged.set(path, o);
      continue;
    }
    conflicts.push(path);
  }

  if (conflicts.length > 0) {
    return { ok: false, conflicts };
  }
  const treeOid = buildTreeFromFlatFiles(repo, merged);
  return { ok: true, treeOid };
}

/** List commit OIDs reachable from `startOid` in reverse topological / newest-first order. */
export function listCommitHistory(repo: RepoRecord, startOid: string, limit = 100): string[] {
  const result: string[] = [];
  const visited = new Set<string>([startOid]);
  const queue: string[] = [startOid];
  for (let idx = 0; idx < queue.length && result.length < limit; idx += 1) {
    const oid = queue[idx]!;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    result.push(oid);
    for (const parent of parseCommit(obj.data).parents) {
      if (!visited.has(parent)) {
        visited.add(parent);
        queue.push(parent);
      }
    }
  }
  return result;
}

/** Collect all objects (commits, trees, blobs, tags) reachable from `roots`, skipping `excludeOids`. */
export function collectReachableObjects(
  repo: RepoRecord,
  roots: Iterable<string>,
  excludeOids: ReadonlySet<string> = new Set(),
): Map<string, GitObjectRecord> {
  const collected = new Map<string, GitObjectRecord>();
  const stack: string[] = [];
  const seen = new Set<string>();

  for (const r of roots) {
    if (!excludeOids.has(r) && !seen.has(r)) {
      seen.add(r);
      stack.push(r);
    }
  }

  while (stack.length > 0) {
    const oid = stack.pop()!;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    collected.set(oid, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (c.tree !== '' && !excludeOids.has(c.tree) && !seen.has(c.tree)) {
        seen.add(c.tree);
        stack.push(c.tree);
      }
      for (const p of c.parents) {
        if (!excludeOids.has(p) && !seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (!excludeOids.has(entry.oid) && !seen.has(entry.oid)) {
          seen.add(entry.oid);
          stack.push(entry.oid);
        }
      }
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (t.object !== '' && !excludeOids.has(t.object) && !seen.has(t.object)) {
        seen.add(t.object);
        stack.push(t.object);
      }
    }
  }
  return collected;
}
