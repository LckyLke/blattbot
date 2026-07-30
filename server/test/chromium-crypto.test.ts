import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CBC_IV,
  decryptChromiumCookie,
  deriveCbcKey,
  LINUX_FALLBACK_KEY,
} from "../src/overleaf/chromium-crypto.js";

/**
 * These fixtures build real Chromium-encrypted blobs with known keys, exactly
 * as Chrome/Edge/Brave write them on each OS. They exercise the decryption
 * math independently of any actual browser or keyring, so the macOS and Windows
 * code paths are verified here on Linux CI (and everywhere else).
 */

function encryptCbc(plaintext: string, key: Buffer, prefix: "v10" | "v11", domainHash = false): Buffer {
  const body = domainHash
    ? Buffer.concat([createHash("sha256").update("overleaf.com").digest(), Buffer.from(plaintext)])
    : Buffer.from(plaintext);
  const cipher = createCipheriv("aes-128-cbc", key, CBC_IV);
  return Buffer.concat([Buffer.from(prefix), cipher.update(body), cipher.final()]);
}

function encryptGcm(plaintext: string, key: Buffer, domainHash = false): Buffer {
  const nonce = randomBytes(12);
  const body = domainHash
    ? Buffer.concat([createHash("sha256").update("overleaf.com").digest(), Buffer.from(plaintext)])
    : Buffer.from(plaintext);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), nonce, ct, cipher.getAuthTag()]);
}

const SESSION = "overleaf_session2=s%3AAbCdEf.long-signed-value-1234567890";

describe("Linux Chromium (v10, fallback key)", () => {
  it("decrypts a v10 blob with the peanuts-derived key", () => {
    const blob = encryptCbc(SESSION, LINUX_FALLBACK_KEY, "v10");
    expect(decryptChromiumCookie(blob, { cbcKey: LINUX_FALLBACK_KEY })).toBe(SESSION);
  });

  it("strips the 32-byte domain-hash prefix (Chrome ≥96)", () => {
    const blob = encryptCbc(SESSION, LINUX_FALLBACK_KEY, "v10", true);
    expect(decryptChromiumCookie(blob, { cbcKey: LINUX_FALLBACK_KEY, stripDomainHash: true })).toBe(SESSION);
  });
});

describe("Linux Chromium (v11, keyring secret)", () => {
  it("decrypts a v11 blob with a keyring-derived key (1 iteration)", () => {
    const key = deriveCbcKey("a-gnome-keyring-secret", 1);
    const blob = encryptCbc(SESSION, key, "v11", true);
    expect(decryptChromiumCookie(blob, { cbcKey: key, stripDomainHash: true })).toBe(SESSION);
  });
});

describe("macOS Chromium (v10, keychain secret, 1003 iterations)", () => {
  it("decrypts with the keychain-derived key", () => {
    const key = deriveCbcKey("a-macos-keychain-secret", 1003);
    const blob = encryptCbc(SESSION, key, "v10", true);
    expect(decryptChromiumCookie(blob, { cbcKey: key, stripDomainHash: true })).toBe(SESSION);
  });
});

describe("Windows Chromium (v10, AES-256-GCM)", () => {
  it("decrypts a GCM blob with the Local State key", () => {
    const key = randomBytes(32);
    const blob = encryptGcm(SESSION, key, true);
    expect(decryptChromiumCookie(blob, { gcmKey: key, stripDomainHash: true })).toBe(SESSION);
  });

  it("dispatches v10 to GCM when only a gcmKey is present", () => {
    const key = randomBytes(32);
    const blob = encryptGcm(SESSION, key);
    // No cbcKey → the v10 prefix must be treated as the Windows GCM scheme.
    expect(decryptChromiumCookie(blob, { gcmKey: key })).toBe(SESSION);
  });

  it("rejects a tampered GCM blob (auth tag mismatch)", () => {
    const key = randomBytes(32);
    const blob = encryptGcm(SESSION, key);
    blob[blob.length - 1] ^= 0xff;
    expect(() => decryptChromiumCookie(blob, { gcmKey: key })).toThrow();
  });
});

describe("unsupported / edge schemes", () => {
  it("returns null for app-bound v20 (needs SYSTEM DPAPI)", () => {
    const blob = Buffer.concat([Buffer.from("v20"), randomBytes(40)]);
    expect(decryptChromiumCookie(blob, { gcmKey: randomBytes(32) })).toBeNull();
  });

  it("returns null when the required key is missing", () => {
    const blob = encryptCbc(SESSION, LINUX_FALLBACK_KEY, "v10");
    expect(decryptChromiumCookie(blob, {})).toBeNull();
  });

  it("treats an unprefixed value as plaintext (legacy Linux, no keyring)", () => {
    expect(decryptChromiumCookie(Buffer.from("plainvalue"), {})).toBe("plainvalue");
  });
});
