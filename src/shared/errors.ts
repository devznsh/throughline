import { redactForLog } from './redact.js';

/**
 * Stable, machine-readable error codes. These appear in tool error payloads, so
 * Claude can react to them (e.g. call `refresh_index` after `INDEX_STALE`)
 * without parsing prose. Treat them as public API: add, never rename.
 */
export const ErrorCode = {
  CONFIG_INVALID: 'CONFIG_INVALID',
  WORKSPACE_NOT_CONFIGURED: 'WORKSPACE_NOT_CONFIGURED',
  WORKSPACE_ACCESS_DENIED: 'WORKSPACE_ACCESS_DENIED',
  PATH_ESCAPES_WORKSPACE: 'PATH_ESCAPES_WORKSPACE',
  NOT_FOUND: 'NOT_FOUND',
  INDEX_MISSING: 'INDEX_MISSING',
  INDEX_STALE: 'INDEX_STALE',
  STORAGE_FAILURE: 'STORAGE_FAILURE',
  PARSE_FAILURE: 'PARSE_FAILURE',
  UNSUPPORTED_LANGUAGE: 'UNSUPPORTED_LANGUAGE',
  GIT_UNAVAILABLE: 'GIT_UNAVAILABLE',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  WRITE_NOT_PERMITTED: 'WRITE_NOT_PERMITTED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  RESOURCE_EXHAUSTED: 'RESOURCE_EXHAUSTED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ConnectorErrorOptions {
  /** Structured context. Values are redacted before they reach a log or a tool reply. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Whether retrying the same call could plausibly succeed. */
  readonly retryable?: boolean;
  /** A concrete next step for the caller — surfaced to Claude verbatim. */
  readonly remedy?: string;
  readonly cause?: unknown;
}

/**
 * Base class for every error this connector raises deliberately.
 *
 * Error *messages* are part of the model-facing surface. A good one names the
 * thing that failed and what to do about it; a bad one leaks an absolute home
 * directory path or the contents of a `.env` file. `toPayload` enforces the
 * hygiene so individual call sites do not have to.
 */
export class ConnectorError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;
  readonly remedy: string | undefined;

  constructor(code: ErrorCode, message: string, options: ConnectorErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? false;
    this.remedy = options.remedy;
  }

  /** Redacted, serialisable form suitable for logs and tool replies. */
  toPayload(): {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    remedy?: string;
    details?: Record<string, unknown>;
  } {
    const details = redactDetails(this.details);
    return {
      code: this.code,
      message: redactForLog(this.message),
      retryable: this.retryable,
      ...(this.remedy === undefined ? {} : { remedy: this.remedy }),
      ...(Object.keys(details).length === 0 ? {} : { details }),
    };
  }
}

export class ConfigError extends ConnectorError {
  constructor(message: string, options: ConnectorErrorOptions = {}) {
    super(ErrorCode.CONFIG_INVALID, message, options);
  }
}

/** Raised when a request touches a path outside every configured workspace root. */
export class WorkspaceAccessError extends ConnectorError {
  constructor(message: string, options: ConnectorErrorOptions = {}) {
    super(ErrorCode.WORKSPACE_ACCESS_DENIED, message, {
      remedy:
        'Add the directory to the connector’s Allowed Workspaces in Claude Desktop → Settings → Extensions.',
      ...options,
    });
  }
}

/** Arguments failed schema validation, or a tool name is unknown. */
export class ValidationError extends ConnectorError {
  constructor(message: string, options: ConnectorErrorOptions = {}) {
    super(ErrorCode.INVALID_ARGUMENT, message, options);
  }
}

export class NotFoundError extends ConnectorError {
  constructor(message: string, options: ConnectorErrorOptions = {}) {
    super(ErrorCode.NOT_FOUND, message, options);
  }
}

export class StorageError extends ConnectorError {
  constructor(message: string, options: ConnectorErrorOptions = {}) {
    super(ErrorCode.STORAGE_FAILURE, message, options);
  }
}

export class ParseError extends ConnectorError {
  constructor(message: string, options: ConnectorErrorOptions = {}) {
    super(ErrorCode.PARSE_FAILURE, message, options);
  }
}

/**
 * Raised by mutating tools that were called without `confirm: true`. The message
 * is the confirmation prompt the user will effectively see, so it must state
 * exactly what would change.
 */
export class ConfirmationRequiredError extends ConnectorError {
  constructor(message: string, options: ConnectorErrorOptions = {}) {
    super(ErrorCode.CONFIRMATION_REQUIRED, message, {
      remedy: 'Show the planned change to the user, then call again with confirm: true.',
      ...options,
    });
  }
}

export class IndexMissingError extends ConnectorError {
  constructor(message: string, options: ConnectorErrorOptions = {}) {
    super(ErrorCode.INDEX_MISSING, message, {
      remedy: 'Call scan_repository for this workspace first.',
      retryable: false,
      ...options,
    });
  }
}

function redactDetails(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    out[key] = typeof value === 'string' ? redactForLog(value) : value;
  }
  return out;
}

/** Normalises any thrown value into a `ConnectorError`. */
export function toConnectorError(error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof Error) {
    return new ConnectorError(ErrorCode.INTERNAL, error.message, { cause: error });
  }
  return new ConnectorError(ErrorCode.INTERNAL, String(error));
}

/**
 * The MCP error-result shape.
 *
 * Declared as a `type` rather than an `interface`, which is load-bearing rather
 * than stylistic. The SDK's `CallToolResult` carries an index signature
 * (`[x: string]: unknown`), and TypeScript grants *implicit* index signatures to
 * type aliases but never to interfaces — an interface stays open to declaration
 * merging, so the compiler cannot know its final shape. As an interface this is
 * unassignable to `CallToolResult`; as a type alias it is.
 *
 * `content` is mutable for a related reason: the SDK types it as a mutable
 * array, and a `readonly` array is not assignable to one.
 *
 * The alternative — importing `CallToolResult` here — would drag the MCP SDK
 * into `shared/`, which by design depends on nothing. Structuring the type so it
 * satisfies the SDK without importing it keeps that boundary intact; the
 * transport layer in `main.ts` remains the only place that knows about MCP.
 */
// Must stay a type alias, not an interface: TypeScript grants implicit index
// signatures to aliases but never to interfaces, and this has to be assignable
// to the SDK's CallToolResult, which carries one. As an interface it does not
// compile — see the note above.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type ToolErrorReply = {
  readonly isError: true;
  content: { type: 'text'; text: string }[];
};

/**
 * Converts an error into the MCP `CallToolResult` error shape.
 *
 * Returning a structured, redacted body rather than a bare string is deliberate:
 * reviewers specifically look for connectors that fail with actionable messages
 * instead of generic 500s, and Claude recovers far better from
 * `{"code":"INDEX_MISSING","remedy":"Call scan_repository..."}` than from
 * "something went wrong".
 */
export function toToolError(error: unknown): ToolErrorReply {
  const payload = toConnectorError(error).toPayload();
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}
