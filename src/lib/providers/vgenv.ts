import { randomUUID } from "node:crypto";
import { BaseProvider, ProviderError } from "./base";
import type {
  ImageResult,
  MediaType,
  Model,
  ProviderConfig,
  TaskStatus,
  VideoOptions,
  VideoResult,
} from "./types";

const DEFAULT_BASE_URL = "https://api.vgenv.com/v3";
const MODELS = ["base", "cinematic", "origin"] as const;
type VgenvModel = (typeof MODELS)[number];
const DEFAULT_RESOLUTION = "768p" as const;
const MAX_REFERENCE_IMAGES = 9;
const MAX_REFERENCE_VIDEOS = 3;
const MAX_REFERENCE_AUDIOS = 3;

type VgenvVideo = {
  id?: unknown;
  status?: unknown;
  progress?: unknown;
  output?: {
    url?: unknown;
    urls?: unknown;
  } | null;
  error?: unknown;
};

function isVgenvModel(modelId: string): modelId is VgenvModel {
  return (MODELS as readonly string[]).includes(modelId);
}

function outputUrls(video: VgenvVideo): string[] {
  const output = video.output;
  if (!output) return [];
  if (typeof output.url === "string" && output.url) return [output.url];
  if (Array.isArray(output.urls)) return output.urls.filter((url): url is string => typeof url === "string" && Boolean(url));
  return [];
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return undefined;
}

function aspectRatio(width?: number, height?: number): "9:16" | "16:9" | "1:1" {
  if ((height ?? 0) > (width ?? 0)) return "9:16";
  if ((width ?? 0) > (height ?? 0)) return "16:9";
  return "1:1";
}

function resolution(width?: number, height?: number, requested?: unknown): "480p" | "768p" {
  if (requested === "480p" || requested === "768p") return requested;
  const longSide = Math.max(width ?? 0, height ?? 0);
  if (longSide >= 700) return "768p";
  return DEFAULT_RESOLUTION;
}

/** vgenv MiniMax H3 REST V3 provider. */
export class VgenvProvider extends BaseProvider {
  readonly name = "vgenv";
  readonly displayName = "MiniMax (vgenv)";

  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, ""),
    });
  }

  async generateImage(): Promise<ImageResult> {
    throw new ProviderError("vgenv MiniMax H3 仅支持视频生成", "UNSUPPORTED_MEDIA", this.name);
  }

  async generateVideo(options: VideoOptions): Promise<VideoResult> {
    const { taskId, modelId } = await this.submitVideoTask(options);
    const finalStatus = await this.waitForTask(taskId, { interval: 8000 });
    const result = this.requireResult(finalStatus.result, "vgenv 任务完成但未返回视频地址");
    result.modelId = modelId;
    return result as VideoResult;
  }

  async submitVideoTask(options: VideoOptions): Promise<{ taskId: string; modelId: string }> {
    const modelId = this.validateOptions(options);
    const extra = options.extra ?? {};
    const duration = options.duration ?? 5;
    const tier = typeof extra.tier === "string" && extra.tier ? extra.tier : "base";
    const requestedResolution = extra.resolution;
    const firstFrame = options.firstFrameUrl ? [options.firstFrameUrl] : undefined;
    const lastFrame = options.lastFrameUrl ? [options.lastFrameUrl] : undefined;
    const referenceImages = options.referenceImageUrls?.slice(0, MAX_REFERENCE_IMAGES);
    const referenceVideos = options.referenceVideoUrls?.slice(0, MAX_REFERENCE_VIDEOS);
    const referenceAudios = options.referenceAudioUrls?.slice(0, MAX_REFERENCE_AUDIOS);
    const hasFrames = Boolean(firstFrame?.length || lastFrame?.length);
    const hasReferences = Boolean(referenceImages?.length || referenceVideos?.length || referenceAudios?.length);
    const idempotencyKey = typeof extra.idempotencyKey === "string" && extra.idempotencyKey
      ? extra.idempotencyKey
      : `clipforge-${randomUUID()}`;

    const video = await this.request<VgenvVideo>("/videos", {
      method: "POST",
      idempotent: false,
      headers: { "Idempotency-Key": idempotencyKey },
      body: {
        model: modelId,
        tier,
        prompt: options.prompt,
        duration,
        resolution: resolution(options.width, options.height, requestedResolution),
        aspect_ratio: aspectRatio(options.width, options.height),
        upscale: extra.upscale === true || options.upscale === true,
        ...(hasFrames ? {
          frame_images: [
            ...(firstFrame ? [{ type: "image_url", image_url: { url: firstFrame[0] }, frame_type: "first_frame" }] : []),
            ...(lastFrame ? [{ type: "image_url", image_url: { url: lastFrame[0] }, frame_type: "last_frame" }] : []),
          ],
        } : hasReferences ? {
          ...(referenceImages?.length && { reference_images: referenceImages.map((url) => ({ type: "image_url", image_url: { url } })) }),
          ...(referenceVideos?.length && { reference_videos: referenceVideos.map((url) => ({ type: "video_url", video_url: { url } })) }),
          ...(referenceAudios?.length && { reference_audios: referenceAudios.map((url) => ({ type: "audio_url", audio_url: { url } })) }),
        } : {}),
      },
    });

    const taskId = typeof video.id === "string" ? video.id : "";
    if (!taskId) {
      throw new ProviderError("vgenv 创建任务成功但未返回任务 ID", "SUBMIT_FAILED", this.name);
    }
    return { taskId, modelId };
  }

  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    const video = await this.request<VgenvVideo>(`/videos/${encodeURIComponent(taskId)}`);
    const status = video.status;
    const mapped = status === "queued"
      ? "pending"
      : status === "running"
        ? "processing"
        : status === "succeeded"
          ? "completed"
          : status === "failed"
            ? "failed"
            : status === "cancelled"
              ? "cancelled"
              : "processing";
    const result = mapped === "completed"
      ? {
          taskId,
          videoUrls: outputUrls(video),
          modelId: "",
          processingTime: undefined,
        }
      : undefined;

    return {
      taskId,
      status: mapped,
      progress: typeof video.progress === "number" ? video.progress : undefined,
      ...(result && { result }),
      ...(mapped === "failed" && { error: errorMessage(video.error) || "vgenv 任务失败" }),
      ...(mapped === "cancelled" && { error: errorMessage(video.error) || "vgenv 任务已取消" }),
    };
  }

  async listModels(mediaType?: MediaType): Promise<Model[]> {
    if (mediaType && mediaType !== "video") return [];
    return [
      {
        id: "base",
        name: "Base",
        description: "基础 Base 模型",
        modes: ["text-to-video", "image-to-video", "video-to-video"],
        mediaType: "video",
        provider: this.name,
        supportsAudio: false,
      },
      {
        id: "cinematic",
        name: "Cinematic",
        description: "电影 Cinematic 模型",
        modes: ["text-to-video", "image-to-video", "video-to-video"],
        mediaType: "video",
        provider: this.name,
        supportsAudio: false,
      },
      {
        id: "origin",
        name: "Origin",
        description: "原生 Origin 模型（需授权）",
        modes: ["text-to-video", "image-to-video", "video-to-video"],
        mediaType: "video",
        provider: this.name,
        supportsAudio: false,
      },
    ];
  }

  private validateOptions(options: VideoOptions): VgenvModel {
    if (!isVgenvModel(options.modelId)) {
      throw new ProviderError(`vgenv 不支持模型 “${options.modelId}”，可选 base、cinematic、origin`, "UNSUPPORTED_MODEL", this.name);
    }
    const hasFrames = Boolean(options.firstFrameUrl || options.lastFrameUrl);
    const hasReferences = Boolean(options.referenceImageUrls?.length || options.referenceVideoUrls?.length || options.referenceAudioUrls?.length);
    if (hasFrames && hasReferences) {
      throw new ProviderError("vgenv V3 首尾帧模式与参考素材模式不能混用", "UNSUPPORTED_MODE", this.name);
    }
    if (options.mode !== "text-to-video" && options.mode !== "image-to-video" && options.mode !== "video-to-video") {
      throw new ProviderError("vgenv V3 不支持当前视频模式", "UNSUPPORTED_MODE", this.name);
    }
    if (options.firstFrameUrl && options.lastFrameUrl && options.firstFrameUrl === options.lastFrameUrl) {
      throw new ProviderError("vgenv 首帧和尾帧不能使用同一地址", "INVALID_INPUT", this.name);
    }
    if ((options.referenceImageUrls?.length ?? 0) > MAX_REFERENCE_IMAGES || (options.referenceVideoUrls?.length ?? 0) > MAX_REFERENCE_VIDEOS || (options.referenceAudioUrls?.length ?? 0) > MAX_REFERENCE_AUDIOS) {
      throw new ProviderError("vgenv V3 参考素材数量超出限制", "INVALID_INPUT", this.name);
    }
    const requestedResolution = options.extra?.resolution;
    if (requestedResolution === "1080p") {
      throw new ProviderError("vgenv MiniMax H3 V3 仅支持 480p 和 768p", "INVALID_INPUT", this.name);
    }
    const maxDurationSeconds = options.maxDurationSeconds ?? 15;
    if (!Number.isInteger(maxDurationSeconds) || maxDurationSeconds < 4 || maxDurationSeconds > 15) {
      throw new ProviderError("vgenv 单次最大时长必须是 4–15 秒的整数", "INVALID_DURATION", this.name);
    }
    const duration = options.duration ?? 5;
    if (!Number.isInteger(duration) || duration < 4 || duration > maxDurationSeconds) {
      throw new ProviderError(`vgenv 视频时长必须是 4–${maxDurationSeconds} 秒的整数`, "INVALID_DURATION", this.name);
    }
    return options.modelId;
  }
}

export { DEFAULT_BASE_URL as VGENV_BASE_URL };
