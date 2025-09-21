const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeX(str: string): string {
  const bytes = Array.from(encoder.encode(str));
  const len = bytes.length;
  let v = len;
  for (let i = 0; i < len; i += 1) {
    const n = bytes[i];
    if (n < 192) {
      if (n > 63) {
        if ((n & 63) !== 63) {
          const t = ((n & 63) + v) % 63 + 1;
          v = (t * 5) & 63;
          bytes[i] = (n & 192) | (v - 1);
        }
      } else if (n > 32) {
        const t = ((n & 31) - 1 + v) % 31 + 1;
        v = (t * 3) & 31;
        bytes[i] = v + 32;
      }
    }
  }
  return decoder.decode(new Uint8Array(bytes));
}
