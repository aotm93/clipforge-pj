import { mkdir, writeFile, rm, copyFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import type { Shot } from "@/lib/db/schema";
import { getDataDir } from "@/lib/paths";
import { ffmpegBin } from "@/lib/ffmpeg-path";
import { probeMedia } from "@/lib/media-probe";
import { filmTotalSeconds } from "@/lib/storyboard-film";

const execFileAsync = promisify(execFile);

export interface FilmMediaSegment {
  url: string;
  shots: Shot[];
}

/** Pitch-preserving tempo changes, including ratios outside one atempo filter's range. */
export function filmAudioTempo(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error("无效的视频音频时长");
  const factors: number[] = [];
  while (ratio > 2) { factors.push(2); ratio /= 2; }
  while (ratio < 0.5) { factors.push(0.5); ratio /= 0.5; }
  factors.push(ratio);
  return factors.map((factor) => `atempo=${factor.toFixed(10)}`).join(",");
}

/** Align returned task clips to the original script timeline; this never submits generation tasks. */
export async function prepareStoryboardFilmMedia(projectId: string, segments: FilmMediaSegment[]): Promise<{
  outputPath: string;
  fileName: string;
  duration: number;
  alignedShots: { shotId: number; filePath: string; startSeconds: number; duration: number }[];
}> {
  if (!/^[a-zA-Z0-9-]+$/.test(projectId) || !segments.length) throw new Error("无效的整片素材输入");
  const shots = segments.flatMap((segment) => segment.shots);
  const ids = new Set<number>();
  for (const shot of shots) {
    if (ids.has(shot.shotId) || !Number.isFinite(shot.duration) || shot.duration <= 0) throw new Error("整片任务的原镜头编号或时长不一致");
    ids.add(shot.shotId);
  }
  const runId = randomUUID();
  const outputDir = join(getDataDir(), "output", projectId);
  const uploadDir = join(getDataDir(), "uploads", projectId);
  const workDir = join(outputDir, `segments_${runId}`);
  await mkdir(workDir, { recursive: true });
  await mkdir(uploadDir, { recursive: true });
  const fileName = `film_${runId}.mp4`;
  const outputPath = join(outputDir, fileName);
  const createdFiles: string[] = [];
  try {
    const normalized: string[] = [];
    let width = 0, height = 0;
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      const targetSeconds = filmTotalSeconds(segment.shots);
      if (!segment.url || targetSeconds <= 0) throw new Error(`任务 ${index + 1} 未返回可用视频或原镜头时长`);
      const input = join(workDir, `source_${index}.mp4`);
      const local = segment.url.match(/^\/api\/output\/([a-zA-Z0-9-]+)\/(film_source_[a-zA-Z0-9_-]+\.mp4)$/);
      if (local) {
        if (local[1] !== projectId) throw new Error("分段素材不属于当前项目");
        await copyFile(join(outputDir, local[2]), input);
      } else {
        const response = await fetch(segment.url);
        if (!response.ok) throw new Error(`下载任务 ${index + 1} 视频失败: ${response.status}`);
        await writeFile(input, Buffer.from(await response.arrayBuffer()));
      }
      const probe = await probeMedia(input);
      if (!probe.duration || probe.duration <= 0 || !probe.width || !probe.height) throw new Error(`任务 ${index + 1} 返回的视频无法读取时长或画面`);
      width ||= Math.floor(probe.width / 2) * 2;
      height ||= Math.floor(probe.height / 2) * 2;
      const output = join(workDir, `aligned_${index}.mp4`);
      const tempo = filmAudioTempo(probe.duration / targetSeconds);
      const args = ["-y", "-i", input];
      if (!probe.hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
      args.push("-map", "0:v:0", "-map", probe.hasAudio ? "0:a:0" : "1:a:0",
        "-vf", `setpts=${(targetSeconds / probe.duration).toFixed(10)}*(PTS-STARTPTS),scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=1`,
        "-af", `${probe.hasAudio ? `${tempo},` : ""}asetpts=PTS-STARTPTS,apad`,
        "-t", String(targetSeconds), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", output);
      await execFileAsync(ffmpegBin(), args, { maxBuffer: 10 * 1024 * 1024 });
      normalized.push(output);
    }
    const list = join(workDir, "concat.txt");
    await writeFile(list, normalized.map((file) => `file '${file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
    createdFiles.push(outputPath);
    await execFileAsync(ffmpegBin(), ["-y", "-f", "concat", "-safe", "0", "-i", list, "-t", String(filmTotalSeconds(shots)), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", outputPath], { maxBuffer: 10 * 1024 * 1024 });
    const alignedShots: { shotId: number; filePath: string; startSeconds: number; duration: number }[] = [];
    let startSeconds = 0;
    for (const shot of shots) {
      const name = `film_${runId}_shot_${shot.shotId}.mp4`;
      const absolutePath = join(uploadDir, name);
      createdFiles.push(absolutePath);
      await execFileAsync(ffmpegBin(), ["-y", "-ss", String(startSeconds), "-i", outputPath, "-t", String(shot.duration), "-map", "0:v:0", "-map", "0:a:0", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", absolutePath], { maxBuffer: 10 * 1024 * 1024 });
      const clip = await probeMedia(absolutePath);
      if (!clip.duration || Math.abs(clip.duration - shot.duration) > 0.15) throw new Error(`镜头 ${shot.shotId} 视频时长与原脚本不一致`);
      alignedShots.push({ shotId: shot.shotId, filePath: `/api/files/${projectId}/${name}`, startSeconds, duration: shot.duration });
      startSeconds = Number((startSeconds + shot.duration).toFixed(6));
    }
    const probe = await probeMedia(outputPath);
    if (!probe.duration || Math.abs(probe.duration - filmTotalSeconds(shots)) > 0.15) throw new Error("合并视频的时长与原脚本不一致");
    return { outputPath, fileName, duration: probe.duration, alignedShots };
  } catch (error) {
    for (const file of createdFiles) await rm(file, { force: true });
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
