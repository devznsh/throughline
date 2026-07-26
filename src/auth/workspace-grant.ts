import type { ConnectorConfig } from '../config/schema.js';
import { ConfirmationRequiredError, WorkspaceAccessError } from '../shared/errors.js';
import { findContainingRoot, normalizeRoot, resolveWithinRoot } from '../shared/paths.js';
import { repoId, type RepoId } from '../shared/ids.js';

/**
 * Authorisation for a local connector.
 *
 * A desktop extension has no OAuth and needs none — there is no remote resource
 * to delegate access to. The meaningful boundary is *which directories on this
 * machine the connector may read*, and the user draws it with the directory
 * picker Claude Desktop generates from `user_config.workspace_roots`. Clicking
 * through that dialog is the grant; this class is the grant made explicit in
 * code so every path-touching operation checks the same thing.
 *
 * Two properties matter and are easy to get wrong:
 *
 * - **The grant cannot be widened from inside.** Roots come from argv, which
 *   comes from the install dialog. A `connector.config.json` committed to a
 *   repository is data, not authority; the loader already refuses to let it add
 *   roots, and nothing downstream can either.
 * - **Containment is checked after resolution.** A path is inside the grant only
 *   if its *realpath* is. Checking the lexical path lets a symlink walk straight
 *   out to `~/.ssh`.
 */
export class WorkspaceGrant {
  readonly #roots: readonly string[];

  constructor(roots: readonly string[]) {
    this.#roots = roots.map(normalizeRoot);
  }

  static fromConfig(config: ConnectorConfig): WorkspaceGrant {
    return new WorkspaceGrant(config.workspace.roots);
  }

  get roots(): readonly string[] {
    return this.#roots;
  }

  get isEmpty(): boolean {
    return this.#roots.length === 0;
  }

  /**
   * Resolves a caller-supplied workspace reference to a granted root.
   *
   * With one root — the common case — the argument is optional and omitting it
   * is unambiguous. With several, an unqualified request is genuinely ambiguous
   * and guessing would be worse than asking.
   */
  resolveRoot(requested?: string): string {
    if (this.#roots.length === 0) {
      throw new WorkspaceAccessError('No workspace has been granted to this connector.', {
        remedy:
          'Open Claude Desktop → Settings → Extensions → Throughline and choose at least one directory.',
      });
    }

    if (requested === undefined || requested.trim().length === 0) {
      const only = this.#roots[0];
      if (this.#roots.length === 1 && only !== undefined) return only;
      throw new WorkspaceAccessError(
        `Several workspaces are granted; specify which one. Available: ${this.#roots.join(', ')}`,
      );
    }

    const normalized = normalizeRoot(requested);
    const exact = this.#roots.find((root) => root === normalized);
    if (exact !== undefined) return exact;

    // Accept a path inside a granted root, and accept a bare directory name so
    // callers can say "the api repo" rather than pasting an absolute path.
    const containing = findContainingRoot(this.#roots, normalized);
    if (containing !== undefined) return containing;

    const byName = this.#roots.filter((root) => root.endsWith(`/${requested}`) || root.endsWith(`\\${requested}`));
    const single = byName[0];
    if (byName.length === 1 && single !== undefined) return single;

    throw new WorkspaceAccessError(`"${requested}" is not a granted workspace.`, {
      details: { granted: this.#roots },
    });
  }

  repoIdFor(requested?: string): RepoId {
    return repoId(this.resolveRoot(requested));
  }

  /** Resolves a workspace-relative path, refusing anything that escapes. */
  async resolvePath(root: string, relPath: string): Promise<string> {
    return resolveWithinRoot(this.resolveRoot(root), relPath);
  }
}

export interface ConsentRequest {
  /** Human-readable description of the change, shown to the user by Claude. */
  readonly action: string;
  readonly relPath: string;
  /** Unified diff or full proposed content. */
  readonly preview: string;
  readonly confirmed: boolean;
}

/**
 * The consent gate for mutating tools.
 *
 * Two independent locks. `security.allowWrites` is a standing setting that is
 * off by default; `confirm: true` is per-call. Requiring both means a user who
 * enables writes for one task has not silently enabled every future write, and
 * a model that decides to write has to surface the diff first — the error
 * returned on the unconfirmed call *contains* the preview, so the natural way
 * for Claude to proceed is to show the user what would change.
 *
 * This is why write tools are annotated `readOnlyHint: false`: the annotation
 * and the runtime behaviour have to tell the same story, or the annotation is
 * decoration.
 */
export function requireConsent(config: ConnectorConfig, request: ConsentRequest): void {
  if (!config.security.allowWrites) {
    throw new ConfirmationRequiredError(
      `Writing files is disabled. ${request.action} was not performed.`,
      {
        details: { relPath: request.relPath },
        remedy:
          'Set security.allowWrites to true in connector.config.json, then call again with confirm: true.',
      },
    );
  }

  if (!request.confirmed) {
    throw new ConfirmationRequiredError(`${request.action} requires confirmation.`, {
      details: {
        relPath: request.relPath,
        preview: request.preview.slice(0, 4_000),
      },
      remedy: 'Show this preview to the user. If they approve, call again with confirm: true.',
    });
  }
}
