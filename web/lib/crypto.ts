// Browser-side passphrase encryption of the claim secret key (WebCrypto).
// PBKDF2-SHA256 (600k iterations) -> AES-256-GCM, bound to the claim public key via AAD.
export const PBKDF2_ITER = 600_000;
const te = new TextEncoder();

export type Blob = { v: 1; iter: number; salt: string; iv: string; ct: string };

export const b64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
};
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sha256Hex(text: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function deriveKey(pass: string, salt: Uint8Array, iter: number) {
  const base = await crypto.subtle.importKey("raw", te.encode(pass.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: iter },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptSecret(secret: Uint8Array, pass: string, aad: string): Promise<Blob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt, PBKDF2_ITER);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: te.encode(aad) }, key, secret as BufferSource)
  );
  return { v: 1, iter: PBKDF2_ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export async function decryptSecret(blob: Blob, pass: string, aad: string): Promise<Uint8Array> {
  if (blob.v !== 1 || blob.iter < 100_000 || blob.iter > 2_000_000) throw new Error("Unsupported key bundle");
  const key = await deriveKey(pass, unb64(blob.salt), blob.iter);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(blob.iv) as BufferSource, additionalData: te.encode(aad) },
      key,
      unb64(blob.ct) as BufferSource
    );
    return new Uint8Array(pt);
  } catch {
    throw new Error("Wrong passphrase");
  }
}
