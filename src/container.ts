import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConnectorConfig } from './config/schema.js';
import { resolveDatabasePath } from './config/load.js';
import { WorkspaceGrant } from './auth/workspace-grant.js';
import { IndexingService } from './core/services/index-repository.js';
import { WorkspaceWatcher } from './indexer/watcher.js';
import type { IndexStore, VcsReader } from './core/ports/index.js';
import { IsomorphicGitReader } from './git/reader.js';
import { SearchService } from './search/service.js';
import { openDatabase } from './storage/driver.js';
import { SqliteIndexStore } from './storage/sqlite-store.js';
import { createLogger, type Logger } from './shared/logger.js';
import { repoId } from './shared/ids.js';
import type { ToolContext } from './tools/registry.js';

/**
 * The composition root.
 *
 * Every `new` that binds a port to an adapter happens here and nowhere else.
 * The payoff is concrete: integration tests build the same graph with an
 * in-memory database and a fake clock by calling `createContainer` with
 * overrides, and no production file needs a test-only branch.
 */

export interface Container {
  readonly config: ConnectorConfig;
  readonly logger: Logger;
  readonly store: IndexStore;
  readonly toolContext: ToolContext;
  /** Present only when `index.watch` is enabled; already started. */
  readonly watcher: WorkspaceWatcher | null;
  shutdown(): Promise<void>;
}

export interface ContainerOverrides {
  readonly store?: IndexStore;
  readonly vcsFor?: (root: string) => VcsReader;
  readonly logger?: Logger;
}

export async function createContainer(
  config: ConnectorConfig,
  version: string,
  overrides: ContainerOverrides = {},
): Promise<Container> {
  const logger =
    overrides.logger ??
    createLogger({ level: config.logging.level, bindings: { component: 'connector' } });

  const grant = WorkspaceGrant.fromConfig(config);

  const store =
    overrides.store ??
    (await (async (): Promise<IndexStore> => {
      // The index lives beside the code it describes, so removing a project
      // removes its index too, and nothing is written to a shared location.
      //
      // With no workspace granted there is nothing to index and nowhere to put
      // an index anyway. An in-memory database keeps the server startable so
      // every tool can answer "no workspace is granted" — which is a far better
      // failure than refusing to boot.
      const databasePath = grant.isEmpty ? ':memory:' : resolveDatabasePath(config);
      const driver = openDatabase({ filePath: databasePath, logger });
      const created = new SqliteIndexStore(driver, logger, version);
      await created.initialize();
      logger.debug('Index ready.', { path: path.basename(databasePath), driver: driver.kind });
      return created;
    })());

  const vcsFor =
    overrides.vcsFor ??
    ((root: string): VcsReader => new IsomorphicGitReader(root, repoId(root), logger));

  const indexing = new IndexingService(store, config, logger, vcsFor);
  const search = new SearchService(store, config);

  let watcher: WorkspaceWatcher | null = null;
  if (config.index.watch && !grant.isEmpty) {
    watcher = new WorkspaceWatcher(config, indexing, logger);
    watcher.start(grant.roots);
  }

  const toolContext: ToolContext = {
    store,
    config,
    logger,
    grant,
    indexing,
    search,
    vcsFor,
    readFile: async (absPath: string) => readFile(absPath, 'utf8'),
    writeFile: async (absPath: string, contents: string) => writeFile(absPath, contents, 'utf8'),
  };

  return {
    config,
    logger,
    store,
    toolContext,
    watcher,
    shutdown: async (): Promise<void> => {
      // Stop the watcher before the store: a refresh mid-close would write to a
      // closed database.
      if (watcher !== null) await watcher.close();
      await store.close();
    },
  };
}
