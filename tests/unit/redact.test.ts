import { describe, expect, it } from 'vitest';
import { FAKE } from '../fixtures/credentials.js';
import {
  containsSecret,
  maskValue,
  redactForLog,
  redactSecrets,
  SECRET_PATTERNS,
} from '../../src/shared/redact.js';


describe('redactSecrets', () => {
  it('removes a Stripe secret key and records the finding', () => {
    const source = `const stripe = new Stripe('${FAKE.stripe}');`;
    const { text, findings } = redactSecrets(source);

    expect(text).not.toContain(FAKE.stripe);
    expect(text).toContain('[REDACTED:stripe_secret_key]');
    expect(findings.map((f) => f.patternId)).toContain('stripe_secret_key');
  });

  it.each([
    ['GitHub token', FAKE.github, 'github_token'],
    ['AWS access key id', FAKE.aws, 'aws_access_key_id'],
    ['Google API key', FAKE.google, 'google_api_key'],
    ['JWT', FAKE.jwt, 'json_web_token'],
    ['Anthropic key', FAKE.anthropic, 'anthropic_api_key'],
  ])('detects a %s', (_label, value, patternId) => {
    const { text, findings } = redactSecrets(`token = "${value}"`);
    expect(text).not.toContain(value);
    expect(findings.some((f) => f.patternId === patternId)).toBe(true);
  });

  it('keeps the surrounding syntax when redacting an assignment', () => {
    const { text } = redactSecrets(`DATABASE_PASSWORD = "hunter2-hunter2"`);
    // The shape survives so Claude can still say "the password is set here".
    expect(text).toMatch(/DATABASE_PASSWORD = "\[REDACTED:assigned_credential]"/);
  });

  it('redacts only the password segment of a connection URI', () => {
    const { text } = redactSecrets('postgres://app_user:s3cr3t-p4ss@db.internal:5432/prod');
    expect(text).toContain('postgres://app_user:');
    expect(text).toContain('@db.internal:5432/prod');
    expect(text).not.toContain('s3cr3t-p4ss');
  });

  it('removes an entire PEM private key block', () => {
    const { text } = redactSecrets(`const key = \`${FAKE.pemPrivateKey}\`;`);
    expect(text).not.toContain('MIIEowIBAAKCAQEA');
    expect(text).toContain('[REDACTED:private_key_block]');
  });

  it('leaves ordinary source untouched', () => {
    const source = 'export function signToken(userId: string): string {\n  return jwt.sign(userId);\n}';
    const { text, findings } = redactSecrets(source);
    expect(text).toBe(source);
    expect(findings).toHaveLength(0);
  });

  it('is idempotent — redacting twice changes nothing further', () => {
    const once = redactSecrets(`key = "${FAKE.github}"`).text;
    expect(redactSecrets(once).text).toBe(once);
  });

  it('handles empty input', () => {
    expect(redactSecrets('')).toEqual({ text: '', findings: [] });
  });
});

describe('pattern hygiene', () => {
  it('every pattern is global, so replace() covers all occurrences', () => {
    for (const { id, pattern } of SECRET_PATTERNS) {
      expect(pattern.flags, `pattern ${id}`).toContain('g');
    }
  });

  it('pattern ids are unique', () => {
    const ids = SECRET_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('repeated containsSecret calls do not drift due to regex lastIndex', () => {
    const sample = `key = "${FAKE.github}"`;
    expect(containsSecret(sample)).toBe(true);
    expect(containsSecret(sample)).toBe(true);
    expect(containsSecret('const total = a + b;')).toBe(false);
  });
});

describe('redactForLog', () => {
  it('masks long opaque tokens that no pattern claims', () => {
    const opaque = 'Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FycGx5' + 'AAAABBBB';
    expect(redactForLog(`bearer ${opaque}`)).toContain('[REDACTED:opaque_token]');
  });

  it('leaves short identifiers alone', () => {
    expect(redactForLog('parsing src/auth/jwt.ts')).toBe('parsing src/auth/jwt.ts');
  });
});

describe('maskValue', () => {
  it('keeps recognisable head and tail', () => {
    expect(maskValue(FAKE.stripeShort)).toBe('sk_l…p7dc');
  });

  it('fully masks values too short to partially reveal', () => {
    expect(maskValue('abc')).toBe('***');
  });
});
