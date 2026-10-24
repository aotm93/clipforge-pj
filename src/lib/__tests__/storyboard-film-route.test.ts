// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { NextRequest } from "next/server";
import type { Shot } from "@/lib/db/schema";
import { scripts } from "@/lib/db/schema";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { probeMedia } from "@/lib/media-probe";
import { getVideoModelCapabilities } from "@/lib/model-capabilities";

const state = vi.hoisted(() => ({
  directory: "", script: null as unknown,
  assets: [] as { shotId: number; filePath: string }[],
  compositions: [] as Record<string, unknown>[],
  submit: vi.fn(), wait: vi.fn(), generate: vi.fn(), record: vi.fn(), update: vi.fn(),
  twoPhase: true,
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({
  select: () => ({ from: (table: unknown) => ({ where: async () => table === scripts ? [state.script] : state.assets }) }),
  update: () => ({ set: () => ({ where: async () => undefined }) }),
  insert: (table: unknown) => ({ values: (value: Record<string, unknown>) => {
    const run = async () => {
      if (table === scripts) throw new Error("unexpected script insert");
      if ("outputPath" in value) {
        state.compositions.push(value);
        return [{ id: "film-composition", ...value }];
      }
      state.assets.push({ shotId: value.shotId as number, filePath: value.filePath as string });
      return [{ id: `film-shot-${value.shotId}`, ...value }];
    };
    return { returning: run, then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => run().then(resolve, reject) };
  } }),
}) }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.directory, getOutputDir: () => join(state.directory, "output") }));
vi.mock("@/lib/providers", () => ({ createProvider: () => ({
  generateVideo: state.generate,
  ...(state.twoPhase && { submitVideoTask: state.submit, waitForTask: state.wait }),
}) }));
vi.mock("@/lib/ai-tasks", () => ({ recordAiTask: state.record, updateAiTask: state.update }));
vi.mock("@/lib/providers/atlas-catalog", () => ({ fetchAtlasCatalog: async () => [], getCachedAtlasEntry: () => ({ priceBase: "0.1" }) }));
vi.mock("@/lib/remote-image", () => ({ toRemoteUsableImage: async (url: string) => url }));
import { POST } from "@/app/api/project/[id]/storyboard-film/route";

let segmentBytes: Buffer;
const model = "hailuo-h3-cankaosheng";
function shot(shotId: number, duration: number): Shot {
  return { shotId, duration, type: "hook", description: `画面${shotId}`, camera: "固定", visualSource: "ai_generate", transition: "direct_concat", voiceover: `第${shotId}镜台词` };
}
function setShots(shots: Shot[]): void {
  state.script = { id: "script-a", shots, characters: [] };
  state.assets = shots.map((item) => ({ shotId: item.shotId, filePath: `https://media.example.test/shot-${item.shotId}.png` }));
}
async function request(body: Record<string, unknown> = {}): Promise<Response> {
  return POST(new NextRequest("http://localhost/api/project/project-a/storyboard-film", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scriptId: "script-a", provider: "custom", apiKey: "test-key", model, ...body }),
  }), { params: Promise.resolve({ id: "project-a" }) });
}
beforeAll(async () => {
  state.directory = await mkdtemp(join(tmpdir(), "clipforge-film-route-"));
  const fixture = join(state.directory, "segment.mp4");
  execFileSync(ffmpegBin(), ["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=2:d=15", "-f", "lavfi", "-i", "sine=frequency=440:duration=15", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", fixture], { stdio: "pipe" });
  segmentBytes = await readFile(fixture);
}, 30_000);
afterAll(async () => { await rm(state.directory, { recursive: true, force: true }); });
beforeEach(() => {
  vi.clearAllMocks();
  setShots([shot(1, 15), shot(2, 15)]);
  state.compositions = [];
  state.twoPhase = true;
  state.submit.mockImplementation(async () => ({ taskId: `paid-${state.submit.mock.calls.length}`, modelId: model }));
  state.wait.mockImplementation(async () => ({ result: { videoUrls: [`data:video/mp4;base64,${segmentBytes.toString("base64")}`] } }));
  state.generate.mockImplementation(async () => ({ videoUrls: ["https://media.example.test/legacy.mp4"], modelId: model }));
  state.record.mockImplementation(async () => `row-${state.record.mock.calls.length}`);
  state.update.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(segmentBytes))));
});
afterAll(() => { vi.unstubAllGlobals(); });

describe("storyboard film generation", () => {
  it("recognizes the custom H3 alias as a reference model with a 15-second cap", () => {
    expect(getVideoModelCapabilities(model)).toMatchObject({ confidence: "known", referenceImages: true, nativeAudio: true, maxReferenceImages: 9 });
    expect(Math.max(...getVideoModelCapabilities(model).durationValues!)).toBe(15);
  });

  it("previews the full 30-second spend and both prompts without submitting", async () => {
    const response = await request({ dryRun: true });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toMatchObject({ model, seconds: 30, segmentCount: 2, segmentSeconds: [15, 15], referenceImages: 2, estimate: { seconds: 30, maxUsd: 6 } });
    expect(data.prompt).toContain("画面1");
    expect(data.prompt).toContain("画面2");
    expect(state.submit).not.toHaveBeenCalled();
  });

  it("groups seven unequal original shots into two near-15-second tasks and saves clips by original shot ID", async () => {
    const shots = [3, 4, 3, 4, 3, 4, 3].map((duration, index) => shot(index + 1, duration));
    setShots(shots);
    const response = await request();
    expect(response.status, (await response.clone().json()).error).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ scriptSeconds: 24, segmentCount: 2, segments: [
      { shotIds: [1, 2, 3, 4], timelineSeconds: 14, seconds: 14 },
      { shotIds: [5, 6, 7], timelineSeconds: 10, seconds: 10 },
    ] });
    expect(state.submit).toHaveBeenCalledTimes(2);
    expect(state.submit.mock.calls.map(([options]) => options.prompt)).toEqual([
      expect.stringContaining("画面1"), expect.stringContaining("画面5"),
    ]);
    expect(state.assets.slice(shots.length).map((asset) => asset.shotId)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const output = await probeMedia(state.compositions[0].outputPath as string);
    expect(output.duration).toBeGreaterThanOrEqual(24);
    expect(output.duration).toBeLessThan(24.5);
  }, 30_000);

  it("generates two paid segments, aligns each original shot, and merges a playable 30-second film", async () => {
    const response = await request({ characterSheetUrl: "https://media.example.test/presenter.png" });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ modelId: model, seconds: 30, segmentCount: 2, taskIds: ["paid-1", "paid-2"], compositionId: "film-composition", segments: [
      { shotIds: [1], timelineSeconds: 15, seconds: 15 }, { shotIds: [2], timelineSeconds: 15, seconds: 15 },
    ] });
    expect(state.submit).toHaveBeenCalledTimes(2);
    expect(state.submit.mock.calls[0][0]).toMatchObject({ modelId: model, duration: 15, referenceImageUrls: ["https://media.example.test/presenter.png", state.assets[0].filePath] });
    expect(state.submit.mock.calls[1][0]).toMatchObject({ modelId: model, duration: 15, referenceImageUrls: ["https://media.example.test/presenter.png", state.assets[1].filePath, expect.stringMatching(/^data:image\/jpeg;base64,/)] });
    expect(state.record.mock.invocationCallOrder[0]).toBeLessThan(state.wait.mock.invocationCallOrder[0]);
    expect(state.record.mock.invocationCallOrder[1]).toBeLessThan(state.wait.mock.invocationCallOrder[1]);
    expect(state.update).toHaveBeenCalledWith("row-2", expect.objectContaining({ status: "completed" }));
    const output = await probeMedia(state.compositions[0].outputPath as string);
    expect(output.duration).toBeGreaterThanOrEqual(30);
    expect(output.duration).toBeLessThan(30.5);
    expect(output.hasAudio).toBe(true);
  }, 30_000);


  it("keeps the one-segment path and supports providers without task polling", async () => {
    state.twoPhase = false;
    setShots([shot(1, 7), shot(2, 8)]);
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ segmentCount: 1, seconds: 15, modelId: model });
    expect(state.generate).toHaveBeenCalledWith(expect.objectContaining({ modelId: model, duration: 15 }));
    expect(state.submit).not.toHaveBeenCalled();
  });

  it("enforces the spending cap against all segments before any paid submit", async () => {
    expect((await request({ spendCapUsd: 5 })).status).toBe(400);
    expect(state.submit).not.toHaveBeenCalled();
  });

  it("preserves completed segments and task IDs when a later poll is interrupted", async () => {
    state.wait.mockResolvedValueOnce({ result: { videoUrls: ["https://media.example.test/paid-1.mp4"] } }).mockRejectedValueOnce(new Error("poll disconnected"));
    const response = await request();
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ recoverable: true, taskIds: ["paid-1", "paid-2"], completedSegmentUrls: ["https://media.example.test/paid-1.mp4"] });
    expect(state.update).toHaveBeenLastCalledWith("row-2", expect.objectContaining({ status: "unknown" }));
    expect(state.compositions).toHaveLength(0);
  });

  it("resumes a persisted task after polling interruption without another paid submit", async () => {
    state.wait.mockResolvedValueOnce({ result: { videoUrls: ["https://media.example.test/paid-1.mp4"] } }).mockRejectedValueOnce(new Error("poll disconnected"));
    const first = await request();
    expect(first.status).toBe(504);
    const interrupted = await first.json();
    expect(interrupted.filmRunId).toBeTruthy();
    state.wait.mockResolvedValue({ result: { videoUrls: ["https://media.example.test/paid-2.mp4"] } });
    const resumed = await request({ filmRunId: interrupted.filmRunId });
    expect(resumed.status, (await resumed.clone().json()).error).toBe(200);
    const result = await resumed.json();
    expect(result.taskIds).toEqual(["paid-1", "paid-2"]);
    expect(state.submit).toHaveBeenCalledTimes(2);
    expect(state.wait).toHaveBeenCalledTimes(3);
    expect(state.submit.mock.calls[1][0].referenceImageUrls.at(-1)).toMatch(/^data:image\/jpeg;base64,/);
    expect(result.url).toContain("/api/output/project-a/film_");
  }, 30_000);

  it("never resubmits after a submit connection error with unknown billing state", async () => {
    state.submit.mockRejectedValueOnce(new Error("connection reset"));
    const first = await request();
    expect(first.status, (await first.clone().json()).error).toBe(502);
    const interrupted = await first.json();
    const resumed = await request({ filmRunId: interrupted.filmRunId });
    expect(resumed.status).toBe(502);
    expect((await resumed.json()).error).toContain("勿重复");
    expect(state.submit).toHaveBeenCalledTimes(1);
    expect(state.wait).not.toHaveBeenCalled();
  });

  it.each([null, new Error("database unavailable")])("returns the paid task ID without polling when persistence fails: %s", async (failure) => {
    if (failure instanceof Error) state.record.mockRejectedValueOnce(failure);
    else state.record.mockResolvedValueOnce(failure);
    const response = await request();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      taskId: "paid-1", taskIds: ["paid-1"], modelId: model,
      recoverable: true, completedSegmentUrls: [],
    });
    expect(state.submit).toHaveBeenCalledTimes(1);
    expect(state.wait).not.toHaveBeenCalled();
    expect(state.compositions).toHaveLength(0);
  });

  it("checks the reference quota per segment, including the presenter sheet", async () => {
    setShots(Array.from({ length: 9 }, (_, index) => shot(index + 1, index === 8 ? 2 : 3.5)));
    const response = await request({ characterSheetUrl: "https://media.example.test/presenter.png" });
    expect(response.status).toBe(200);
    expect(state.submit.mock.calls.every(([options]) => options.referenceImageUrls.length <= 9)).toBe(true);
  }, 30_000);

  it("refuses missing keyframes before submitting any segment", async () => {
    state.assets = [];
    expect((await request()).status).toBe(400);
    expect(state.submit).not.toHaveBeenCalled();
  });
});
