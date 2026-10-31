import { createHmac, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newSecret(): string {
  let bits = "";
  for (const x of randomBytes(20)) bits += x.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += A[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function decode(s: string): Buffer {
  let bits = "";
  for (const ch of s.toUpperCase()) {
    const v = A.indexOf(ch);
    if (v < 0) throw new Error("bad base32");
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function codeForStep(secret: string, step: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

// Returns the 30-second step the code belongs to (allowing one step of clock drift), or null.
export function matchStep(secret: string, code: string): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) {
    if (codeForStep(secret, now + d) === code) return now + d;
  }
  return null;
}

export function otpauthUri(username: string, secret: string): string {
  return "otpauth://totp/Franchise:" + encodeURIComponent(username) + "?secret=" + secret + "&issuer=Franchise&digits=6&period=30";
}

// The 2FA secret is stored encrypted, so a copy of the database alone cannot clone anyone's authenticator.
const key = () => {
  const k = process.env.ENCRYPTION_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(k)) throw new Error("ENCRYPTION_KEY must be 64 hex characters");
  return Buffer.from(k, "hex");
};
export function seal(text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("hex")).join(":");
}
export function unseal(s: string): string {
  const [iv, tag, enc] = s.split(":").map((h) => Buffer.from(h, "hex"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}