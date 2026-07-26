import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import picomatch from 'picomatch';
import type { ConnectorConfig } from '../config/schema.js';
import type { IndexingService } from '../core/services/index-repository.js';
import type { Logger } from '../shared/logger.js';
import { normalizeRoot, toPosix } from '../shared/paths.js';

/**
 * Optional filesystem watcher.
 *
 * Off by default, and that default is deliberate. A watcher on a large
 * repository competes for the same CPU the user's build is using, and the
 * failure mode is nasty: a `git checkout` of a large branch fires tens of
 * thousands of events at once, and a naive watcher responds by launching
 * tens of thousands of re-index runs.
 *
 * Three properties keep it well-behaved:
 *
 * - **Debounced.** Events accumulate into a pending set and one refresh runs
 *   after the burst settles. A branch switch produces one re-index, not one per
 *   file.
 * - **Non-overlapping.** If a refresh is already running when the timer fires,
 *   the next one is queued rather than started concurrently. Two indexers
 *   writing the same SQLite file is a lock contention problem at best.
 * - **Filtered at the watcher.** Ignore globs are handed to chokidar rather than
 *   applied afterwards, so `node_modules` never generates events in the first
 *   place. Filtering after the fact still pays the inotify cost.
 *
 * The watcher never surfaces errors to the user through the protocol — a failed
 * background refresh logs and retries on the next change, because interrupting
 * a conversation for a filesystem hiccup is worse than a slightly stale index.
 */
export class WorkspaceWatcher {
  readonly #config: ConnectorConfig;
  readonly #indexing: IndexingService;
  readonly #logger: Logger;
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #pending = new Map<string, Set<string>>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #running = new Set<string>();
  readonly #queued = new Set<string>();
  #closed = false;

  constructor(config: ConnectorConfig, indexing: IndexingService, logger: Logger) {
    this.#config = config;
    this.#indexing = indexing;
    this.#logger = logger.child({ component: 'watcher' });
  }

  get isWatching(): boolean {
    return this.#watchers.size > 0;
  }

  /** Number of paths awaiting the next debounced refresh. Used by tests. */
  pendingCount(root: string): number {
    return this.#pending.get(normalizeRoot(root))?.size ?? 0;
  }

  start(roots: readonly string[]): void {
    if (!this.#config.index.watch) {
      this.#logger.debug('Watching is disabled.');
      return;
    }

    for (const raw of roots) {
      const root = normalizeRoot(raw);
      if (this.#watchers.has(root)) continue;

      // Handing the globs to chokidar means excluded trees never produce an
      // event. Filtering downstream would still pay the syscall cost.
      const ignored = [
        ...this.#config.workspace.exclude,
        ...this.#config.security.denyGlobs,
        '**/.throughline/**',
      ];

      const watcher = chokidar.watch(root, {
        ignored,
        ignoreInitial: true,
        persistent: true,
        followSymlinks: this.#config.workspace.followSymlinks,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
        // Depth is bounded so a pathological tree cannot exhaust file handles.
        depth: 24,
      });

      const onChange = (absPath: string): void => {
        this.#record(root, absPath);
      };
      watcher.on('add', onChange);
      watcher.on('change', onChange);
      watcher.on('unlink', onChange);
      watcher.on('error', (error: unknown) => {
        this.#logger.warn('Watcher error; the index may fall behind until the next manual refresh.', {
          root: path.basename(root),
          reason: error instanceof Error ? error.message : String(error),
        });
      });

      this.#watchers.set(root, watcher);
      this.#logger.info('Watching for changes.', {
        root: path.basename(root),
        debounceMs: this.#config.index.watchDebounceMs,
      });
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    await Promise.all([...this.#watchers.values()].map(async (watcher) => watcher.close()));
    this.#watchers.clear();
    this.#pending.clear();
  }

  #record(root: string, absPath: string): void {
    if (this.#closed) return;

    const relPath = toPosix(path.relative(root, absPath));
    if (relPath.length === 0 || relPath.startsWith('..')) return;

    // Second-chance filter: chokidar's `ignored` handles directories, but an
    // include list is our own concept and has to be applied here.
    if (!this.#isIncluded(relPath)) return;

    const set = this.#pending.get(root) ?? new Set<string>();
    set.add(relPath);
    this.#pending.set(root, set);

    const existing = this.#timers.get(root);
    if (existing !== undefined) clearTimeout(existing);

    this.#timers.set(
      root,
      setTimeout(() => {
        void this.#refresh(root);
      }, this.#config.index.watchDebounceMs),
    );
  }

  #isIncluded(relPath: string): boolean {
    const include = this.#config.workspace.include;
    if (include.length === 0) return true;
    return include.some((glob) => picomatch(glob, { dot: true })(relPath));
  }

  async #refresh(root: string): Promise<void> {
    this.#timers.delete(root);

    // Never run two indexers against one database; queue instead.
    if (this.#running.has(root)) {
      this.#queued.add(root);
      return;
    }

    const changed = this.#pending.get(root);
    if (changed === undefined || changed.size === 0) return;
    this.#pending.set(root, new Set());

    this.#running.add(root);
    const startedAt = Date.now();

    try {
      const report = await this.#indexing.index({ root });
      this.#logger.debug('Background refresh complete.', {
        root: path.basename(root),
        triggeredBy: changed.size,
        reindexed: report.filesChanged,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error: unknown) {
      // A failed background refresh is not worth interrupting the user over;
      // the next change retries, and manual refresh_index always works.
      this.#logger.warn('Background refresh failed; the index is stale until the next change.', {
        root: path.basename(root),
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#running.delete(root);
      if (this.#queued.delete(root) && !this.#closed) {
        void this.#refresh(root);
      }
    }
  }
}
