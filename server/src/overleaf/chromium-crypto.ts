/**
 * Chromium cookie-value decryption, all platforms.
 *
 * Chromium stores cookie values encrypted in its `Cookies` sqlite db. The
 * scheme is versioned by a short ASCII prefix on the blob:
 *   v10 (Linux)   AES-128-CBC, key = PBKDF2('peanuts', 'saltysalt', 1, sha1)
 *   v11 (Linux)   AES-128-CBC, key = PBKDF2(<keyring secret>, 'saltysalt', 1, sha1)
 *   v10 (macOS)   AES-128-CBC, key = PBKDF2(<keychain secret>, 'saltysalt', 1003, sha1)
 *   v10 (Windows) AES-256-GCM, key from Local State (DPAPI-unwrapped)
 *   v20 (Windows) app-bound AES-256-GCM — needs SYSTEM DPAPI, not supported here
 *
 * Since Chrome ~96, CBC-decrypted values carry a 32-byte SHA-256 domain hash
 * prefix that must be stripped. This module is pure (key in, plaintext out) so
 * the platform key-fetching can be tested independently of the OS keyring.
 */
import { createDecipheriv, pbkdf2Sync } from "node:crypto";

export const CHROMIUM_SALT = "saltysalt";
export const CBC_IV = Buffer.alloc(16, " ");

/** Derive the AES-128 key Chromium uses on Linux/macOS from a storage secret. */
export function deriveCbcKey(secret: string, iterations: number): Buffer {
  return pbkdf2Sync(secret, CHROMIUM_SALT, iterations, 16, "sha1");
}

export const LINUX_FALLBACK_KEY = deriveCbcKey("peanuts", 1);

export interface DecryptOptions {
  /** AES-128 key for v10/v11 CBC (Linux/macOS). */
  cbcKey?: Buffer;
  /** AES-256 key for v10 GCM (Windows Local State). */
  gcmKey?: Buffer;
  /** Chrome ≥96 prepends a 32-byte domain hash to CBC plaintext; strip it. */
  stripDomainHash?: boolean;
}

/**
 * Decrypt one Chromium cookie blob. Returns null when the scheme is present
 * but the required key is missing, or the blob is app-bound (v20).
 * Throws only on genuinely malformed input with a key present.
 */
export function decryptChromiumCookie(blob: Buffer, opts: DecryptOptions): string | null {
  if (blob.length < 3) {
    // Unencrypted legacy value (rare): return as-is.
    return blob.toString("utf8");
  }
  const prefix = blob.subarray(0, 3).toString("ascii");

  if (prefix === "v10" || prefix === "v11") {
    // Linux/macOS CBC. (Windows "v10" is GCM — see below; the OS decides which.)
    if (opts.gcmKey && !opts.cbcKey) return decryptGcm(blob, opts.gcmKey, opts.stripDomainHash);
    if (!opts.cbcKey) return null;
    return decryptCbc(blob, opts.cbcKey, opts.stripDomainHash);
  }
  if (prefix === "v20") {
    // App-bound (Windows). Requires SYSTEM-level DPAPI; unsupported.
    return null;
  }
  // No known prefix: treat as plaintext (older Linux without a keyring).
  return blob.toString("utf8");
}

function decryptCbc(blob: Buffer, key: Buffer, stripDomainHash?: boolean): string {
  const ciphertext = blob.subarray(3);
  const decipher = createDecipheriv("aes-128-cbc", key, CBC_IV);
  decipher.setAutoPadding(true);
  let out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (stripDomainHash && out.length >= 32) out = out.subarray(32);
  return out.toString("utf8");
}

function decryptGcm(blob: Buffer, key: Buffer, stripDomainHash?: boolean): string {
  // v10 | 12-byte nonce | ciphertext | 16-byte tag
  const nonce = blob.subarray(3, 15);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(15, blob.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  let out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (stripDomainHash && out.length >= 32) out = out.subarray(32);
  return out.toString("utf8");
}
