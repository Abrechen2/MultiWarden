// TOTP generation (RFC 6238) including otpauth:// URIs and Steam Guard codes.

const STEAM_CHARS = "23456789BCDFGHJKMNPQRTVWXY";

function base32Decode(input: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error("Ungültiges Base32-Zeichen");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export interface TotpParams {
  secret: Uint8Array;
  digits: number;
  period: number;
  algorithm: "SHA-1" | "SHA-256" | "SHA-512";
  steam: boolean;
}

export function parseTotp(raw: string): TotpParams | null {
  if (!raw) return null;
  const s = raw.trim();
  try {
    if (s.toLowerCase().startsWith("steam://")) {
      return { secret: base32Decode(s.slice(8)), digits: 5, period: 30, algorithm: "SHA-1", steam: true };
    }
    if (s.toLowerCase().startsWith("otpauth://")) {
      const u = new URL(s);
      const secret = u.searchParams.get("secret") ?? "";
      const digits = parseInt(u.searchParams.get("digits") ?? "6", 10);
      const period = parseInt(u.searchParams.get("period") ?? "30", 10);
      const alg = (u.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
      const algorithm = alg === "SHA256" ? "SHA-256" : alg === "SHA512" ? "SHA-512" : "SHA-1";
      const isSteam = (u.searchParams.get("encoder") ?? "").toLowerCase() === "steam";
      return {
        secret: base32Decode(secret),
        digits: isSteam ? 5 : Math.min(Math.max(digits || 6, 1), 10),
        period: period > 0 ? period : 30,
        algorithm,
        steam: isSteam,
      };
    }
    return { secret: base32Decode(s), digits: 6, period: 30, algorithm: "SHA-1", steam: false };
  } catch {
    return null;
  }
}

export async function generateTotp(raw: string, now = Date.now()): Promise<{ code: string; remaining: number; period: number } | null> {
  const p = parseTotp(raw);
  if (!p || p.secret.length === 0) return null;
  const counter = Math.floor(now / 1000 / p.period);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const key = await crypto.subtle.importKey("raw", p.secret.slice().buffer as ArrayBuffer, { name: "HMAC", hash: p.algorithm }, false, [
    "sign",
  ]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg.buffer as ArrayBuffer));
  const off = h[h.length - 1] & 0x0f;
  let bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  let code: string;
  if (p.steam) {
    code = "";
    for (let i = 0; i < p.digits; i++) {
      code += STEAM_CHARS[bin % STEAM_CHARS.length];
      bin = Math.floor(bin / STEAM_CHARS.length);
    }
  } else {
    code = (bin % 10 ** p.digits).toString().padStart(p.digits, "0");
  }
  const remaining = p.period - (Math.floor(now / 1000) % p.period);
  return { code, remaining, period: p.period };
}
