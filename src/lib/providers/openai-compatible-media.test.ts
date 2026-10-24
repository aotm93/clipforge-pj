import { describe, expect, it, vi, afterEach } from "vitest";
import { OpenAICompatibleMediaProvider } from "../providers/openai-compatible-media";

const provider = () => new OpenAICompatibleMediaProvider({
  name: "openai-compatible-media",
  apiKey: "test-key",
  baseUrl: "https://api.example.test/v1",
});

afterEach(() => vi.restoreAllMocks());

describe("OpenAICompatibleMediaProvider", () => {
  it("submits the third-party async media request with reference images", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ task_id: 123 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    const result = await provider().submitVideoTask!({
      modelId: "hailuo-h3-cankaosheng",
      mode: "image-to-video",
      prompt: "角色在雪地奔跑",
      duration: 5,
      referenceImageUrls: ["https://example.test/ref.png"],
    });

    expect(result).toEqual({ taskId: "123", modelId: "hailuo-h3-cankaosheng" });
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "hailuo-h3-cankaosheng",
      prompt: "角色在雪地奔跑",
      params: {
        duration: "5",
        resolution: "768P",
        images: ["https://example.test/ref.png"],
      },
    });
  });

  it("rejects reference-video models without a reference image", async () => {
    await expect(provider().submitVideoTask!({
      modelId: "hailuo-h3-cankaosheng",
      mode: "text-to-video",
      prompt: "无参考图",
    })).rejects.toMatchObject({ code: "BAD_REFERENCE" });
  });

  it("maps a completed status response to a video result", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ is_final: true, state: "success", result_url: "https://example.test/video.mp4", progress: "100%" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    await expect(provider().getTaskStatus("123")).resolves.toMatchObject({
      taskId: "123",
      status: "completed",
      progress: 100,
      result: { videoUrls: ["https://example.test/video.mp4"] },
    });
  });
  it.each([
    { code: 200, msg: "任务创建成功", data: { "对话组ID": "202606041619000001", "任务ids": [123456], "成功数量": 1, task_id: 123456 } },
    { code: 200, data: { "任务ids": [123456] } },
    { data: { task_ids: [123456] } },
  ])("reads task IDs from the platform's creation envelope: %j", async (body) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(provider().submitVideoTask({
      modelId: "hailuo-h3-cankaosheng", mode: "image-to-video", prompt: "雪地奔跑",
      referenceImageUrls: ["https://example.test/ref.png"],
    })).resolves.toEqual({ taskId: "123456", modelId: "hailuo-h3-cankaosheng" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("polls a nested creation response through to the video result", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, data: { task_id: 123456 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, data: {
        task_id: 123456, state: "success", is_final: true, progress: "100%",
        result_url: "https://example.test/video.mp4",
      } })));
    await expect(provider().generateVideo({
      modelId: "hailuo-h3-cankaosheng", mode: "image-to-video", prompt: "雪地奔跑",
      referenceImageUrls: ["https://example.test/ref.png"],
    })).resolves.toEqual({ taskId: "123456", videoUrls: ["https://example.test/video.mp4"], modelId: "hailuo-h3-cankaosheng" });
    expect(String(fetchMock.mock.calls[1][0])).toContain("/media/status?task_id=123456");
  });

  it("reports API errors returned with HTTP 200 without retrying a paid submission", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ code: 403, msg: "余额不足" })));
    await expect(provider().submitVideoTask({
      modelId: "hailuo-h3-cankaosheng", mode: "image-to-video", prompt: "test",
      referenceImageUrls: ["https://example.test/ref.png"],
    })).rejects.toMatchObject({ code: "API_ERROR", message: "余额不足" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{ data: { task_id: " " } }, { code: 200, data: {} }])("does not retry a paid request with a missing task ID", async (body) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(provider().submitVideoTask({
      modelId: "hailuo-h3-cankaosheng", mode: "image-to-video", prompt: "test",
      referenceImageUrls: ["https://example.test/ref.png"],
    })).rejects.toMatchObject({ code: "NO_TASK_ID" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
