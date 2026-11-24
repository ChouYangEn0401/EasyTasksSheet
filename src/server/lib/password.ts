import { hash, verify } from '@node-rs/argon2';

// argon2id（@node-rs/argon2 預設演算法即為 argon2id）
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
