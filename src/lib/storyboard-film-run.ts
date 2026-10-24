import { mkdir, readFile, writeFile, rename, unlink, readdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { getOutputDir } from "@/lib/paths";
import type { FilmSegment } from "@/lib/storyboard-film";
import type { VideoOptions, AIProvider } from "@/lib/providers/types";
import { ProviderError } from "@/lib/providers/base";
import { recordAiTask, updateAiTask } from "@/lib/ai-tasks";
import { extractLastFrame } from "@/lib/video-composer/frame-extract";
import { probeMedia } from "@/lib/media-probe";

export type FilmSegmentState = "queued" | "submitting" | "polling" | "unknown" | "failed" | "completed";
export interface FilmRunSegment {
  plan: FilmSegment;
  options: VideoOptions;
  state: FilmSegmentState;
  taskId?: string;
  rowId?: string;
  remoteUrl?: string;
  localUrl?: string;
  tailFrame?: string;
  error?: string;
  continuityApplied?: boolean;
}
export interface FilmRun {
  version: 1;
  id: string;
  projectId: string;
  scriptId: string;
  provider: string;
  baseUrl: string;
  model: string;
  createdAt: string;
  // Frozen inputs: actual prompts, references and output settings, never API credentials.
  segments: FilmRunSegment[];
  keyframes: [number, string][];
  result?: Record<string, unknown>;
  warnings: string[];
}
function directory(projectId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(projectId)) throw new Error("Invalid project ID");
  return join(getOutputDir(), projectId, ".film-runs");
}
function file(projectId: string, runId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error("Invalid film run ID");
  return join(directory(projectId), `${runId}.json`);
}
export async function saveFilmRun(run: FilmRun) {
  await mkdir(directory(run.projectId), { recursive: true });
  const target = file(run.projectId, run.id);
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(run), { mode: 0o600 });
  await rename(temp, target);
}
export async function loadFilmRun(projectId: string, runId: string): Promise<FilmRun> {
  const run = JSON.parse(await readFile(file(projectId, runId), "utf8")) as FilmRun;
  if (run.version !== 1 || run.projectId !== projectId || run.id !== runId) throw new Error("Invalid film manifest");
  return run;
}
export function filmRunSummary(run: FilmRun) {
  return { filmRunId: run.id, provider: run.provider, baseUrl: run.baseUrl, modelId: run.model,
    createdAt: run.createdAt, completed: !!run.result, warnings: run.warnings,
    taskId: run.segments.filter(s => s.taskId).at(-1)?.taskId,
    taskIds: run.segments.flatMap(s => s.taskId ? [s.taskId] : []),
    completedSegmentUrls: run.segments.flatMap(s => s.remoteUrl ? [s.remoteUrl] : []),
    segments: run.segments.map((s, index) => ({ index, state: s.state, taskId: s.taskId,
      shotIds: s.plan.shots.map(s => s.shotId), seconds: s.plan.seconds,
      timelineSeconds: s.plan.shots.reduce((sum, shot) => sum + shot.duration, 0),
      url: s.localUrl ?? s.remoteUrl, error: s.error })), ...run.result };
}
export async function listFilmRuns(projectId: string) {
  let names: string[];
  try { names = await readdir(directory(projectId)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const runs = await Promise.all(names.filter(n => n.endsWith(".json")).map(n => loadFilmRun(projectId, n.slice(0, -5))));
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(filmRunSummary);
}

/** Cross-process exclusion. A dead process leaves a recoverable lock, not a resubmittable task. */
export async function withFilmRunLock<T>(projectId: string, runId: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file(projectId, runId)}.lock`;
  await mkdir(directory(projectId), { recursive: true });
  try { await writeFile(lock, String(process.pid), { flag: "wx" }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(await readFile(lock, "utf8"));
    let dead = false;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === "ESRCH"; }
    }
    if (!dead) throw new Error("整片正在处理，请勿重复操作");
    await unlink(lock);
    return withFilmRunLock(projectId, runId, work);
  }
  try { return await work(); } finally { await unlink(lock); }
}

async function cacheSegment(run: FilmRun, index: number) {
  const segment = run.segments[index];
  const name = `film_source_${run.id}_${index}.mp4`;
  const path = join(getOutputDir(), run.projectId, name);
  if (!segment.localUrl) {
    const response = await fetch(segment.remoteUrl!);
    if (!response.ok) throw new Error(`分段 ${index + 1} 下载失败 (${response.status})`);
    const temp = `${path}.tmp`;
    await writeFile(temp, Buffer.from(await response.arrayBuffer()));
    const media = await probeMedia(temp);
    if (!media.width || !media.height || !media.duration) throw new Error(`分段 ${index + 1} 不是可用的视频`);
    await rename(temp, path);
    segment.localUrl = `/api/output/${run.projectId}/${name}`;
    await saveFilmRun(run);
  }
  if (!segment.tailFrame && index + 1 < run.segments.length) {
    const frame = await extractLastFrame(path);
    if (!frame) throw new Error(`分段 ${index + 1} 末帧提取失败；可恢复，无需重新生成`);
    segment.tailFrame = `data:image/jpeg;base64,${(await readFile(frame)).toString("base64")}`;
    await saveFilmRun(run);
  }
}

export async function executeFilmRun(
  run: FilmRun, provider: AIProvider,
  finalize: (run: FilmRun) => Promise<Record<string, unknown>>,
  retrySegment?: number,
) {
  if (run.result) return filmRunSummary(run);
  if (run.segments.some(segment => segment.state === "submitting" && !segment.taskId)) {
    throw new Error("分段提交结果不明，请向供应商核对是否已创建任务；核实前禁止重新提交");
  }
  if (retrySegment !== undefined) {
    const target = run.segments[retrySegment];
    if (!target || target.state !== "failed") throw new Error("只有已确认失败的分段可以重新付费生成；未知状态请先查询");
    target.state = "queued";
    delete target.taskId; delete target.rowId; delete target.error;
    await saveFilmRun(run);
  }
  for (let index = 0; index < run.segments.length; index++) {
    const segment = run.segments[index];
    if (segment.state === "failed") throw new Error(`分段 ${index + 1} 已失败，请确认后仅重试该段`);
    if ((segment.state === "submitting" || segment.state === "unknown") && !segment.taskId) {
      throw new Error(`分段 ${index + 1} 提交结果不明，请向供应商核对任务，勿重复付费`);
    }
    if (segment.state === "queued") {
      // Reserve the tail reference last, preserving all @ImageN keyframe indices.
      if (index > 0 && !segment.continuityApplied) {
        const previous = run.segments[index - 1];
        if (!previous.tailFrame) throw new Error("缺少上一段衔接帧");
        segment.options.referenceImageUrls = [...(segment.options.referenceImageUrls ?? []), previous.tailFrame];
        segment.options.prompt += `\nContinuity reference: @Image${segment.options.referenceImageUrls.length} is the previous segment's final frame. Use it to preserve identity, wardrobe, lighting and screen direction when the scene continues. Follow the local shot keyframe for intentional scene changes; do not force the presenter into absent shots.`;
        segment.continuityApplied = true;
      }
      segment.state = "submitting";
      await saveFilmRun(run); // Durable intent BEFORE any paid request.
      try {
        if (provider.submitVideoTask && provider.waitForTask) {
          const task = await provider.submitVideoTask(segment.options);
          segment.taskId = task.taskId;
          if (!task.taskId) throw new Error("供应商未返回任务 ID");
          segment.state = "polling";
        } else {
          const result = await provider.generateVideo(segment.options);
          segment.taskId = result.taskId;
          segment.remoteUrl = result.videoUrls?.[0];
          if (!segment.remoteUrl) throw new Error("供应商未返回视频地址");
          segment.state = "completed";
        }
        await saveFilmRun(run); // Keep the paid ID even if ai_tasks persistence fails.
      } catch (error) {
        segment.error = error instanceof Error ? error.message : String(error);
        // Never assume a network error means creation was rejected.
        segment.state = "unknown";
        await saveFilmRun(run);
        throw new Error(`${segment.error}；任务 ${segment.taskId ?? "ID 未返回"}，请勿重复提交`);
      }
    }
    if (!segment.rowId && segment.taskId) {
      const rowId = await recordAiTask({ projectId: run.projectId, provider: run.provider, model: run.model,
        mediaType: "video", mode: "video-to-video", prompt: segment.options.prompt, taskId: segment.taskId });
      if (!rowId) throw new Error(`任务 ${segment.taskId} 已保存到整片清单，但任务列表记录失败；恢复会继续记录，不会重新付费`);
      segment.rowId = rowId;
      await saveFilmRun(run);
    }
    if (!segment.remoteUrl) {
      try {
        if (!provider.waitForTask) throw new Error("供应商当前不支持查询已提交任务，请核对平台能力");
        const status = await provider.waitForTask(segment.taskId!, { interval: 5000 });
        const result = status.result;
        const url = result && "videoUrls" in result ? result.videoUrls?.[0] : undefined;
        if (!url) throw new Error("任务未返回视频地址");
        segment.remoteUrl = url;
        segment.state = "completed";
        delete segment.error;
        await saveFilmRun(run);
        await updateAiTask(segment.rowId!, { status: "completed", resultUrls: [url], error: null });
      } catch (error) {
        const failed = error instanceof ProviderError && error.code === "TASK_FAILED";
        segment.state = failed ? "failed" : "unknown";
        segment.error = error instanceof Error ? error.message : String(error);
        await saveFilmRun(run);
        await updateAiTask(segment.rowId!, { status: segment.state, error: segment.error });
        throw error;
      }
    }
    await cacheSegment(run, index);
  }
  run.result = await finalize(run);
  await saveFilmRun(run);
  return filmRunSummary(run);
}
