import {
  buildCommit,
  buildTreeFromFlatFiles,
  diffTrees,
  findMergeBase,
  flattenTree,
  parseCommit,
  putGitObject,
  resolveRefOrSha,
  threeWayMergeTrees,
} from './git-objects.ts';
import type {
  CommentRecord,
  GlobalNode,
  IssueRecord,
  LabelRecord,
  PullFileDiff,
  PullRecord,
  RepoRecord,
  UserRecord,
} from './types.ts';

export class ConflictError extends Error {}
export class UnprocessableError extends Error {}
export class NotFoundError extends Error {}
export class MethodNotAllowedError extends Error {}

const BASE_EPOCH_SEC = 1_735_689_600;
const DEFAULT_VIEWER_LOGIN = 'adaiversen';
const DEFAULT_VIEWER_NAME = 'Ada Iversen';
const DEFAULT_VIEWER_EMAIL = 'adaiversen@example.invalid';

export function encodeNodeId(prefix: string, ...parts: readonly (string | number)[]): string {
  return Buffer.from(`${prefix}:${parts.join(':')}`, 'utf8').toString('base64');
}

export class ForgeStore {
  readonly viewer: UserRecord;
  readonly reposByFullName = new Map<string, RepoRecord>();
  readonly viewerRepos: RepoRecord[] = [];
  readonly nodesById = new Map<string, GlobalNode>();

  private nextRepoId = 5000;
  private nextEntityId = 10000;
  private timeSeq = 0;

  constructor(viewerLogin?: string) {
    const envLogin = process.env.MAKEFUN_SHOP_LOGIN?.trim();
    const login = viewerLogin && viewerLogin.trim() !== '' ? viewerLogin.trim() : (envLogin && envLogin !== '' ? envLogin : DEFAULT_VIEWER_LOGIN);
    const isDefault = login === DEFAULT_VIEWER_LOGIN;
    this.viewer = {
      id: 1000,
      nodeId: encodeNodeId('User', 1000),
      login,
      name: isDefault ? DEFAULT_VIEWER_NAME : login,
      email: isDefault ? DEFAULT_VIEWER_EMAIL : `${login}@example.invalid`,
    };
    this.nodesById.set(this.viewer.nodeId, { kind: 'user', user: this.viewer });
  }

  /** Monotonic deterministic timestamp for commits and REST/GraphQL records. */
  nextTimestamp(): { readonly epochSec: number; readonly iso: string } {
    this.timeSeq += 1;
    const epochSec = BASE_EPOCH_SEC + this.timeSeq;
    return { epochSec, iso: new Date(epochSec * 1000).toISOString() };
  }

  getRepo(owner: string, name: string): RepoRecord | undefined {
    return this.reposByFullName.get(`${owner}/${name}`);
  }

  createRepo(input: {
    readonly name: string;
    readonly description?: string;
    readonly private?: boolean;
    readonly defaultBranch?: string;
  }): RepoRecord {
    const name = input.name.trim();
    if (name === '') throw new UnprocessableError('Repository creation failed: name is required');
    const fullName = `${this.viewer.login}/${name}`;
    if (this.reposByFullName.has(fullName)) {
      throw new UnprocessableError('Repository creation failed: name already exists on this account');
    }
    const id = this.nextRepoId;
    this.nextRepoId += 1;
    const nodeId = encodeNodeId('Repository', id);
    const ts = this.nextTimestamp().iso;
    const repo: RepoRecord = {
      id,
      nodeId,
      owner: this.viewer,
      name,
      fullName,
      description: input.description ?? '',
      isPrivate: input.private ?? false,
      defaultBranch: input.defaultBranch && input.defaultBranch.trim() !== '' ? input.defaultBranch.trim() : 'main',
      createdAt: ts,
      updatedAt: ts,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      issueByNumber: new Map(),
      nextNumber: 1,
      pulls: [],
      pullByNumber: new Map(),
      shallowPackCache: new Map(),
    };
    this.reposByFullName.set(fullName, repo);
    this.viewerRepos.push(repo);
    this.nodesById.set(nodeId, { kind: 'repo', repo });
    return repo;
  }

  updateRepo(repo: RepoRecord, patch: { readonly description?: string; readonly private?: boolean; readonly defaultBranch?: string }): RepoRecord {
    if (patch.description !== undefined) repo.description = patch.description;
    if (patch.private !== undefined) repo.isPrivate = patch.private;
    if (patch.defaultBranch !== undefined && patch.defaultBranch.trim() !== '') {
      repo.defaultBranch = patch.defaultBranch.trim();
    }
    repo.updatedAt = this.nextTimestamp().iso;
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = `${owner}/${name}`;
    const repo = this.reposByFullName.get(key);
    if (repo === undefined) return false;
    this.reposByFullName.delete(key);
    this.nodesById.delete(repo.nodeId);
    const idx = this.viewerRepos.indexOf(repo);
    if (idx >= 0) this.viewerRepos.splice(idx, 1);
    return true;
  }

  putContent(
    repo: RepoRecord,
    input: {
      readonly path: string;
      readonly content: Buffer;
      readonly message: string;
      readonly branch?: string;
      readonly sha?: string;
    },
  ): { readonly status: 200 | 201; readonly contentSha: string; readonly commitSha: string } {
    const cleanPath = input.path.replace(/^\/+/, '');
    if (cleanPath === '') throw new UnprocessableError('Invalid path');
    const branch = input.branch && input.branch.trim() !== '' ? input.branch.trim() : repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    let parentOid = repo.refs.get(refName);
    if (parentOid === undefined && branch !== repo.defaultBranch) {
      parentOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }

    let flat = new Map<string, { mode: string; oid: string }>();
    if (parentOid !== undefined) {
      const parentObj = repo.objects.get(parentOid);
      if (parentObj !== undefined && parentObj.type === 'commit') {
        const treeOid = parseCommit(parentObj.data).tree;
        flat = flattenTree(repo, treeOid);
      }
    }

    const existing = flat.get(cleanPath);
    if (existing !== undefined) {
      if (input.sha === undefined || input.sha.toLowerCase() !== existing.oid) {
        throw new ConflictError(`${cleanPath} does not match ${input.sha ?? 'missing sha'}`);
      }
    } else if (input.sha !== undefined) {
      throw new ConflictError(`${cleanPath} does not exist but sha ${input.sha} was provided`);
    }

    const blobOid = putGitObject(repo, 'blob', input.content);
    flat.set(cleanPath, { mode: '100644', oid: blobOid });
    const treeOid = buildTreeFromFlatFiles(repo, flat);
    const ts = this.nextTimestamp();
    const authorLine = `${this.viewer.name} <${this.viewer.email}>`;
    const commitBuf = buildCommit({
      tree: treeOid,
      parents: parentOid === undefined ? [] : [parentOid],
      author: authorLine,
      committer: authorLine,
      timestampSec: ts.epochSec,
      message: input.message,
    });
    const commitOid = putGitObject(repo, 'commit', commitBuf);
    repo.refs.set(refName, commitOid);
    repo.shallowPackCache.clear();
    repo.updatedAt = ts.iso;
    return {
      status: existing !== undefined ? 200 : 201,
      contentSha: blobOid,
      commitSha: commitOid,
    };
  }

  deleteContent(
    repo: RepoRecord,
    input: {
      readonly path: string;
      readonly message: string;
      readonly sha: string;
      readonly branch?: string;
    },
  ): { readonly commitSha: string } {
    const cleanPath = input.path.replace(/^\/+/, '');
    const branch = input.branch && input.branch.trim() !== '' ? input.branch.trim() : repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const parentOid = repo.refs.get(refName);
    if (parentOid === undefined) throw new NotFoundError('Branch not found');
    const parentObj = repo.objects.get(parentOid);
    if (parentObj === undefined || parentObj.type !== 'commit') throw new NotFoundError('Commit not found');
    const flat = flattenTree(repo, parseCommit(parentObj.data).tree);
    const existing = flat.get(cleanPath);
    if (existing === undefined) throw new NotFoundError('Not Found');
    if (input.sha.toLowerCase() !== existing.oid) {
      throw new ConflictError(`${cleanPath} does not match ${input.sha}`);
    }
    flat.delete(cleanPath);
    const treeOid = buildTreeFromFlatFiles(repo, flat);
    const ts = this.nextTimestamp();
    const authorLine = `${this.viewer.name} <${this.viewer.email}>`;
    const commitBuf = buildCommit({
      tree: treeOid,
      parents: [parentOid],
      author: authorLine,
      committer: authorLine,
      timestampSec: ts.epochSec,
      message: input.message,
    });
    const commitOid = putGitObject(repo, 'commit', commitBuf);
    repo.refs.set(refName, commitOid);
    repo.shallowPackCache.clear();
    repo.updatedAt = ts.iso;
    return { commitSha: commitOid };
  }

  createLabel(repo: RepoRecord, input: { readonly name: string; readonly color?: string; readonly description?: string }): LabelRecord {
    const name = input.name.trim();
    if (name === '') throw new UnprocessableError('Label name is required');
    if (repo.labels.has(name)) throw new UnprocessableError('Label already exists');
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    const label: LabelRecord = {
      id,
      nodeId: encodeNodeId('Label', id),
      name,
      color: (input.color ?? 'ededed').replace(/^#/, ''),
      description: input.description ?? '',
    };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(
    repo: RepoRecord,
    input: { readonly title: string; readonly body?: string; readonly labels?: readonly string[] },
  ): IssueRecord {
    const labelRecords: LabelRecord[] = [];
    if (input.labels !== undefined) {
      for (const labelName of input.labels) {
        const found = repo.labels.get(labelName);
        if (found === undefined) {
          throw new UnprocessableError(`Validation Failed: label ${JSON.stringify(labelName)} does not exist`);
        }
        labelRecords.push(found);
      }
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    const nodeId = encodeNodeId('Issue', repo.id, number);
    const ts = this.nextTimestamp().iso;
    const issue: IssueRecord = {
      id,
      nodeId,
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: labelRecords,
      user: this.viewer,
      comments: [],
      createdAt: ts,
      updatedAt: ts,
      closedAt: null,
      cachedJson: undefined,
    };
    repo.issues.push(issue);
    repo.issueByNumber.set(number, issue);
    this.nodesById.set(nodeId, { kind: 'issue', repo, issue });
    return issue;
  }

  updateIssue(
    repo: RepoRecord,
    number: number,
    patch: { readonly title?: string; readonly body?: string; readonly state?: 'open' | 'closed' },
  ): IssueRecord | undefined {
    const issue = repo.issueByNumber.get(number);
    if (issue === undefined) return undefined;
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    const ts = this.nextTimestamp().iso;
    if (patch.state !== undefined) {
      issue.state = patch.state;
      issue.closedAt = patch.state === 'closed' ? ts : null;
    }
    issue.updatedAt = ts;
    issue.cachedJson = undefined;
    return issue;
  }

  addComment(repo: RepoRecord, issueNumber: number, body: string): CommentRecord | undefined {
    const issue = repo.issueByNumber.get(issueNumber);
    if (issue === undefined) return undefined;
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    const nodeId = encodeNodeId('IssueComment', id);
    const ts = this.nextTimestamp().iso;
    const comment: CommentRecord = {
      id,
      nodeId,
      body,
      user: this.viewer,
      createdAt: ts,
      updatedAt: ts,
    };
    issue.comments.push(comment);
    issue.updatedAt = ts;
    issue.cachedJson = undefined;
    this.nodesById.set(nodeId, { kind: 'comment', comment });
    return comment;
  }

  createPull(
    repo: RepoRecord,
    input: { readonly title: string; readonly body?: string; readonly head: string; readonly base: string },
  ): PullRecord {
    const headSha = resolveRefOrSha(repo, input.head);
    const baseSha = resolveRefOrSha(repo, input.base);
    if (headSha === undefined) {
      throw new UnprocessableError(`Validation Failed: head branch ${input.head} does not exist`);
    }
    if (baseSha === undefined) {
      throw new UnprocessableError(`Validation Failed: base branch ${input.base} does not exist`);
    }
    const existingOpen = repo.pulls.find(
      (p) => p.state === 'open' && p.headRef === input.head && p.baseRef === input.base,
    );
    if (existingOpen !== undefined) {
      throw new UnprocessableError(`Validation Failed: A pull request already exists for ${input.head}`);
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    const nodeId = encodeNodeId('PullRequest', repo.id, number);
    const ts = this.nextTimestamp().iso;
    const pull: PullRecord = {
      id,
      nodeId,
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      headRef: input.head,
      headSha,
      baseRef: input.base,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      user: this.viewer,
      createdAt: ts,
      updatedAt: ts,
    };
    repo.pulls.push(pull);
    repo.pullByNumber.set(number, pull);
    this.nodesById.set(nodeId, { kind: 'pull', repo, pull });
    return pull;
  }

  updatePull(
    repo: RepoRecord,
    number: number,
    patch: { readonly title?: string; readonly body?: string; readonly state?: 'open' | 'closed'; readonly base?: string },
  ): PullRecord | undefined {
    const pull = repo.pullByNumber.get(number);
    if (pull === undefined) return undefined;
    if (patch.title !== undefined) pull.title = patch.title;
    if (patch.body !== undefined) pull.body = patch.body;
    if (patch.state !== undefined && !pull.merged) {
      pull.state = patch.state;
    }
    if (patch.base !== undefined && patch.base.trim() !== '') {
      const nextBaseSha = resolveRefOrSha(repo, patch.base);
      if (nextBaseSha === undefined) {
        throw new UnprocessableError(`Validation Failed: base branch ${patch.base} does not exist`);
      }
      pull.baseRef = patch.base;
      pull.baseSha = nextBaseSha;
    }
    pull.updatedAt = this.nextTimestamp().iso;
    return pull;
  }

  private pullShas(repo: RepoRecord, pull: PullRecord): { readonly headSha: string; readonly baseSha: string } {
    if (pull.state === 'open') {
      const liveHead = resolveRefOrSha(repo, pull.headRef) ?? pull.headSha;
      const liveBase = resolveRefOrSha(repo, pull.baseRef) ?? pull.baseSha;
      return { headSha: liveHead, baseSha: liveBase };
    }
    return { headSha: pull.headSha, baseSha: pull.baseSha };
  }

  private commitTreeOid(repo: RepoRecord, commitOid: string): string {
    const obj = repo.objects.get(commitOid);
    if (obj === undefined || obj.type !== 'commit') return '';
    return parseCommit(obj.data).tree;
  }

  getPullFiles(repo: RepoRecord, pull: PullRecord): PullFileDiff[] {
    const { headSha, baseSha } = this.pullShas(repo, pull);
    const lca = findMergeBase(repo, baseSha, headSha) ?? baseSha;
    const baseTree = this.commitTreeOid(repo, lca);
    const headTree = this.commitTreeOid(repo, headSha);
    return diffTrees(repo, baseTree, headTree);
  }

  getPullMergeable(repo: RepoRecord, pull: PullRecord): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.merged) return 'MERGEABLE';
    if (pull.state !== 'open') return 'UNKNOWN';
    const { headSha, baseSha } = this.pullShas(repo, pull);
    const lca = findMergeBase(repo, baseSha, headSha);
    const lcaTree = lca === null ? '' : this.commitTreeOid(repo, lca);
    const baseTree = this.commitTreeOid(repo, baseSha);
    const headTree = this.commitTreeOid(repo, headSha);
    const merged = threeWayMergeTrees(repo, lcaTree, baseTree, headTree);
    return merged.ok ? 'MERGEABLE' : 'CONFLICTING';
  }

  mergePull(
    repo: RepoRecord,
    pull: PullRecord,
    options: { readonly commitTitle?: string; readonly commitMessage?: string; readonly mergeMethod?: string } = {},
  ): { readonly sha: string; readonly merged: true; readonly message: string } {
    if (pull.merged || pull.state !== 'open') {
      throw new MethodNotAllowedError('Pull Request is not mergeable');
    }
    const { headSha, baseSha } = this.pullShas(repo, pull);
    const lca = findMergeBase(repo, baseSha, headSha);
    const lcaTree = lca === null ? '' : this.commitTreeOid(repo, lca);
    const baseTree = this.commitTreeOid(repo, baseSha);
    const headTree = this.commitTreeOid(repo, headSha);
    const merged = threeWayMergeTrees(repo, lcaTree, baseTree, headTree);
    if (!merged.ok) {
      throw new MethodNotAllowedError('Pull Request is not mergeable');
    }

    const ts = this.nextTimestamp();
    const authorLine = `${this.viewer.name} <${this.viewer.email}>`;
    const msgTitle = options.commitTitle ?? `${pull.title} (#${pull.number})`;
    const msg = options.commitMessage ? `${msgTitle}\n\n${options.commitMessage}` : msgTitle;
    const method = (options.mergeMethod ?? 'squash').toLowerCase();
    const parents = method === 'merge' ? [baseSha, headSha] : [baseSha];

    const commitBuf = buildCommit({
      tree: merged.treeOid,
      parents,
      author: authorLine,
      committer: authorLine,
      timestampSec: ts.epochSec,
      message: msg,
    });
    const commitSha = putGitObject(repo, 'commit', commitBuf);
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
    repo.shallowPackCache.clear();
    repo.updatedAt = ts.iso;

    pull.headSha = headSha;
    pull.baseSha = baseSha;
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = ts.iso;
    pull.mergeCommitSha = commitSha;
    pull.updatedAt = ts.iso;

    return {
      sha: commitSha,
      merged: true,
      message: 'Pull Request successfully merged',
    };
  }
}
