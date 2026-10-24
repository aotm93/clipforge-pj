import { describe, expect, it } from "vitest";
import { videoMaxSeconds, videoRequestSeconds } from "@/lib/video-duration";
import { filmAudioTempo } from "@/lib/storyboard-film-media";
import { isStoryboardFilmShot } from "@/lib/storyboard-film";
import type { Shot } from "@/lib/db/schema";
import { splitFilmShots } from "@/lib/storyboard-film";

const shot = (shotId: number, duration: number, voiceover = `台词${shotId}`): Shot => ({
  shotId, duration, type: "hook", description: `镜头${shotId}`, camera: "固定",
  visualSource: "ai_generate", transition: "direct_concat", voiceover,
});

describe("original-shot film task groups", () => {
  it("defaults unknown video models to 15 seconds and never exceeds the configured or documented maximum", () => {
    expect(videoMaxSeconds("custom-provider/unknown-model")).toBe(15);
    expect(videoMaxSeconds("custom-provider/unknown-model", 12)).toBe(12);
    expect(videoMaxSeconds("hailuo-h3-cankaosheng", 30)).toBe(15);
    expect(videoRequestSeconds("custom-provider/unknown-model", 14.1, 15)).toBe(15);
    expect(() => videoRequestSeconds("custom-provider/unknown-model", 15.1, 15)).toThrow();
    expect(() => videoMaxSeconds("custom-provider/unknown-model", 3)).toThrow();
  });

  it("groups a variable, unbounded number of intact consecutive shots near the 15-second limit", () => {
    const shots = [3, 4, 3, 4, 3, 4, 3].map((duration, index) => shot(index + 1, duration));
    const segments = splitFilmShots(shots, 15, "custom-provider/unknown-model");
    expect(segments.map((segment) => segment.seconds)).toEqual([14, 10]);
    expect(segments.map((segment) => segment.shots.map((item) => item.shotId))).toEqual([[1, 2, 3, 4], [5, 6, 7]]);
    expect(segments.flatMap((segment) => segment.shots).map((item) => item.voiceover)).toEqual(shots.map((item) => item.voiceover));
  });

  it("matches only aligned local clips to the original shot", () => {
    expect(isStoryboardFilmShot("/api/files/project/film_01234567-abcd-1234-abcd-0123456789ab_shot_7.mp4", 7)).toBe(true);
    expect(isStoryboardFilmShot("/api/files/project/film_01234567-abcd-1234-abcd-0123456789ab_shot_17.mp4", 7)).toBe(false);
    expect(isStoryboardFilmShot("/api/files/project/other.mp4", 7)).toBe(false);
  });

  it("builds legal chained atempo filters without changing pitch", () => {
    expect(filmAudioTempo(1.25)).toBe("atempo=1.2500000000");
    expect(filmAudioTempo(4)).toBe("atempo=2.0000000000,atempo=2.0000000000");
    expect(filmAudioTempo(0.125)).toBe("atempo=0.5000000000,atempo=0.5000000000,atempo=0.5000000000");
    expect(() => filmAudioTempo(0)).toThrow();
  });
});
