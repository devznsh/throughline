import type { User } from './users.js';

export async function auditLogin(email: string): Promise<void> {
  await Promise.resolve();
  void email;
}

export function describeUser(user: User): string {
  return `${user.id} <${user.email}>`;
}
