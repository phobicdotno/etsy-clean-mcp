import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildImageForm, resolveUploadImage } from "../src/upload.js";
import { tmpDir } from "./helpers.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function layout() {
  const base = tmpDir();
  const upload = path.join(base, "upload");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(upload, "sub"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(upload, "clock.png"), PNG);
  fs.writeFileSync(path.join(upload, "sub", "Photo.JPG"), "jpegdata");
  fs.writeFileSync(path.join(upload, "notes.txt"), "hello");
  fs.writeFileSync(path.join(outside, "secret.png"), PNG);
  fs.writeFileSync(path.join(outside, "passwd"), "root:x:0:0");
  return { base, upload, outside };
}

describe("upload path guard", () => {
  it("accepts images inside the folder, relative or absolute", () => {
    const { upload } = layout();
    const a = resolveUploadImage("clock.png", upload);
    expect(a.mime).toBe("image/png");
    expect(a.size).toBe(PNG.length);
    const b = resolveUploadImage(path.join(upload, "sub", "Photo.JPG"), upload);
    expect(b.mime).toBe("image/jpeg");
  });

  it("refuses ../ escapes", () => {
    const { upload } = layout();
    expect(() => resolveUploadImage("../outside/secret.png", upload)).toThrow(/outside the upload folder/);
    expect(() => resolveUploadImage("sub/../../outside/secret.png", upload)).toThrow(/outside the upload folder/);
  });

  it("refuses absolute paths outside the folder", () => {
    const { upload, outside } = layout();
    expect(() => resolveUploadImage(path.join(outside, "secret.png"), upload)).toThrow(/outside the upload folder/);
  });

  it("refuses a symlink inside the folder that points outside", () => {
    const { upload, outside } = layout();
    fs.symlinkSync(path.join(outside, "secret.png"), path.join(upload, "link.png"));
    expect(() => resolveUploadImage("link.png", upload)).toThrow(/outside the upload folder/);
  });

  it("refuses a symlinked folder that points outside", () => {
    const { upload, outside } = layout();
    fs.symlinkSync(outside, path.join(upload, "escape"));
    expect(() => resolveUploadImage("escape/secret.png", upload)).toThrow(/outside the upload folder/);
  });

  it("refuses an image-named symlink that points at a non-image inside", () => {
    const { upload } = layout();
    fs.symlinkSync(path.join(upload, "notes.txt"), path.join(upload, "fake.jpg"));
    expect(() => resolveUploadImage("fake.jpg", upload)).toThrow(/only \.jpg/);
  });

  it("refuses wrong extensions and folders", () => {
    const { upload } = layout();
    expect(() => resolveUploadImage("notes.txt", upload)).toThrow(/only \.jpg/);
    expect(() => resolveUploadImage("sub", upload)).toThrow(/Not a file/);
    expect(() => resolveUploadImage(".", upload)).toThrow(/outside the upload folder/);
    expect(() => resolveUploadImage("missing.png", upload)).toThrow(/File not found/);
  });

  it("explains a missing upload folder", () => {
    expect(() => resolveUploadImage("a.png", path.join(tmpDir(), "nope"))).toThrow(/does not exist/);
  });

  it("builds a real multipart body with the image bytes, rank and alt text", async () => {
    const { upload } = layout();
    const form = buildImageForm(resolveUploadImage("clock.png", upload), { rank: 1, alt_text: "Word clock" });
    const file = form.get("image") as File;
    expect(file.name).toBe("clock.png");
    expect(file.type).toBe("image/png");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);
    expect(form.get("rank")).toBe("1");
    expect(form.get("alt_text")).toBe("Word clock");

    const req = new Request("http://x/", { method: "POST", body: form });
    const ct = req.headers.get("content-type")!;
    expect(ct).toMatch(/^multipart\/form-data; boundary=/);
    const raw = Buffer.from(await req.arrayBuffer()).toString("latin1");
    expect(raw).toContain('Content-Disposition: form-data; name="image"; filename="clock.png"');
    expect(raw).toContain("Content-Type: image/png");
    expect(raw).toContain(PNG.toString("latin1"));
    expect(raw).toContain('name="rank"');
  });
});
