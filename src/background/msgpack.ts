// Minimal MessagePack decoder/encoder for the SignalR hub protocol (live sync).

export function decodeMsgpack(buf: Uint8Array): any {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  const td = new TextDecoder();
  const str = (n: number) => {
    const s = td.decode(buf.subarray(pos, pos + n));
    pos += n;
    return s;
  };
  const bin = (n: number) => {
    const b = buf.slice(pos, pos + n);
    pos += n;
    return b;
  };
  const arr = (n: number): any[] => {
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = read();
    return a;
  };
  const map = (n: number): Record<string, any> => {
    const o: Record<string, any> = {};
    for (let i = 0; i < n; i++) {
      const k = read();
      o[String(k)] = read();
    }
    return o;
  };
  const ext = (n: number): any => {
    const type = view.getInt8(pos++);
    const data = buf.subarray(pos, pos + n);
    pos += n;
    if (type === -1) {
      // timestamp extension
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (n === 4) return new Date(dv.getUint32(0) * 1000);
      if (n === 8) {
        const hi = dv.getUint32(0);
        const lo = dv.getUint32(4);
        const nsec = hi >>> 2;
        const sec = (hi & 0x3) * 2 ** 32 + lo;
        return new Date(sec * 1000 + nsec / 1e6);
      }
      if (n === 12) return new Date(Number(dv.getBigInt64(4)) * 1000 + dv.getUint32(0) / 1e6);
    }
    return { ext: type, data: data.slice() };
  };
  function read(): any {
    const b = buf[pos++];
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 0x100;
    if (b >= 0x80 && b <= 0x8f) return map(b & 0x0f);
    if (b >= 0x90 && b <= 0x9f) return arr(b & 0x0f);
    if (b >= 0xa0 && b <= 0xbf) return str(b & 0x1f);
    let v: any;
    switch (b) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return bin(buf[pos++]);
      case 0xc5:
        v = view.getUint16(pos);
        pos += 2;
        return bin(v);
      case 0xc6:
        v = view.getUint32(pos);
        pos += 4;
        return bin(v);
      case 0xc7:
        return ext(buf[pos++]);
      case 0xc8:
        v = view.getUint16(pos);
        pos += 2;
        return ext(v);
      case 0xc9:
        v = view.getUint32(pos);
        pos += 4;
        return ext(v);
      case 0xca:
        v = view.getFloat32(pos);
        pos += 4;
        return v;
      case 0xcb:
        v = view.getFloat64(pos);
        pos += 8;
        return v;
      case 0xcc:
        return buf[pos++];
      case 0xcd:
        v = view.getUint16(pos);
        pos += 2;
        return v;
      case 0xce:
        v = view.getUint32(pos);
        pos += 4;
        return v;
      case 0xcf:
        v = Number(view.getBigUint64(pos));
        pos += 8;
        return v;
      case 0xd0:
        return view.getInt8(pos++);
      case 0xd1:
        v = view.getInt16(pos);
        pos += 2;
        return v;
      case 0xd2:
        v = view.getInt32(pos);
        pos += 4;
        return v;
      case 0xd3:
        v = Number(view.getBigInt64(pos));
        pos += 8;
        return v;
      case 0xd4:
        return ext(1);
      case 0xd5:
        return ext(2);
      case 0xd6:
        return ext(4);
      case 0xd7:
        return ext(8);
      case 0xd8:
        return ext(16);
      case 0xd9:
        return str(buf[pos++]);
      case 0xda:
        v = view.getUint16(pos);
        pos += 2;
        return str(v);
      case 0xdb:
        v = view.getUint32(pos);
        pos += 4;
        return str(v);
      case 0xdc:
        v = view.getUint16(pos);
        pos += 2;
        return arr(v);
      case 0xdd:
        v = view.getUint32(pos);
        pos += 4;
        return arr(v);
      case 0xde:
        v = view.getUint16(pos);
        pos += 2;
        return map(v);
      case 0xdf:
        v = view.getUint32(pos);
        pos += 4;
        return map(v);
    }
    throw new Error("msgpack: unsupported type 0x" + b.toString(16));
  }
  return read();
}

/** SignalR binary framing: each message is prefixed with its length as a VarInt. */
export function splitFrames(buf: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let pos = 0;
  while (pos < buf.length) {
    let len = 0;
    let shift = 0;
    let b: number;
    do {
      b = buf[pos++];
      len |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80 && shift < 35);
    out.push(buf.subarray(pos, pos + len));
    pos += len;
  }
  return out;
}

/** A framed message of small, already encoded MessagePack bytes (length < 128). */
export function frame(msg: number[]): Uint8Array {
  return new Uint8Array([msg.length, ...msg]);
}

/** SignalR ping: [6] */
export const PING = frame([0x91, 0x06]);
