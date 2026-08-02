import jwt from 'jsonwebtoken';
import { loadSecret } from './secrets.js';

/** Signs a short-lived access token for a user. */
export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, loadSecret(), { expiresIn: '15m' });
}

/** Verifies an access token, returning the subject or null. */
export function verifyToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, loadSecret());
    if (typeof decoded === 'object' && decoded !== null && 'sub' in decoded) {
      return String(decoded.sub);
    }
    return null;
  } catch {
    return null;
  }
}

// Never referenced anywhere — the dead-code check should surface this.
function legacyDecode(token: string): string {
  return Buffer.from(token.split('.')[1] ?? '', 'base64').toString('utf8');
}
