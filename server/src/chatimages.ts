/**
 * Images the user attaches to a chat message.
 *
 * Storage is DATA_DIR/chat-uploads/<projectId>/<uuid>.<ext> — deliberately NOT
 * the project working tree: anything written there would land in the review
 * diff and be pushed to Overleaf. File names are server-generated (randomUUID),
 * never taken from the client; the media type is sniffed from the magic bytes
 * (a .png that is really a script is rejected), and both the per-file size and
 * the per-message count are capped.
 *
 * Retention: kept for as long as a transcript references them, and removed
 * wholesale when the project is deleted. Uploads happen BEFORE the send, so
 * anything that fails in between (a 409 "turn in progress", a closed tab, a
 * rejected message) leaves a file nothing can ever reach again —
 * pruneOrphanChatUploads sweeps those.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

/** The only media types a chat attachment may have. */
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

/**
 * Per-image cap, deliberately far below the round number a UI would pick.
 *
 * Both backends put the picture on the wire base64-encoded — an Anthropic
 * `image` block's `source.data`, an OpenAI `data:` URL — and base64 inflates
 * the payload to ~4/3 of the raw bytes. The Anthropic Messages API rejects an
 * image block whose encoded payload exceeds 5 MiB, so a 10 MB file (13.4 MB
 * encoded) is refused with a 400 the turn cannot recover from. 3.5 MB raw is
 * ~4.67 MB encoded: comfortably inside the limit with four of them in one
 * message. The browser downscales anything bigger before it ever gets here.
 */
export const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;

/** The per-image cap as messages spell it ("3.5 MB") — one wording everywhere. */
export function imageLimitLabel(bytes: number = MAX_IMAGE_BYTES): string {
  const mb = bytes / 1024 / 1024;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/**
 * An orphan younger than this is spared: its send may still be in flight (the
 * composer uploads first, then posts the message).
 */
export const ORPHAN_GRACE_MS = 10 * 60 * 1000;

/** One image the user attached to a turn's message, resolved to disk. */
export interface TurnAttachment {
  /** Server-generated id (a UUID) — also the file's base name. */
  id: string;
  mime: ImageMime;
  /** Absolute path under DATA_DIR/chat-uploads/<projectId>. */
  path: string;
  bytes: number;
}

/** What the upload route hands back to the composer. */
export interface StoredChatImage {
  id: string;
  url: string;
  mime: ImageMime;
  bytes: number;
  width?: number;
  height?: number;
}

export function chatUploadsDir(projectId: string): string {
  return join(DATA_DIR, "chat-uploads", projectId);
}

const EXT_BY_MIME: Record<ImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function extForMime(mime: ImageMime): string {
  return EXT_BY_MIME[mime];
}

/**
 * The media type implied by the leading bytes, or null when the buffer is not
 * one of the four accepted image formats. Declared types and file extensions
 * are never consulted — a renamed script must not pass as a PNG.
 */
export function sniffImageMime(buf: Buffer): ImageMime | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString("latin1");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** Pixel dimensions read straight from the container header; undefined when unreadable. */
export function imageSize(buf: Buffer, mime: ImageMime): { width: number; height: number } | undefined {
  try {
    if (mime === "image/png") {
      // IHDR is always the first chunk: length+type occupy bytes 8..15.
      if (buf.length < 24 || buf.subarray(12, 16).toString("latin1") !== "IHDR") return undefined;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === "image/gif") {
      if (buf.length < 10) return undefined;
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === "image/jpeg") return jpegSize(buf);
    return webpSize(buf);
  } catch {
    return undefined;
  }
}

/** Walk the JPEG marker segments to the first frame header (SOFn). */
function jpegSize(buf: Buffer): { width: number; height: number } | undefined {
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = buf[off + 1];
    // SOF0-3, SOF5-7, SOF9-11, SOF13-15 carry the frame size; DHT/DAC/RST/SOS do not.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      off += 2;
      continue;
    }
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) return undefined;
    off += 2 + len;
  }
  return undefined;
}

/** VP8 (lossy), VP8L (lossless) and VP8X (extended) all state the canvas size. */
function webpSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 30) return undefined;
  const chunk = buf.subarray(12, 16).toString("latin1");
  if (chunk === "VP8 ") {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
    const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
    return { width: w + 1, height: h + 1 };
  }
  return undefined;
}

/** Ids are server-generated UUIDs — anything else cannot name a stored file. */
export function isChatImageId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * Validate and store one uploaded image. Throws a user-facing Error on a
 * rejected type or an oversized file — the route maps that to a 400.
 */
export function saveChatImage(projectId: string, content: Buffer): StoredChatImage {
  if (content.length === 0) throw new Error("the uploaded image is empty");
  if (content.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `image too large (max ${imageLimitLabel()} per image) — larger pictures do not fit in a single API image block`,
    );
  }
  const mime = sniffImageMime(content);
  if (!mime) {
    throw new Error("unsupported image type — attach a PNG, JPEG, WebP, or GIF");
  }
  const dir = chatUploadsDir(projectId);
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  writeFileSync(join(dir, `${id}.${extForMime(mime)}`), content, { mode: 0o600 });
  const size = imageSize(content, mime);
  return {
    id,
    url: `/api/projects/${encodeURIComponent(projectId)}/chat-image/${id}`,
    mime,
    bytes: content.length,
    ...(size ? { width: size.width, height: size.height } : {}),
  };
}

/**
 * Locate a stored image by id. The id is matched against the UUID shape first,
 * so "../../accounts.json" and friends never reach the filesystem; the
 * extension is recovered by probing the four accepted ones.
 */
export function findChatImage(projectId: string, id: unknown): { path: string; mime: ImageMime } | null {
  if (!isChatImageId(id)) return null;
  const dir = chatUploadsDir(projectId);
  for (const mime of IMAGE_MIMES) {
    const path = join(dir, `${id}.${extForMime(mime)}`);
    if (existsSync(path)) return { path, mime };
  }
  return null;
}

/**
 * Turn the ids a chat request carries into resolved attachments. Throws on a
 * malformed list, on more than MAX_IMAGES_PER_MESSAGE entries, or on an id
 * with no stored file — the chat route maps that to a 400.
 */
export function resolveAttachments(projectId: string, ids: unknown): TurnAttachment[] {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.some((v) => typeof v !== "string")) {
    throw new Error("images must be an array of image ids");
  }
  if (ids.length > MAX_IMAGES_PER_MESSAGE) {
    throw new Error(`too many images — the limit is ${MAX_IMAGES_PER_MESSAGE} per message`);
  }
  const out: TurnAttachment[] = [];
  for (const id of ids as string[]) {
    const found = findChatImage(projectId, id);
    if (!found) throw new Error(`unknown image: ${id}`);
    if (out.some((a) => a.id === id)) continue;
    out.push({ id, mime: found.mime, path: found.path, bytes: statSync(found.path).size });
  }
  return out;
}

/** Base64 payload of an attachment, for the model-facing message blocks. */
export function attachmentBase64(attachment: TurnAttachment): string {
  return readFileSync(attachment.path).toString("base64");
}

/** Called when a project is deleted — its chat images go with it. */
export function deleteChatUploads(projectId: string): void {
  rmSync(chatUploadsDir(projectId), { recursive: true, force: true });
}

/**
 * Delete stored images that no chat transcript references.
 *
 * The composer stores every picture before it posts the message, so a send
 * that never happens — POST /chat answering 409, a dropped connection, a
 * closed tab, a validation error — leaves files behind that no product
 * surface can list or remove. `referenced` is the id set of every attachment
 * any of the project's transcripts mentions; everything else in the directory
 * that is older than the grace period goes. Files whose name is not a
 * server-generated id are left alone (nothing here creates them, and deleting
 * the unknown is the wrong default).
 *
 * Returns the ids removed. Never throws: this is opportunistic housekeeping.
 */
export function pruneOrphanChatUploads(
  projectId: string,
  referenced: ReadonlySet<string>,
  now: number = Date.now(),
): string[] {
  const dir = chatUploadsDir(projectId);
  const removed: string[] = [];
  let names: string[];
  try {
    if (!existsSync(dir)) return removed;
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    const id = name.replace(/\.[^.]+$/, "");
    if (!isChatImageId(id) || referenced.has(id)) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs < ORPHAN_GRACE_MS) continue;
      rmSync(path, { force: true });
      removed.push(id);
    } catch {
      /* raced with another sweep or a delete — nothing to do */
    }
  }
  return removed;
}
