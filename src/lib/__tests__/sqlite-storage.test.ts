import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { createJSONStorage, persist } from "zustand/middleware";
import { createSqliteStorage } from "@/lib/sqlite-storage";

const key = "daihuo-jianshou-settings";
const saved = JSON.stringify({ state: { apiKey: "saved-test-key", locale: "en" }, version: 0 });
const response = (value: string | null) => new Response(JSON.stringify({ value }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("durable settings hydration", () => {
  it("does not overwrite saved keys with a mount-time default while the initial GET is delayed", async () => {
    const read = deferred<Response>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(read.promise).mockResolvedValue(response(null));
    const store = createStore(persist(() => ({ apiKey: "", locale: "zh" }), {
      name: key, storage: createJSONStorage(() => createSqliteStorage(key)),
    }));
    store.setState({ locale: "zh" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(key)).toBeNull();
    const hydrated = new Promise<void>((resolve) => store.persist.onFinishHydration(() => resolve()));
    read.resolve(response(saved));
    await hydrated;
    expect(store.getState()).toEqual({ apiKey: "saved-test-key", locale: "en" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(key)).toBe(saved);
  });

  it("serializes key edits so an older request cannot finish after the newer save", async () => {
    const first = deferred<Response>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response(saved)).mockReturnValueOnce(first.promise).mockResolvedValue(response(null));
    const storage = createSqliteStorage(key);
    await storage.getItem(key);
    const oldWrite = storage.setItem(key, "old-value");
    const newWrite = storage.setItem(key, "new-value");
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(key)).toBe("new-value");
    first.resolve(response(null));
    await Promise.all([oldWrite, newWrite]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ value: "new-value" });
  });

  it("uses SQLite after an Electron origin change with empty localStorage", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => response(saved));
    expect(await createSqliteStorage(key).getItem(key)).toBe(saved);
    window.localStorage.clear();
    expect(await createSqliteStorage(key).getItem(key)).toBe(saved);
  });

  it("migrates a legacy value only when the database is empty", async () => {
    window.localStorage.setItem(key, saved);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(null));
    expect(await createSqliteStorage(key).getItem(key)).toBe(saved);
    expect(fetchMock.mock.calls[1][1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ value: saved });
  });

  it("reports a failed save, retains the fallback, and allows the next save to succeed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response(saved))
      .mockResolvedValueOnce(new Response("unavailable", { status: 500 })).mockResolvedValue(response(null));
    const storage = createSqliteStorage(key);
    await storage.getItem(key);
    await storage.setItem(key, "edited-test-key");
    expect(window.localStorage.getItem(key)).toBe("edited-test-key");
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("edited-test-key");
    await storage.setItem(key, "next-value");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
