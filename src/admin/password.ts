import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with scrypt. Stored form: `scrypt$N$r$p$<salt b64>$<hash b64>`.
 * Plain code: no Nest, no database.
 */
const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, { N: n, r, p }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** `salt` is for tests; the default is 16 random bytes. */
export async function hashPassword(password: string, salt: Buffer = randomBytes(SALT_LEN)): Promise<string> {
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** True when the password matches the stored form. A malformed stored value gives false. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  const salt = Buffer.from(parts[4] as string, "base64");
  const expected = Buffer.from(parts[5] as string, "base64");
  if (expected.length !== KEY_LEN) return false;
  let actual: Buffer;
  try {
    actual = await derive(password, salt, n, r, p);
  } catch {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | undefined;
/** A fixed hash of a password nobody has. Verified when the email is unknown, so both paths cost the same. */
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword("not-a-real-password", Buffer.alloc(SALT_LEN, 7));
  return dummy;
}
