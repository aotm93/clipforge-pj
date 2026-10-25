import { describe, expect, it } from "vitest";
import { migrateSettings, type SettingsState } from "@/lib/stores/settings-store";

describe("settings migration", () => {
  it("adds new media providers without replacing existing credentials or endpoints", () => {
    const state = {
      providers: {
        openai: { enabled: true, apiKey: "" },
        "openai-compatible-media": { enabled: true, apiKey: "", baseUrl: "http://127.0.0.1:4100/v1" },
      },
      customModels: [],
    } as unknown as SettingsState;

    const migrated = migrateSettings(state);

    expect(migrated.providers.openai).toEqual({ enabled: true, apiKey: "" });
    expect(migrated.providers["openai-compatible-media"]).toEqual({
      enabled: true,
      apiKey: "",
      baseUrl: "http://127.0.0.1:4100/v1",
    });
    expect(migrated.providers.vgenv).toEqual({ enabled: false, apiKey: "" });
  });

  it("keeps valid custom duration limits and removes invalid persisted values", () => {
    const state = {
      providers: {},
      customModels: [
        { id: "valid", provider: "vgenv", modelId: "base", name: "Base", mediaType: "video", maxDurationSeconds: 15 },
        { id: "invalid", provider: "vgenv", modelId: "origin", name: "Origin", mediaType: "video", maxDurationSeconds: 3 },
      ],
    } as unknown as SettingsState;

    const migrated = migrateSettings(state);

    expect(migrated.customModels).toContainEqual(expect.objectContaining({ id: "valid", maxDurationSeconds: 15 }));
    expect(migrated.customModels).toContainEqual(expect.not.objectContaining({ id: "invalid", maxDurationSeconds: expect.anything() }));
  });
});
