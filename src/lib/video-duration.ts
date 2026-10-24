import { getVideoParamSpec } from "@/lib/providers/atlas-video-params";

export const DEFAULT_VIDEO_MAX_SECONDS = 15;

/** A custom limit can reduce a documented limit, but cannot enlarge it. */
export function videoMaxSeconds(modelId: string, configured?: number): number {
  if (configured !== undefined && (!Number.isInteger(configured) || configured < 4 || configured > 120)) {
    throw new Error("模型单次最大时长必须是 4–120 秒之间的整数");
  }
  const values = getVideoParamSpec(modelId)?.durationEnum;
  const documented = values?.length ? Math.max(...values) : undefined;
  const ceiling = Math.min(documented ?? configured ?? DEFAULT_VIDEO_MAX_SECONDS, configured ?? Infinity);
  const allowed = values?.filter((value) => value <= ceiling);
  if (allowed && !allowed.length) throw new Error("设置的最大时长低于模型支持的最短时长");
  return allowed?.length ? Math.max(...allowed) : ceiling;
}

/** Round the requested clip up to a supported duration, keeping every original shot intact. */
export function videoRequestSeconds(modelId: string, timelineSeconds: number, maximum: number): number {
  const requested = Math.max(4, Math.ceil(timelineSeconds - 0.000001));
  const allowed = getVideoParamSpec(modelId)?.durationEnum?.filter((value) => value >= requested && value <= maximum);
  const seconds = allowed ? Math.min(...allowed) : requested;
  if (!Number.isFinite(seconds) || seconds > maximum) {
    throw new Error(`镜头时长超出模型单次上限 ${maximum} 秒，请调整模型或原镜头时长`);
  }
  return seconds;
}
