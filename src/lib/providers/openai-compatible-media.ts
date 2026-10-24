import { BaseProvider, ProviderError } from './base'
import { videoMaxSeconds, videoRequestSeconds } from "@/lib/video-duration"
import type { ImageOptions, ImageResult, MediaType, Model, ProviderConfig, TaskStatus, VideoOptions, VideoResult } from './types'

interface MediaTaskResponse {
  task_id?: string | number
  task_ids?: Array<string | number>
  '任务ids'?: Array<string | number>
  data?: MediaTaskResponse
  code?: string | number
  msg?: string
  state?: string
  is_final?: boolean
  progress?: string | number
  result_url?: string
  result?: { url?: string; video_url?: string }
  error?: string
}

/** OpenAI-compatible third-party platform with the ai778 async media task protocol. */
export class OpenAICompatibleMediaProvider extends BaseProvider {
  readonly name = 'openai-compatible-media'
  readonly displayName = 'OpenAI 兼容第三方媒体'

  constructor(config: ProviderConfig) {
    super({ ...config, baseUrl: (config.baseUrl || 'https://api.lk888.ai/v1').replace(/\/$/, '') })
  }

  async generateImage(options: ImageOptions): Promise<ImageResult> {
    const result = await this.request<{ data?: Array<{ url?: string; b64_json?: string }> }>('/images/generations', {
      method: 'POST', timeout: 120_000,
      body: { model: options.modelId, prompt: options.prompt, n: options.count ?? 1, ...(options.width && options.height ? { size: `${options.width}x${options.height}` } : {}), ...options.extra },
    })
    const imageUrls = (result.data ?? []).map((x) => x.url ?? (x.b64_json ? `data:image/png;base64,${x.b64_json}` : '')).filter(Boolean)
    if (!imageUrls.length) throw new ProviderError('生成成功但未返回图片数据', 'NO_RESULT', this.name)
    return { taskId: `image-${Date.now()}`, imageUrls, modelId: options.modelId }
  }

  async generateVideo(options: VideoOptions): Promise<VideoResult> {
    const { taskId } = await this.submitVideoTask(options)
    const status = await this.waitForTask(taskId, { interval: 8000, maxAttempts: 600 })
    if (status.status !== 'completed' || !status.result || !('videoUrls' in status.result)) {
      throw new ProviderError(status.error || '第三方视频任务失败', 'TASK_FAILED', this.name)
    }
    return { ...status.result, modelId: options.modelId }
  }

  async submitVideoTask(options: VideoOptions): Promise<{ taskId: string; modelId: string }> {
    const images = options.referenceImageUrls?.length ? options.referenceImageUrls : options.firstFrameUrl ? [options.firstFrameUrl] : []
    if (!images.length) throw new ProviderError('此平台的视频模型需要至少一张参考图', 'BAD_REFERENCE', this.name)
    const duration = videoRequestSeconds(options.modelId, options.duration ?? 5, videoMaxSeconds(options.modelId, options.maxDurationSeconds))
    const params: Record<string, unknown> = {
      duration: String(duration),
      resolution: options.extra?.resolution ?? '768P',
      ...(options.width && options.height ? { aspect_ratio: options.width / options.height > 1.5 ? '16:9' : options.width / options.height < 0.75 ? '9:16' : '1:1' } : {}),
      ...(options.extra ?? {}),
      images,
    }
    const response = await this.request<MediaTaskResponse>('/media/generate', {
      method: 'POST', timeout: 120_000, idempotent: false,
      body: { model: options.modelId, prompt: options.prompt, params },
    })
    this.checkResponse(response)
    // ai778's documented creation response wraps task_id (and 任务ids) inside data.
    const data = response.data ?? response
    const ids = data.task_ids ?? data['任务ids']
    const id = data.task_id ?? response.task_id ?? (ids?.length === 1 ? ids[0] : undefined)
    if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()) {
      throw new ProviderError('第三方平台未返回可识别的任务编号，任务可能已提交。请先在平台查询任务，避免重复生成扣费。', 'NO_TASK_ID', this.name)
    }
    return { taskId: String(id).trim(), modelId: options.modelId }
  }

  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    const payload = await this.request<MediaTaskResponse>(`/media/status?task_id=${encodeURIComponent(taskId)}`)
    this.checkResponse(payload)
    const response = payload.data ?? payload
    const state = response.state?.toLowerCase()
    const done = response.is_final === true || state === 'success' || state === 'failed'
    const failed = state === 'failed'
    const url = response.result_url || response.result?.video_url || response.result?.url
    return {
      taskId,
      status: failed ? 'failed' : done && url ? 'completed' : done ? 'failed' : state === 'running' ? 'processing' : 'pending',
      progress: typeof response.progress === 'number' ? response.progress : Number.parseInt(String(response.progress ?? ''), 10) || undefined,
      ...(url && { result: { taskId, videoUrls: [url], modelId: '' } as VideoResult }),
      ...(failed && { error: response.error || '第三方视频生成失败' }),
    }
  }

  private checkResponse(response: MediaTaskResponse): void {
    if (response.code != null && ![0, 200].includes(Number(response.code))) {
      throw new ProviderError(response.msg || response.error || '第三方媒体接口返回错误', 'API_ERROR', this.name)
    }
  }

  async listModels(mediaType?: MediaType): Promise<Model[]> {
    return mediaType === 'image' ? [] : []
  }
}
