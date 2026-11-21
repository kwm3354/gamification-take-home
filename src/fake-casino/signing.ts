import { createHmac } from "node:crypto";

export const hmacHex = (secret: string, data: string): string =>
  createHmac("sha256", secret).update(data).digest("hex");

export const hmacBase64 = (secret: string, data: string): string =>
  createHmac("sha256", secret).update(data).digest("base64");

/** Change the first character so the signature is certainly wrong. */
export function breakSignature(signature: string): string {
  const first = signature[0] === "A" || signature[0] === "0" ? "B" : "A";
  return first + signature.slice(1);
}

const b64url = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

/** A JWT, HS256, as the casino would issue it to its player. */
export function signJwt(claims: Record<string, unknown>, secret: string): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  return `${head}.${body}.${b64url(sig)}`;
}
