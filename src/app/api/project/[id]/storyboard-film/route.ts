import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getDataDir } from "@/lib/paths";
import { getDb } from "@/lib/db";
import { scripts, assets, compositions } from "@/lib/db/schema";
import type { Shot } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { createProvider } from "@/lib/providers";

import { GRID_MAX_SHOTS } from "@/lib/storyboard-grid";
import { getVideoModelCapabilities } from "@/lib/model-capabilities";
import {
  buildStoryboardFilmPrompt,
  dialogueDensityWarnings,
  filmTotalSeconds,
  filmDurationFit,
  splitFilmShots,
  referenceQuotaCheck,
  resolveFilmModel,
  estimateFilmSpend,
  parseUnitUsd,
} from "@/lib/storyboard-film";
import { videoMaxSeconds } from "@/lib/video-duration";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import {
  executeFilmRun,

  loadFilmRun,
  saveFilmRun,
  filmRunSummary,
  withFilmRunLock,
  type FilmRun,
} from "@/lib/storyboard-film-run";


import { fetchAtlasCatalog, getCachedAtlasEntry } from "@/lib/providers/atlas-catalog";
import { ATLAS_BASE_URL } from "@/lib/atlas-onekey";
import { toRemoteUsableImage } from "@/lib/remote-image";
import { probeMedia } from "@/lib/media-probe";

import { apiError, errText } from "@/lib/api-error";

const execFileAsync = promisify(execFile);

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;

/** A shot's usable keyframe IMAGE: an image asset's filePath, or a video asset's preserved keyframe */
function shotKeyframe(asset: { filePath?: string | null; thumbnailPath?: string | null } | undefined): string | undefined {
  if (!asset) return undefined;
  if (asset.filePath && IMAGE_EXT_RE.test(asset.filePath)) return asset.filePath;
  if (asset.thumbnailPath && IMAGE_EXT_RE.test(asset.thumbnailPath)) return asset.thumbnailPath;
  return undefined;
}
async function finalizeFilmRun(run: FilmRun): Promise<Record<string, unknown>> {
  const outputDir = join(getDataDir(), "output", run.projectId);
  await mkdir(outputDir, { recursive: true });
  const shotPaths: string[] = [];
  const shotSummaries: Array<{ shotIds: number[]; timelineSeconds: number; seconds: number }> = [];

  for (let index = 0; index < run.segments.length; index++) {
    const segment = run.segments[index];
    const sourcePath = join(outputDir, `film_source_${run.id}_${index}.mp4`);
    let offset = 0;
    for (const shot of segment.plan.shots) {
      const shotPath = join(outputDir, `film_${run.id}_shot_${shot.shotId}.mp4`);
      await execFileAsync(ffmpegBin(), [
        "-y", "-ss", String(offset), "-i", sourcePath, "-t", String(shot.duration),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", shotPath,
      ]);
      const shotUrl = `/api/output/${run.projectId}/${shotPath.split(/[\\/]/).pop()}`;
      await getDb().insert(assets).values({
        projectId: run.projectId,
        shotId: shot.shotId,
        type: "ai_generated",
        filePath: shotUrl,
        provider: run.provider,
        model: run.model,
        prompt: segment.options.prompt,
        selected: true,
        status: "done",
      });
      shotPaths.push(shotPath);
      offset += shot.duration;
    }
    shotSummaries.push({
      shotIds: segment.plan.shots.map((shot) => shot.shotId),
      timelineSeconds: segment.plan.shots.reduce((sum, shot) => sum + shot.duration, 0),
      seconds: segment.plan.seconds,
    });
  }

  const listPath = join(outputDir, `film_${run.id}.concat.txt`);
  await writeFile(listPath, shotPaths.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join("\n"));
  const fileName = `film_${Date.now()}.mp4`;
  const outputPath = join(outputDir, fileName);
  await execFileAsync(ffmpegBin(), ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath]);
  const probe = await probeMedia(outputPath).catch((error) => {
    console.warn("整片输出媒体探测失败，继续返回已生成文件:", error instanceof Error ? error.message : String(error));
    return undefined;
  });
  const [composition] = await getDb().insert(compositions).values({
    projectId: run.projectId,
    outputPath,
    resolution: "720p",
    aspectRatio: "9:16",
    ...(probe?.duration ? { duration: Math.round(probe.duration * 1000) } : {}),
    aigcBadge: false,
    label: `九宫格整片 · ${run.model.split("/").slice(0, 2).pop() ?? run.model}`.slice(0, 60),
    status: "done",
  }).returning();
  return {
    url: `/api/output/${run.projectId}/${fileName}`,
    compositionId: composition.id,
    fileName,
    seconds: Math.round(probe?.duration ?? run.segments.reduce((sum, segment) => sum + segment.plan.seconds, 0)),
    segmentCount: run.segments.length,
    segments: shotSummaries,
  };
}

/**
 * POST /api/project/[id]/storyboard-film — grid to full film (九宫格→一键整片).
 *
 * Feeds every shot's keyframe (typically the storyboard grid's cropped cells) as
 * reference images into a single reference-to-video generation with a timecoded
 * multi-shot prompt: native cuts between shots, person/product locked across
 * cuts, dialogue spoken verbatim with continuous audio. The result lands in the
 * compositions table, so the export page picks it up like any composed video.
 *
 * body: { scriptId, provider, apiKey, model?, baseUrl?, options? }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  let activeRunId: string | undefined;
  try {
    const { id } = await params;
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return apiError(req, "无效的项目ID", "Invalid project id", 400);
    const body = await req.json() as Record<string, unknown>;
    if (typeof body.filmRunId === "string") {
    if (typeof body.filmRunId === "string") activeRunId = body.filmRunId;
      const summary = await resumeFilmRun(req, id, body);
      return NextResponse.json(summary);
    }
    const scriptId = typeof body.scriptId === "string" ? body.scriptId : "";
    const providerName = typeof body.provider === "string" ? body.provider : "";
    const model = typeof body.model === "string" ? body.model : undefined;
    const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : "";
    const options = body.options && typeof body.options === "object" ? body.options as Record<string, unknown> : {};
    const characterSheetUrl = typeof body.characterSheetUrl === "string" ? body.characterSheetUrl : undefined;
    const dryRun = body.dryRun === true;
    const spendCapUsd = Number(body.spendCapUsd);
    const acknowledgeOverCap = body.acknowledgeOverCap === true;
    if (!scriptId) return apiError(req, "缺少 scriptId", "Missing scriptId", 400);

    const db = getDb();
    const [script] = await db.select().from(scripts).where(and(eq(scripts.id, scriptId), eq(scripts.projectId, id)));
    if (!script) return apiError(req, "脚本不存在", "Script not found", 404);
    const shots = Array.isArray(script.shots) ? script.shots as Shot[] : [];
    if (shots.length < 2) return apiError(req, "分镜太少，一键整片至少需要 2 个分镜", "Too few shots — the film pass needs at least 2", 400);
    if (shots.length > GRID_MAX_SHOTS) return apiError(req, `一键整片最多 ${GRID_MAX_SHOTS} 个分镜`, `The film pass holds at most ${GRID_MAX_SHOTS} shots`, 400);

    const choice = resolveFilmModel(model, providerName);
    const maxSeconds = videoMaxSeconds(choice.model, typeof options.maxDurationSeconds === "number" ? options.maxDurationSeconds : undefined);
    const durationSegments = splitFilmShots(shots, maxSeconds, choice.model);
    const maxRefImages = getVideoModelCapabilities(choice.model, undefined, providerName).maxReferenceImages;
    const refLimit = maxRefImages ?? 9;
    const hasSheet = Boolean(characterSheetUrl);
    const plans: Array<{ shots: Shot[]; seconds: number }> = [];
    let refChunk: Shot[] = [];
    let refSeconds = 0;
    for (const durationSegment of durationSegments) {
      for (const shot of durationSegment.shots) {
        if (refChunk.length >= refLimit - (hasSheet ? 1 : 0)) {
          plans.push({ shots: refChunk, seconds: Math.round(refSeconds) });
          refChunk = [];
          refSeconds = 0;
        }
        refChunk.push(shot);
        refSeconds += shot.duration;
      }
      if (refChunk.length) {
        plans.push({ shots: refChunk, seconds: Math.round(refSeconds) });
        refChunk = [];
        refSeconds = 0;
      }
    }
    const scriptSeconds = Math.round(filmTotalSeconds(shots));
    const estimateOptions = {
      width: typeof options.width === "number" ? options.width : 768,
      height: typeof options.height === "number" ? options.height : 1365,
    };
    if (dryRun) {
      const prompts = plans.map((segment) => buildStoryboardFilmPrompt(segment.shots, script.characters, { characterSheet: hasSheet }));
      const estimate = estimateFilmSpend(await unitPriceUsd(choice.model, baseUrl), scriptSeconds, estimateOptions);
      const referenceImages = Math.max(...plans.map((segment) => segment.shots.length + (hasSheet ? 1 : 0)));
      return NextResponse.json({
        dryRun: true, prompt: prompts[0], prompts, shotCount: shots.length, seconds: scriptSeconds, scriptSeconds,
        model: choice.model, ...(choice.swappedFrom && { swappedFrom: choice.swappedFrom }), modelMaxSeconds: maxSeconds,
        durationOverflow: false, segmentCount: plans.length, segmentSeconds: plans.map((segment) => segment.seconds),
        referenceImages, referenceQuota: referenceQuotaCheck(referenceImages, choice.model),
        dialogueWarnings: dialogueDensityWarnings(shots), ...(estimate && { estimate }),
      });
    }
    if (!providerName) return apiError(req, "缺少 provider", "Missing provider", 400);
    if (!apiKey) return apiError(req, "缺少 API Key，请先在设置中配置视频平台", "Missing API key — configure a video provider in settings first", 400);

    const assetRows = await db.select().from(assets).where(and(eq(assets.projectId, id), eq(assets.selected, true)));
    const byShot = new Map(assetRows.map((asset) => [asset.shotId, asset]));
    const keyframes = new Map<number, string>();
    const missing: number[] = [];
    for (const shot of shots) {
      const keyframe = shotKeyframe(byShot.get(shot.shotId));
      if (keyframe) keyframes.set(shot.shotId, keyframe);
      else missing.push(shot.shotId);
    }
    if (missing.length) return apiError(req, `分镜 ${missing.join("、")} 还没有关键帧图`, `Shots ${missing.join(", ")} have no keyframe image yet`, 400);

    const cap = Number(spendCapUsd);
    if (Number.isFinite(cap) && cap > 0 && !acknowledgeOverCap) {
      const estimate = estimateFilmSpend(await unitPriceUsd(choice.model, baseUrl), scriptSeconds, estimateOptions);
      if (estimate && estimate.maxUsd > cap) return apiError(req, `预估花费最高 $${estimate.maxUsd.toFixed(2)}，超过单次上限 $${cap}`, `Estimated spend $${estimate.maxUsd.toFixed(2)} exceeds the per-run cap of $${cap}`, 400);
    }

    const provider = createProvider({ name: providerName, apiKey, baseUrl });
    const runId = randomUUID();
    activeRunId = runId;
    const dialogueWarnings = dialogueDensityWarnings(shots);
    const segments = await Promise.all(plans.map(async (plan) => {
      const refs = [...(characterSheetUrl ? [characterSheetUrl] : []), ...plan.shots.map((shot) => keyframes.get(shot.shotId)!)];
      const referenceImageUrls = (await Promise.all(refs.map(toRemoteUsableImage))).filter((url): url is string => Boolean(url));
      return {
        plan,
        options: {
          ...options,
          modelId: choice.model,
          mode: "video-to-video" as const,
          prompt: buildStoryboardFilmPrompt(plan.shots, script.characters, { characterSheet: hasSheet }),
          referenceImageUrls,
          duration: plan.seconds,
          width: typeof options.width === "number" ? options.width : 768,
          height: typeof options.height === "number" ? options.height : 1365,
          audioEnabled: true,
          ...(providerName === "vgenv" && {
            extra: {
              ...((options.extra && typeof options.extra === "object") ? options.extra as Record<string, unknown> : {}),
              resolution: ((options.extra && typeof options.extra === "object") ? (options.extra as Record<string, unknown>).resolution : undefined) ?? "768p",
              upscale: false,
            },
          }),
        },
        state: "queued" as const,
      };
    }));
    const run: FilmRun = {
      version: 1, id: runId, projectId: id, scriptId, provider: providerName, baseUrl, model: choice.model,
      createdAt: new Date().toISOString(), segments, keyframes: [...keyframes.entries()],
      warnings: dialogueWarnings.map((warning) => `shot-${warning.index + 1}-dense-dialogue`),
    };
    await saveFilmRun(run);
    const result = await withFilmRunLock(id, runId, () => executeFilmRun(run, provider, finalizeFilmRun));
    return NextResponse.json({ ...result, scriptSeconds, seconds: scriptSeconds, modelId: choice.model, dialogueWarnings });
  } catch (error) {
    const message = error instanceof Error ? error.message : errText(req, "一键整片生成失败", "Storyboard film failed");
    console.error("一键整片生成失败:", message);
    let recovery: Record<string, unknown> = {};
    let status = activeRunId ? 502 : 500;
    if (activeRunId) {
      try {
        const { id } = await params;
        const saved = await loadFilmRun(id, activeRunId);
        recovery = filmRunSummary(saved);
        if (saved.segments.some((segment) => segment.state === "unknown" && segment.taskId)) status = 504;
      } catch (error) {
        console.warn("整片任务失败后读取恢复清单失败:", error instanceof Error ? error.message : String(error));
        recovery = { filmRunId: activeRunId };
      }
    }
    return NextResponse.json({ error: message, ...recovery, recoverable: Boolean(activeRunId) }, { status });
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const { id } = await params;
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return NextResponse.json({ error: "Invalid project id" }, { status: 400 });
    const { listFilmRuns } = await import("@/lib/storyboard-film-run");
    return NextResponse.json({ runs: await listFilmRuns(id) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "整片记录读取失败" }, { status: 500 });
  }
}

async function unitPriceUsd(modelId: string, baseUrl?: string): Promise<number | undefined> {
  try {
    await fetchAtlasCatalog(baseUrl?.trim() || ATLAS_BASE_URL);
    return parseUnitUsd(getCachedAtlasEntry(modelId)?.priceBase);
  } catch (error) {
    console.warn("整片价格查询失败，继续执行:", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/** Resume a previously saved film run without submitting already-paid segments again. */
async function resumeFilmRun(req: NextRequest, projectId: string, body: Record<string, unknown>) {
  const filmRunId = typeof body.filmRunId === "string" ? body.filmRunId : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  if (!filmRunId || !apiKey) return apiError(req, "恢复需要 filmRunId 和 API Key", "Resume requires filmRunId and API key", 400);
  const run = await loadFilmRun(projectId, filmRunId);
  const provider = createProvider({ name: run.provider, apiKey, baseUrl: run.baseUrl });
  return withFilmRunLock(projectId, run.id, () => executeFilmRun(run, provider, finalizeFilmRun));
}

/** Download the generated film into the project's output dir and register it as a composition. */
async function persistFilm(projectId: string, videoUrl: string | undefined, model: string) {
  if (!videoUrl) throw new Error("生成完成但未返回视频地址");
  const resp = await fetch(videoUrl);
  if (!resp.ok) throw new Error(`下载成片失败: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const outputDir = join(getDataDir(), "output", projectId);
  await mkdir(outputDir, { recursive: true });
  const fileName = `film_${Date.now()}.mp4`;
  const outputPath = join(outputDir, fileName);
  await writeFile(outputPath, buf);

  const probe = await probeMedia(outputPath).catch((error) => {
    console.warn("整片输出媒体探测失败，继续保存合成记录:", error instanceof Error ? error.message : String(error));
    return undefined;
  });
  const db = getDb();
  const [comp] = await db
    .insert(compositions)
    .values({
      projectId,
      outputPath,
      resolution: "720p",
      aspectRatio: "9:16",
      ...(probe?.duration ? { duration: Math.round(probe.duration * 1000) } : {}),
      aigcBadge: false,
      label: `九宫格整片 · ${model.split("/").slice(0, 2).pop() ?? model}`.slice(0, 60),
      status: "done",
    })
    .returning();
  return { url: `/api/output/${projectId}/${fileName}`, compositionId: comp.id, fileName };
}
