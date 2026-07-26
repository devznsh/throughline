import { describe, expect, it } from 'vitest';
import { signToken, verifyToken } from '../src/auth/jwt.js';

describe('jwt', () => {
  it('round-trips', () => {
    expect(verifyToken(signToken('u1'))).toBe('u1');
  });
});
