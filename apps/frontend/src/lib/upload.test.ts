import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: { upload: vi.fn() },
}));

import { api } from "@/lib/api";
import {
  MAX_IMAGE_BYTES,
  imageFrom,
  imageSourceFrom,
  imageUrlFrom,
  insertImageAtCursor,
  uploadImage,
} from "./upload";

const uploadMock = vi.mocked(api.upload);

function imageFile(name = "photo.png", type = "image/png", size = 4): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe("uploadImage", () => {
  beforeEach(() => {
    uploadMock.mockReset();
    uploadMock.mockResolvedValue({ url: "/api/uploads/abc" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uploads the file under the file field and returns its url", async () => {
    const file = imageFile("holiday.png");
    await expect(uploadImage(file)).resolves.toBe("/api/uploads/abc");
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [path, formData] = uploadMock.mock.calls[0];
    expect(path).toBe("/uploads");
    const uploaded = (formData as FormData).get("file") as File;
    expect(uploaded.name).toBe("holiday.png");
    expect(uploaded.type).toBe("image/png");
    expect(uploaded.size).toBe(file.size);
  });

  it("resolves the image url against an absolute API origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8000/api");
    await expect(uploadImage(imageFile())).resolves.toBe(
      "http://localhost:8000/api/uploads/abc"
    );
  });

  it("rejects unsupported, empty, and oversized files before uploading", async () => {
    await expect(uploadImage(imageFile("notes.txt", "text/plain"))).rejects.toThrow("PNG");
    await expect(uploadImage(imageFile("empty.png", "image/png", 0))).rejects.toThrow("empty");
    const huge = imageFile("huge.png", "image/png", MAX_IMAGE_BYTES + 1);
    await expect(uploadImage(huge)).rejects.toThrow("5 MB");
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("fails when the server does not return a url", async () => {
    uploadMock.mockResolvedValue({ url: "" });
    await expect(uploadImage(imageFile())).rejects.toThrow("did not return a link");
  });

  it("inserts image markdown at the current selection", async () => {
    const textarea = document.createElement("textarea");
    textarea.value = "before after";
    textarea.setSelectionRange(7, 12);
    const onChange = vi.fn();

    await insertImageAtCursor(textarea, imageFile("sunset.png"), onChange);

    expect(textarea.value).toBe("before ![sunset](/api/uploads/abc)");
    expect(onChange).toHaveBeenCalledWith("before ![sunset](/api/uploads/abc)");
  });

  it("picks the first image from a drop payload", () => {
    const text = imageFile("notes.txt", "text/plain");
    const png = imageFile("one.png");
    const jpg = imageFile("two.jpg", "image/jpeg");
    const data = { files: [text, png, jpg] } as unknown as DataTransfer;
    expect(imageFrom(data)).toBe(png);
    expect(imageFrom(null)).toBeNull();
    expect(imageFrom({ files: [] } as unknown as DataTransfer)).toBeNull();
  });

  it("falls back to clipboard items when files is empty", () => {
    const png = imageFile("screenshot.png");
    const data = {
      files: [],
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => png },
      ],
    } as unknown as DataTransfer;
    expect(imageFrom(data)).toBe(png);
  });

  it("reads an image copied from a web page as a URL", () => {
    const data = {
      files: [],
      items: [],
      getData: (type: string) =>
        type === "text/html"
          ? '<meta charset="utf-8"><img src="https://example.com/photo.png" alt="x">'
          : "",
    } as unknown as DataTransfer;
    expect(imageUrlFrom(data)).toBe("https://example.com/photo.png");
    expect(imageSourceFrom(data)).toBe("https://example.com/photo.png");
  });

  it("accepts a copied image file URL from the uri list", () => {
    const data = {
      files: [],
      items: [],
      getData: (type: string) =>
        type === "text/uri-list" ? "file:///Users/me/shot.webp\r\n" : "",
    } as unknown as DataTransfer;
    expect(imageUrlFrom(data)).toBe("file:///Users/me/shot.webp");
  });

  it("inserts a copied image URL without re-uploading it", async () => {
    const textarea = document.createElement("textarea");
    textarea.value = "note ";
    const onChange = vi.fn();

    await insertImageAtCursor(textarea, "/api/uploads/xyz", onChange);

    expect(textarea.value).toBe("note ![xyz](/api/uploads/xyz)");
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("keeps the pre-upload selection and text typed while an image uploads", async () => {
    let finish: (value: { url: string }) => void = () => {};
    uploadMock.mockImplementation(
      () => new Promise<{ url: string }>((resolve) => (finish = resolve))
    );
    const textarea = document.createElement("textarea");
    textarea.value = "before after";
    textarea.setSelectionRange(7, 12);
    const onChange = vi.fn();

    const pending = insertImageAtCursor(textarea, imageFile("slow.png"), onChange);
    // The user keeps typing while the upload is in flight.
    textarea.value = "before after plus more";
    finish({ url: "/api/uploads/slow" });
    await pending;

    expect(textarea.value.endsWith("![slow](/api/uploads/slow)")).toBe(true);
    expect(onChange).toHaveBeenCalledWith("before after plus more![slow](/api/uploads/slow)");
  });
});
