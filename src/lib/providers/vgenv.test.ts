import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider, VgenvProvider } from "./index";
import type { VideoOptions } from "./types";

const options: VideoOptions = {
  modelId: "base",
  mode: "text-to-video",
  prompt: "A paper city at sunrise",
  width: 720,
  height: 1280,
  duration: 5,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("VgenvProvider", () => {
  it("registers with the default V3 endpoint and exposes Base first", async () => {
    const provider = createProvider({ name: "vgenv", apiKey: "test-key", baseUrl: "" });
    expect(provider).toBeInstanceOf(VgenvProvider);
    expect((await provider.listModels("video")).map((model) => model.id)).toEqual([
      "base",
      "cinematic",
      "origin",
    ]);
    expect((await provider.listModels("image")).length).toBe(0);
  });

  it("submits a text-to-video task with V3 fields and an idempotency key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "vid_123", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new VgenvProvider({ name: "vgenv", apiKey: "secret", baseUrl: "" });

    const task = await provider.submitVideoTask(options);

    expect(task).toEqual({ taskId: "vid_123", modelId: "base" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.vgenv.com/v3/videos");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer secret");
    expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(/^clipforge-/);
    expect(JSON.parse(String(init.body))).toEqual({
      model: "base",
      tier: "base",
      prompt: options.prompt,
      duration: 5,
      resolution: "768p",
      aspect_ratio: "9:16",
      upscale: false,
  });
  });

  it("sends first/last frames and reference media through the V3 envelope", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init: init ?? {} });
      return jsonResponse({ id: url.endsWith("/videos") ? `vid_${requests.length}` : "vid_reference", status: "queued" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new VgenvProvider({ name: "vgenv", apiKey: "secret", baseUrl: "" });

    await provider.submitVideoTask({ ...options, mode: "image-to-video", firstFrameUrl: "https://cdn.example/first.png", lastFrameUrl: "https://cdn.example/last.png" });
    const frameBody = JSON.parse(String(requests[0].init.body));
    expect(frameBody).toMatchObject({ resolution: "768p", upscale: false, frame_images: [
      { type: "image_url", image_url: { url: "https://cdn.example/first.png" }, frame_type: "first_frame" },
      { type: "image_url", image_url: { url: "https://cdn.example/last.png" }, frame_type: "last_frame" },
    ] });

    await provider.submitVideoTask({ ...options, mode: "video-to-video", referenceImageUrls: ["https://cdn.example/ref.png"], referenceVideoUrls: ["https://cdn.example/ref.mp4"], referenceAudioUrls: ["https://cdn.example/ref.wav"] });
    const referenceBody = JSON.parse(String(requests[1].init.body));
    expect(referenceBody).toMatchObject({ resolution: "768p", upscale: false, reference_images: [{ type: "image_url", image_url: { url: "https://cdn.example/ref.png" } }], reference_videos: [{ type: "video_url", video_url: { url: "https://cdn.example/ref.mp4" } }], reference_audios: [{ type: "audio_url", audio_url: { url: "https://cdn.example/ref.wav" } }] });
  });

  it("maps queued/running/succeeded and returns the output URL", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "vid_123", status: "queued" }))
      .mockResolvedValueOnce(jsonResponse({ id: "vid_123", status: "running", progress: 42 }))
      .mockResolvedValueOnce(jsonResponse({
        id: "vid_123",
        status: "succeeded",
        output: { url: "https://cdn.example/video.mp4" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new VgenvProvider({ name: "vgenv", apiKey: "secret", baseUrl: "" });

    expect((await provider.getTaskStatus("vid_123")).status).toBe("pending");
    expect((await provider.getTaskStatus("vid_123")).progress).toBe(42);
    const done = await provider.getTaskStatus("vid_123");
    expect(done.status).toBe("completed");
    expect(done.result && "videoUrls" in done.result ? done.result.videoUrls : []).toEqual([
      "https://cdn.example/video.mp4",
    ]);
  });

  it("rejects unsupported models, modes and durations before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new VgenvProvider({ name: "vgenv", apiKey: "secret", baseUrl: "" });

    await expect(provider.submitVideoTask({ ...options, modelId: "minimax-h3" })).rejects.toThrow("不支持模型");
    await expect(provider.submitVideoTask({ ...options, mode: "unsupported" as VideoOptions["mode"] })).rejects.toThrow("不支持当前视频模式");
    await expect(provider.submitVideoTask({ ...options, duration: 16 })).rejects.toThrow("4–15 秒");
    await expect(provider.submitVideoTask({ ...options, duration: 11, maxDurationSeconds: 10 })).rejects.toThrow("4–10 秒");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a rejected task using the server Retry-After value", async () => {
    const limited = new Response(JSON.stringify({ error: "rate limited" }), {
      status: 429,
      headers: { "Retry-After": "0", "Content-Type": "application/json" },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(limited)
      .mockResolvedValueOnce(jsonResponse({ id: "vid_123", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new VgenvProvider({ name: "vgenv", apiKey: "secret", baseUrl: "" });

    await expect(provider.submitVideoTask(options)).resolves.toMatchObject({ taskId: "vid_123" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get("Idempotency-Key"))
      .toBe(new Headers(fetchMock.mock.calls[1][1].headers).get("Idempotency-Key"));
  });

  it("surfaces authorization errors from the provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "denied" }, 403));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new VgenvProvider({ name: "vgenv", apiKey: "secret", baseUrl: "" });

    await expect(provider.submitVideoTask(options)).rejects.toMatchObject({
      name: "ProviderError",
      statusCode: 403,
    });
  });

});
