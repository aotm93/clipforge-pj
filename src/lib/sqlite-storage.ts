import type { StateStorage } from "zustand/middleware";

/** Server-side SQLite survives Electron's changing localhost origin and upgrades. */
export function createSqliteStorage(key: string): StateStorage {
  const endpoint = `/api/local-store?key=${encodeURIComponent(key)}`;
  let loaded = false;
  let writes: Promise<void> = Promise.resolve();

  function localValue(): string | null {
    try { return typeof window === "undefined" ? null : window.localStorage.getItem(key); }
    catch { return null; }
  }

  function cache(value: string | null) {
    try {
      if (typeof window === "undefined") return;
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch {
      console.warn("[settings] 浏览器设置副本不可用，继续使用数据库存储");
    }
  }

  async function save(value: string) {
    const response = await fetch(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });
    if (!response.ok) throw new Error("保存设置失败");
  }

  // Serialize writes: a slower, older request must never overwrite a newer key/model edit.
  function enqueue(operation: () => Promise<void>) {
    writes = writes.then(operation).catch(() => {
      console.warn("[settings] 数据库写入失败，已保留本地设置副本");
    });
    return writes;
  }

  return {
    getItem: async () => {
      if (typeof window === "undefined") {
        loaded = true;
        return null;
      }
      try {
        const response = await fetch(endpoint, { cache: "no-store" });
        if (response.ok) {
          const payload = (await response.json()) as { value?: string | null };
          if (typeof payload.value === "string" && payload.value.length > 0) {
            cache(payload.value);
            return payload.value;
          }
          const legacy = localValue();
          if (legacy) await save(legacy);
          return legacy;
        }
      } catch {
        console.warn("[settings] 数据库读取或迁移失败，尝试读取本地设置副本");
        return localValue();
      }
      finally { loaded = true; }
      return localValue();
    },
    setItem: async (_name, value) => {
      // Zustand can persist mount-time defaults before its asynchronous initial read completes.
      // Those snapshots do not contain the saved keys and must not touch either storage copy.
      if (!loaded) return;
      cache(value);
      return enqueue(() => save(value));
    },
    removeItem: async () => {
      cache(null);
      return enqueue(async () => {
        const response = await fetch(endpoint, { method: "DELETE" });
        if (!response.ok) throw new Error("删除设置失败");
      });
    },
  };
}
