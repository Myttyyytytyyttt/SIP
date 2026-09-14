// base64 on Uint8Array through atob/btoa, which browsers and Node 22 both
// provide, so account data from getAccountInfo can be decoded in the browser
// entry without Node's byte-array class.

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict standard base64 (no URL alphabet, no whitespace), or null. */
export function tryBase64Decode(text: unknown): Uint8Array | null {
  if (typeof text !== "string" || text.length % 4 !== 0 || !BASE64.test(text)) return null;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: String.fromCharCode with a spread argument overflows the stack on
  // large inputs.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
