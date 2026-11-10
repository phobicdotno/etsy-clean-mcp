import fs from "node:fs";
import path from "node:path";
import { expandHome } from "./config.js";

export const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export class UploadPathError extends Error {
  override name = "UploadPathError";
}

export interface ResolvedImage {
  realPath: string;
  fileName: string;
  mime: string;
  size: number;
}

/**
 * Resolve an image path and make sure it really lives inside the upload folder.
 * Relative paths are taken relative to that folder. Symlinks are followed first,
 * so a link pointing outside (or at a non-image) is refused.
 */
export function resolveUploadImage(input: string, uploadDir: string): ResolvedImage {
  let root: string;
  try {
    root = fs.realpathSync(uploadDir);
  } catch {
    throw new UploadPathError(`Upload folder ${uploadDir} does not exist. Create it and put the images there.`);
  }
  const expanded = expandHome(input.trim());
  const candidate = path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new UploadPathError(`File not found: ${input}`);
  }
  const rel = path.relative(root, real);
  if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new UploadPathError(`Refused: ${input} is outside the upload folder ${root}.`);
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new UploadPathError(`Not a file: ${input}`);
  const ext = path.extname(real).toLowerCase();
  const mime = IMAGE_TYPES[ext];
  if (!mime) {
    throw new UploadPathError(`Refused: only .jpg, .jpeg, .png, .gif and .webp images can be uploaded (got ${ext || "no extension"}).`);
  }
  return { realPath: real, fileName: path.basename(real), mime, size: stat.size };
}

export function buildImageForm(img: ResolvedImage, extra: { rank?: number; alt_text?: string }): FormData {
  const bytes = fs.readFileSync(img.realPath);
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: img.mime }), img.fileName);
  if (extra.rank !== undefined) form.append("rank", String(extra.rank));
  if (extra.alt_text !== undefined) form.append("alt_text", extra.alt_text);
  return form;
}
