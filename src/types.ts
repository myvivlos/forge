/** Core domain types for the in-memory GitHub-compatible forge. */

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObjectRecord {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface ParsedTag {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export interface UserRecord {
  readonly id: number;
  readonly nodeId: string;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

export interface LabelRecord {
  readonly id: number;
  readonly nodeId: string;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface CommentRecord {
  readonly id: number;
  readonly nodeId: string;
  readonly body: string;
  readonly user: UserRecord;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IssueRecord {
  readonly id: number;
  readonly nodeId: string;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly labels: LabelRecord[];
  readonly user: UserRecord;
  readonly comments: CommentRecord[];
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Pre-serialized REST JSON payload for fast keep-alive reads; cleared on mutation. */
  cachedJson: string | undefined;
}

export interface PullFileDiff {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly sha: string;
}

export interface PullRecord {
  readonly id: number;
  readonly nodeId: string;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly user: UserRecord;
  readonly createdAt: string;
  updatedAt: string;
}

export interface RepoRecord {
  readonly id: number;
  readonly nodeId: string;
  readonly owner: UserRecord;
  readonly name: string;
  readonly fullName: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly objects: Map<string, GitObjectRecord>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, LabelRecord>;
  readonly issues: IssueRecord[];
  readonly issueByNumber: Map<number, IssueRecord>;
  nextNumber: number;
  readonly pulls: PullRecord[];
  readonly pullByNumber: Map<number, PullRecord>;
  /** Cache of depth-1 shallow packs keyed by `${wantOid}:${depth}` invalidated on ref writes. */
  readonly shallowPackCache: Map<string, Buffer>;
}

export type GlobalNode =
  | { readonly kind: 'repo'; readonly repo: RepoRecord }
  | { readonly kind: 'issue'; readonly repo: RepoRecord; readonly issue: IssueRecord }
  | { readonly kind: 'pull'; readonly repo: RepoRecord; readonly pull: PullRecord }
  | { readonly kind: 'comment'; readonly comment: CommentRecord }
  | { readonly kind: 'user'; readonly user: UserRecord };
