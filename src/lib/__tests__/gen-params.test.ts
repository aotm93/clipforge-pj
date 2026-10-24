import { describe, expect, it } from "vitest";
import { mergeCustomModels } from "@/lib/gen-params";

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
  it("uses custom video task duration limits when merging a configured model", () => {
    const models = mergeCustomModels(
      [{ id: "hailuo-h3-cankaosheng", name: "Hailuo H3", provider: "custom" }],
      [{ id: "h3", provider: "custom", modelId: "hailuo-h3-cankaosheng", name: "Hailuo H3", mediaType: "video", maxDurationSeconds: 15 }],
      "video",
      new Set(["custom"]),
    );
    expect(models).toContainEqual(expect.objectContaining({ id: "hailuo-h3-cankaosheng", maxDurationSeconds: 15 }));
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
