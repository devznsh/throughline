import { auditLogin } from './audit.js';

export interface User { id: string; email: string; }

export async function findUser(email: string): Promise<User | null> {
  await auditLogin(email);
  return email.includes('@') ? { id: 'u1', email } : null;
}
