import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import type { BlameLine, VcsReader } from '../core/ports/index.js';
import type { CommitFileRecord, CommitRecord } from '../core/model/index.js';
import { commitId, type RepoId } from '../shared/ids.js';
import type { Logger } from '../shared/logger.js';
import { redactSecrets } from '../shared/redact.js';
import { toPosix } from '../shared/paths.js';

/**
 * Git access.
 *
 * The security rules forbid running shell commands, which rules out shelling
 * out to `git`. `isomorphic-git` reads the object database directly in-process:
 * no subprocess, no PATH dependency, no shell injection surface, and it works
 * identically on Windows where a bundled `git` cannot be assumed.
 *
 * The cost is real and worth naming. Pure-JS object decompression is perhaps an
 * order of magnitude slower than libgit2, and there is no `git blame` — it has
 * to be reconstructed by walking history per file. So the design pushes work to
 * where it is affordable: commit metadata is ingested once into SQLite (turning
 * "what changed recently" and "what are the hotspots" into SQL), while blame is
 * computed lazily per file, capped, and cached.
 */

export class IsomorphicGitReader implements VcsReader {
  readonly #root: string;
  readonly #repoId: RepoId;
  readonly #logger: Logger;
  readonly #blameCache = new Map<string, BlameLine[]>();
  readonly #blameCacheLimit: number;

  constructor(root: string, repoId: RepoId, logger: Logger, blameCacheLimit = 256) {
    this.#root = root;
    this.#repoId = repoId;
    this.#logger = logger;
    this.#blameCacheLimit = blameCacheLimit;
  }

  async isRepository(): Promise<boolean> {
    try {
      await git.resolveRef({ fs, dir: this.#root, ref: 'HEAD' });
      return true;
    } catch {
      return false;
    }
  }

  async headSha(): Promise<string | null> {
    try {
      return await git.resolveRef({ fs, dir: this.#root, ref: 'HEAD' });
    } catch {
      return null;
    }
  }

  async currentBranch(): Promise<string | null> {
    try {
      return (await git.currentBranch({ fs, dir: this.#root, fullname: false })) ?? null;
    } catch {
      return null;
    }
  }

  async listBranches(): Promise<string[]> {
    try {
      return await git.listBranches({ fs, dir: this.#root });
    } catch {
      return [];
    }
  }

  async listTags(): Promise<string[]> {
    try {
      return await git.listTags({ fs, dir: this.#root });
    } catch {
      return [];
    }
  }

  async readCommits(options: { limit: number; includeMerges: boolean }): Promise<{
    commits: CommitRecord[];
    files: CommitFileRecord[];
  }> {
    const log = await git.log({ fs, dir: this.#root, depth: options.limit });
    const commits: CommitRecord[] = [];
    const files: CommitFileRecord[] = [];

    for (const entry of log) {
      const isMerge = entry.commit.parent.length > 1;
      if (isMerge && !options.includeMerges) continue;

      const changed = await this.#changedFiles(entry.oid, entry.commit.parent[0]);

      commits.push({
        id: commitId(this.#repoId, entry.oid),
        repoId: this.#repoId,
        sha: entry.oid,
        authorName: redactSecrets(entry.commit.author.name).text,
        authorEmail: entry.commit.author.email,
        timestampMs: entry.commit.author.timestamp * 1000,
        // Only the subject line is stored. Commit bodies routinely contain
        // pasted logs, stack traces and, occasionally, credentials.
        subject: redactSecrets(entry.commit.message.split('\n')[0] ?? '').text.slice(0, 300),
        isMerge,
        filesChanged: changed.length,
        insertions: 0,
        deletions: 0,
      });

      for (const file of changed) {
        files.push({
          repoId: this.#repoId,
          sha: entry.oid,
          relPath: file.relPath,
          changeType: file.changeType,
        });
      }
    }

    return { commits, files };
  }

  /**
   * Line-level attribution.
   *
   * `isomorphic-git` has no blame, so this walks the file's own history and
   * attributes each line to the earliest commit whose version already contained
   * it. That is an approximation — it does not track lines through moves the way
   * `git blame -M` does — and it is the right trade: the question this answers
   * in practice is "who should I ask about this code", and for that, first
   * appearance is a better answer than last touch anyway.
   */
  async blame(relPath: string): Promise<BlameLine[]> {
    const cached = this.#blameCache.get(relPath);
    if (cached !== undefined) return cached;

    const MAX_HISTORY = 60;
    let history;
    try {
      history = await git.log({ fs, dir: this.#root, filepath: relPath, depth: MAX_HISTORY });
    } catch {
      return [];
    }
    if (history.length === 0) return [];

    const newest = history[0];
    if (newest === undefined) return [];

    const currentLines = await this.#readBlob(newest.oid, relPath);
    if (currentLines === null) return [];

    const attribution = new Map<number, BlameLine>();
    // Walk oldest → newest so the first commit containing a line wins.
    for (const entry of [...history].reverse()) {
      const lines = await this.#readBlob(entry.oid, relPath);
      if (lines === null) continue;
      const present = new Set(lines);

      currentLines.forEach((text, index) => {
        if (attribution.has(index)) return;
        if (!present.has(text)) return;
        attribution.set(index, {
          line: index + 1,
          sha: entry.oid,
          authorName: redactSecrets(entry.commit.author.name).text,
          timestampMs: entry.commit.author.timestamp * 1000,
        });
      });
    }

    const result = currentLines.map(
      (_text, index) =>
        attribution.get(index) ?? {
          line: index + 1,
          sha: newest.oid,
          authorName: redactSecrets(newest.commit.author.name).text,
          timestampMs: newest.commit.author.timestamp * 1000,
        },
    );

    // Simple bounded cache; blame results are large and rarely re-requested for
    // more than a handful of files in one conversation.
    if (this.#blameCache.size >= this.#blameCacheLimit) {
      const oldest = this.#blameCache.keys().next();
      if (!oldest.done) this.#blameCache.delete(oldest.value);
    }
    this.#blameCache.set(relPath, result);
    return result;
  }

  async #readBlob(oid: string, relPath: string): Promise<string[] | null> {
    try {
      const { blob } = await git.readBlob({ fs, dir: this.#root, oid, filepath: relPath });
      return Buffer.from(blob).toString('utf8').split('\n');
    } catch {
      return null;
    }
  }

  async #changedFiles(
    oid: string,
    parentOid: string | undefined,
  ): Promise<{ relPath: string; changeType: CommitFileRecord['changeType'] }[]> {
    if (parentOid === undefined) {
      const entries = await this.#treeFiles(oid);
      return entries.map((relPath) => ({ relPath, changeType: 'add' as const }));
    }

    try {
      const changes: unknown = await git.walk({
        fs,
        dir: this.#root,
        trees: [git.TREE({ ref: oid }), git.TREE({ ref: parentOid })],
        map: async (filepath, entries) => {
          if (filepath === '.') return undefined;
          // Both `null` (path absent from that tree) and `undefined` (index out
          // of range) mean the same thing here: nothing to read.
          const current = entries[0] ?? null;
          const previous = entries[1] ?? null;

          const currentOid = current === null ? null : await current.oid();
          const previousOid = previous === null ? null : await previous.oid();
          if (currentOid === previousOid) return undefined;

          const changeType: CommitFileRecord['changeType'] =
            previousOid === null ? 'add' : currentOid === null ? 'delete' : 'modify';
          return { relPath: toPosix(filepath), changeType };
        },
      });

      return (changes as { relPath: string; changeType: CommitFileRecord['changeType'] }[]).filter(
        (change) => change.relPath.length > 0,
      );
    } catch (error: unknown) {
      this.#logger.debug('Could not diff a commit against its parent.', {
        sha: oid.slice(0, 8),
        reason: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async #treeFiles(oid: string): Promise<string[]> {
    try {
      const files = await git.listFiles({ fs, dir: this.#root, ref: oid });
      return files.map(toPosix);
    } catch {
      return [];
    }
  }
}

export function gitDirectoryExists(root: string): boolean {
  try {
    return fs.existsSync(path.join(root, '.git'));
  } catch {
    return false;
  }
}
