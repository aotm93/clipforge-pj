import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "./openai";

const provider = () => new OpenAIProvider({
  name: "openai",
  apiKey: "test-key",
  baseUrl: "https://api.example.test/v1",
});

afterEach(() => vi.restoreAllMocks());

describe("OpenAIProvider image edits", () => {
  it("uploads plural referenceImageUrls for multi-reference edits", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ created: 1, data: [{ b64_json: "generated" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    await provider().generateImage({
      modelId: "gpt-image-2",
      mode: "image-to-image",
      prompt: "九宫格分镜",
      referenceImageUrls: [
        "data:image/png;base64,AA==",
        "data:image/jpeg;base64,/9j/",
      ],
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe("POST");
    const form = init?.body as FormData;
    expect(Array.from(form.keys()).filter((key) => key === "image[]")).toHaveLength(2);
    expect(form.get("image[]")).toBeInstanceOf(Blob);
  });

  it("keeps the singular reference image compatible", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ created: 1, data: [{ b64_json: "generated" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    await provider().generateImage({
      modelId: "gpt-image-1.5",
      mode: "image-to-image",
      prompt: "编辑",
      referenceImageUrl: "data:image/png;base64,AA==",
    });

    const [, init] = fetchMock.mock.calls[0];
    const form = init?.body as FormData;
    expect(Array.from(form.keys()).filter((key) => key === "image[]")).toHaveLength(1);
  });

  it("rejects image-to-image generation without any reference", async () => {
    await expect(provider().generateImage({
      modelId: "gpt-image-2",
      mode: "image-to-image",
      prompt: "缺少参考图",
    })).rejects.toMatchObject({ code: "BAD_REFERENCE" });
  });
});
