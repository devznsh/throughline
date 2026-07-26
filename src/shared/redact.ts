/**
 * Secret detection and redaction.
 *
 * Design note — *where* redaction happens matters more than how. Secrets are
 * scrubbed on the way **into** the index, not on the way out to the model. The
 * index is a durable artifact on the user's disk; if a live Stripe key is written
 * into the `chunks` table, it is a leak whether or not any tool ever returns it.
 * Redacting at write time means the database itself is clean, and every consumer
 * (search snippets, blame output, logs, generated docs) inherits that guarantee
 * without having to remember to sanitise.
 *
 * The detectors below are deliberately high-precision rather than high-recall.
 * Path-based exclusion (`security.denyGlobs` — `.env`, `*.pem`, `.ssh/**`) is the
 * primary defence; this is defence in depth for secrets that end up committed in
 * ordinary source files.
 */

export interface SecretPattern {
  /** Stable identifier, surfaced in the placeholder and in health reports. */
  readonly id: string;
  /** Human-readable label for the repository health report. */
  readonly label: string;
  readonly pattern: RegExp;
}

/**
 * Ordered most-specific-first. Every pattern must carry the `g` flag; the
 * detectors are only ever used with `String.prototype.replace`/`matchAll`,
 * which do not leave `lastIndex` dangling between calls.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: 'private_key_block',
    label: 'PEM private key block',
    pattern: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g,
  },
  {
    id: 'anthropic_api_key',
    label: 'Anthropic API key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{24,}/g,
  },
  {
    id: 'openai_api_key',
    label: 'OpenAI API key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g,
  },
  {
    id: 'stripe_secret_key',
    label: 'Stripe secret or restricted key',
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  },
  {
    id: 'stripe_webhook_secret',
    label: 'Stripe webhook signing secret',
    pattern: /\bwhsec_[A-Za-z0-9]{16,}/g,
  },
  {
    id: 'github_token',
    label: 'GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  },
  {
    id: 'slack_token',
    label: 'Slack token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    id: 'google_api_key',
    label: 'Google API key',
    pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g,
  },
  {
    id: 'aws_access_key_id',
    label: 'AWS access key ID',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
  },
  {
    id: 'npm_token',
    label: 'npm access token',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: 'json_web_token',
    label: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    id: 'connection_string_password',
    label: 'Password embedded in a connection URI',
    // Captures the password segment of scheme://user:password@host
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]{3,})(@)/gi,
  },
  {
    id: 'assigned_credential',
    label: 'Hard-coded credential assignment',
    // password = "hunter2" / api_key: 'abc...' — the *value* is replaced, the key kept.
    //
    // `\b` would not fire on DB_PASSWORD (an underscore is a word character on
    // both sides), and that is the single most common shape in real code, so the
    // guard is an explicit "not preceded by an alphanumeric" instead. The
    // negative lookahead stops this pattern re-wrapping a placeholder that an
    // earlier, more specific detector already wrote.
    pattern:
      /(?<![A-Za-z0-9])((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*)(["'])(?!\[REDACTED:)([^"'\n]{8,})\2/gi,
  },
];

export interface RedactionFinding {
  readonly patternId: string;
  readonly label: string;
  /** Byte offset in the original text, useful for pointing a health report at a line. */
  readonly index: number;
  readonly length: number;
}

export interface RedactionResult {
  readonly text: string;
  readonly findings: readonly RedactionFinding[];
}

function placeholder(id: string): string {
  return `[REDACTED:${id}]`;
}

/**
 * Replaces detected secrets with `[REDACTED:<pattern_id>]`.
 *
 * The placeholder keeps the *shape* of the code intact — an assignment still
 * looks like an assignment — so Claude can still reason about "the Stripe key is
 * read from this constant" without ever seeing the value. Two patterns preserve
 * their surrounding syntax (`connection_string_password`, `assigned_credential`)
 * for exactly that reason.
 */
export function redactSecrets(text: string): RedactionResult {
  if (text.length === 0) return { text, findings: [] };

  const findings: RedactionFinding[] = [];
  let current = text;

  for (const { id, label, pattern } of SECRET_PATTERNS) {
    // Collect findings against the *current* text so offsets match what is stored.
    for (const match of current.matchAll(pattern)) {
      findings.push({ patternId: id, label, index: match.index, length: match[0].length });
    }

    if (id === 'connection_string_password') {
      current = current.replace(pattern, (_full, prefix: string, _pw: string, suffix: string) => {
        return `${prefix}${placeholder(id)}${suffix}`;
      });
    } else if (id === 'assigned_credential') {
      current = current.replace(pattern, (_full, prefix: string, quote: string) => {
        return `${prefix}${quote}${placeholder(id)}${quote}`;
      });
    } else {
      current = current.replace(pattern, placeholder(id));
    }
  }

  return { text: current, findings };
}

/** True when the text contains at least one detectable secret. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => {
    // `test` on a /g regex is stateful; use `search` on a fresh, non-global copy.
    const probe = new RegExp(p.pattern.source, p.pattern.flags.replace('g', ''));
    return probe.test(text);
  });
}

/**
 * Redacts a value destined for a log line or an error message. Unlike
 * {@link redactSecrets} this also masks anything that merely *looks* like a long
 * opaque token, because log lines have no legitimate reason to carry one.
 */
export function redactForLog(value: string): string {
  const { text } = redactSecrets(value);
  return text.replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[REDACTED:opaque_token]');
}

/**
 * Masks a credential for display, keeping enough to be recognisable.
 * `sk_live_<24+ alphanumerics>` becomes `sk_l…p7dc`.
 */
export function maskValue(value: string, keepStart = 4, keepEnd = 4): string {
  if (value.length <= keepStart + keepEnd) return '*'.repeat(value.length);
  return `${value.slice(0, keepStart)}…${value.slice(-keepEnd)}`;
}
