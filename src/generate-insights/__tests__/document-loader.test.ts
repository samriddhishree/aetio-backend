import { describe, expect, it, vi } from "vitest";
import { loadDocumentText } from "../services/document-loader";

const makeResponse = (body: string, contentType: string) => {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get: (key: string) => (key.toLowerCase() === "content-type" ? contentType : null),
    },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  } as any;
};

describe("document-loader", () => {
  it("strips HTML and returns text", async () => {
    const html = "<html><body><h1>Title</h1><p>Hello world</p></body></html>";
    const originalFetch = (globalThis as any).fetch;
    if (!originalFetch) {
      (globalThis as any).fetch = vi.fn();
    }
    const fetchSpy = vi
      .spyOn(globalThis, "fetch" as any)
      .mockResolvedValue(makeResponse(html, "text/html"));

    const result = await loadDocumentText("https://example.com");
    expect(result.text).toContain("Title");
    expect(result.text).toContain("Hello world");

    fetchSpy.mockRestore();
    if (!originalFetch) {
      delete (globalThis as any).fetch;
    }
  });
});
