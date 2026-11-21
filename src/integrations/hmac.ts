import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 as hex or base64, compared without leaking timing. A different length is simply false. */
export function hmacMatches(
  secret: string,
  data: string | Buffer,
  given: string,
  encoding: "hex" | "base64",
): boolean {
  const expected = Buffer.from(createHmac("sha256", secret).update(data).digest(encoding));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function parseJson(rawBody: Buffer): unknown {
  return JSON.parse(rawBody.toString("utf8"));
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v !== "";

/** True when ANY of the secrets gives the signature. Each check is constant time; all are always run. */
export function hmacMatchesAny(
  secrets: string[],
  data: string | Buffer,
  given: string,
  encoding: "hex" | "base64",
): boolean {
  let ok = false;
  for (const secret of secrets) if (hmacMatches(secret, data, given, encoding)) ok = true;
  return ok;
}

/** The secrets a connection may verify with. */
export const verifyingSecrets = (conn: { webhookSecret: string; webhookSecrets?: string[] }): string[] =>
  conn.webhookSecrets ?? [conn.webhookSecret];
