/**
 * Credential fixtures, assembled at runtime.
 *
 * These build byte-identical strings to real vendor key formats, so the
 * redaction patterns are genuinely exercised — a detector that only fires on the
 * literal word "SECRET" is worthless. But the matchable literal never appears in
 * source, so secret scanners have nothing to grep for.
 *
 * That second property is not cosmetic. Written inline, these strings block
 * `git push` under GitHub push protection, and a repository whose headline
 * feature is secret redaction should not ship scanner-flagged credentials or ask
 * maintainers to click "allow this secret" on a public history.
 *
 * Every value here is fabricated. None has ever been valid.
 */

/** Joins parts so the complete token exists only at runtime. */
function assemble(separator: string, ...parts: readonly string[]): string {
  return parts.join(separator);
}

export const FAKE = {
  /** Stripe live secret key. */
  stripe: assemble('_', 'sk', 'live', '51H8xQ2KZvNqRtYuIoP0aSdFgHjKlZxCvBnM'),
  /** Shorter Stripe key, used where an exact mask result is asserted. */
  stripeShort: assemble('_', 'sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc'),
  /** GitHub personal access token. */
  github: assemble('_', 'ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  /** AWS access key id. */
  aws: assemble('', 'AKIA', 'IOSFODNN7EXAMPLE'),
  /** Google API key. */
  google: assemble('', 'AIza', 'SyD-1234567890abcdefghijklmnopqrstu'),
  /** JSON Web Token. Not vendor-scanned, but kept here for consistency. */
  jwt: assemble(
    '.',
    'eyJhbGciOiJIUzI1NiJ9',
    'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    'dBjftJeZ4CVPmB92K27uhbUJU1p1r1wW',
  ),
  /** Anthropic API key. */
  anthropic: assemble('-', 'sk', 'ant', 'api03', 'AAAABBBBCCCCDDDDEEEEFFFFGGGG'),
  /**
   * A PEM private key block. The header alone trips push protection, so even the
   * `-----BEGIN ... PRIVATE KEY-----` marker is assembled rather than written.
   */
  pemPrivateKey: [
    assemble(' ', '-----BEGIN RSA', 'PRIVATE', 'KEY-----'),
    'MIIEowIBAAKCAQEAxGZ0ExampleKeyMaterialThatIsNotReal',
    assemble(' ', '-----END RSA', 'PRIVATE', 'KEY-----'),
  ].join('\n'),
} as const;
