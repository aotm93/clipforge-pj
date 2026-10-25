import { describe, expect, it } from "vitest";
import { buildVideoOptions, mergeCustomModels } from "@/lib/gen-params";

describe("custom model providers", () => {
  it("keeps a custom OpenAI model selectable when the OpenAI platform is enabled", () => {
    const models = mergeCustomModels(
      [],
      [{ id: "custom-1", provider: "openai", modelId: "my-image-model", name: "My Image Model", mediaType: "image" }],
      "image",
      new Set(["openai"]),
    );

    expect(models).toEqual([
      expect.objectContaining({ id: "my-image-model", provider: "openai", custom: true }),
    ]);
  });

  it.each(["openai", "openai-compatible-media", "vgenv"])("allows custom models to be attached to %s", (provider) => {
    const models = mergeCustomModels(
      [],
      [{ id: `${provider}-custom`, provider, modelId: "custom-model-id", name: "Custom model", mediaType: "video" }],
      "video",
      new Set([provider]),
    );
    expect(models).toContainEqual(expect.objectContaining({ id: "custom-model-id", provider, custom: true }));
  });
  it("uses custom video task duration limits when merging a configured model", () => {
    const models = mergeCustomModels(
      [{ id: "hailuo-h3-cankaosheng", name: "Hailuo H3", provider: "custom" }],
      [{ id: "h3", provider: "custom", modelId: "hailuo-h3-cankaosheng", name: "Hailuo H3", mediaType: "video", maxDurationSeconds: 15 }],
      "video",
      new Set(["custom"]),
    );
    expect(models).toContainEqual(expect.objectContaining({ id: "hailuo-h3-cankaosheng", maxDurationSeconds: 15 }));
  });

  it("forwards a custom video duration ceiling into generation options", () => {
    expect(buildVideoOptions(undefined, 15)).toMatchObject({ maxDurationSeconds: 15 });
    expect(buildVideoOptions(undefined, 3)).not.toHaveProperty("maxDurationSeconds");
  });


  it("does not expose a custom model when its platform key is not configured", () => {
    expect(
      mergeCustomModels(
        [],
        [{ id: "custom-1", provider: "openai", modelId: "my-image-model", name: "My Image Model", mediaType: "image" }],
        "image",
        new Set(["fal-ai"]),
      ),
    ).toEqual([]);
  });
});
