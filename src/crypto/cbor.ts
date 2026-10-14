// Minimal CBOR (RFC 8949) codec — enough for COSE_Encrypt0 and COSE_Key structures.

export type CborValue = number | bigint | string | Uint8Array | boolean | null | undefined | CborValue[] | CborMap | CborTagged;

export class CborMap extends Map<CborValue, CborValue> {}

export class CborTagged {
  constructor(
    public tag: number,
    public value: CborValue,
  ) {}
}

export function cborDecode(data: Uint8Array): CborValue {
  let pos = 0;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  function readArg(info: number): number | bigint {
    if (info < 24) return info;
    if (info === 24) return data[pos++];
    if (info === 25) {
      const v = view.getUint16(pos);
      pos += 2;
      return v;
    }
    if (info === 26) {
      const v = view.getUint32(pos);
      pos += 4;
      return v;
    }
    if (info === 27) {
      const v = view.getBigUint64(pos);
      pos += 8;
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    throw new Error("CBOR: unsupported additional info " + info);
  }

  function item(): CborValue {
    if (pos >= data.length) throw new Error("CBOR: unexpected end");
    const ib = data[pos++];
    const major = ib >> 5;
    const info = ib & 0x1f;
    switch (major) {
      case 0:
        return readArg(info);
      case 1: {
        const a = readArg(info);
        return typeof a === "bigint" ? -1n - a : -1 - a;
      }
      case 2: {
        if (info === 31) throw new Error("CBOR: indefinite bstr unsupported");
        const len = Number(readArg(info));
        const v = data.slice(pos, pos + len);
        pos += len;
        return v;
      }
      case 3: {
        if (info === 31) throw new Error("CBOR: indefinite tstr unsupported");
        const len = Number(readArg(info));
        const v = new TextDecoder().decode(data.subarray(pos, pos + len));
        pos += len;
        return v;
      }
      case 4: {
        const arr: CborValue[] = [];
        if (info === 31) {
          while (data[pos] !== 0xff) arr.push(item());
          pos++;
        } else {
          const len = Number(readArg(info));
          for (let i = 0; i < len; i++) arr.push(item());
        }
        return arr;
      }
      case 5: {
        const m = new CborMap();
        if (info === 31) {
          while (data[pos] !== 0xff) {
            const k = item();
            m.set(k, item());
          }
          pos++;
        } else {
          const len = Number(readArg(info));
          for (let i = 0; i < len; i++) {
            const k = item();
            m.set(k, item());
          }
        }
        return m;
      }
      case 6: {
        const tag = Number(readArg(info));
        return new CborTagged(tag, item());
      }
      case 7: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 25) {
          // half float — not needed for COSE, decode roughly
          const h = view.getUint16(pos);
          pos += 2;
          const s = h & 0x8000 ? -1 : 1;
          const e = (h >> 10) & 0x1f;
          const f = h & 0x3ff;
          return s * (e === 0 ? f * 2 ** -24 : e === 31 ? (f ? NaN : Infinity) : (1 + f / 1024) * 2 ** (e - 15));
        }
        if (info === 26) {
          const v = view.getFloat32(pos);
          pos += 4;
          return v;
        }
        if (info === 27) {
          const v = view.getFloat64(pos);
          pos += 8;
          return v;
        }
        throw new Error("CBOR: unsupported simple value " + info);
      }
    }
    throw new Error("CBOR: bad major type");
  }

  return item();
}

export function cborEncode(v: CborValue): Uint8Array {
  const out: number[] = [];

  function head(major: number, n: number | bigint) {
    const m = major << 5;
    if (typeof n === "bigint" || n > 0xffffffff) {
      const b = BigInt(n);
      out.push(m | 27);
      for (let i = 7; i >= 0; i--) out.push(Number((b >> BigInt(i * 8)) & 0xffn));
    } else if (n < 24) out.push(m | n);
    else if (n < 0x100) out.push(m | 24, n);
    else if (n < 0x10000) out.push(m | 25, n >> 8, n & 0xff);
    else out.push(m | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }

  function enc(x: CborValue) {
    if (x === null) out.push(0xf6);
    else if (x === undefined) out.push(0xf7);
    else if (x === true) out.push(0xf5);
    else if (x === false) out.push(0xf4);
    else if (typeof x === "number" || typeof x === "bigint") {
      if (typeof x === "number" && !Number.isInteger(x)) throw new Error("CBOR: floats unsupported");
      if (x >= 0) head(0, x);
      else head(1, typeof x === "bigint" ? -1n - x : -1 - x);
    } else if (typeof x === "string") {
      const b = new TextEncoder().encode(x);
      head(3, b.length);
      for (const c of b) out.push(c);
    } else if (x instanceof Uint8Array) {
      head(2, x.length);
      for (const c of x) out.push(c);
    } else if (Array.isArray(x)) {
      head(4, x.length);
      x.forEach(enc);
    } else if (x instanceof CborTagged) {
      head(6, x.tag);
      enc(x.value);
    } else if (x instanceof Map) {
      head(5, x.size);
      for (const [k, val] of x) {
        enc(k);
        enc(val);
      }
    } else throw new Error("CBOR: unsupported value");
  }

  enc(v);
  return new Uint8Array(out);
}
