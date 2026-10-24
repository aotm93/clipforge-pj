"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { useSettingsStore } from "@/lib/stores/settings-store";

type Run = {
  filmRunId: string; provider: string; baseUrl: string; modelId: string; completed: boolean;
  warnings: string[]; url?: string;
  segments: { index: number; state: string; taskId?: string; shotIds: number[]; seconds: number; url?: string; error?: string }[];
};
export function FilmRuns({ projectId, generating, onComplete }: { projectId: string; generating: boolean; onComplete: () => Promise<void> }) {
  const zh = useLocale().startsWith("zh");
  const providers = useSettingsStore(s => s.providers);
  const [runs, setRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState<{ run: Run; index: number }>();
  const refresh = useCallback(async () => {
    const res = await fetch(`/api/project/${projectId}/storyboard-film`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setRuns(data.runs);
  }, [projectId]);
  useEffect(() => { refresh().catch(e => setError(String(e))); }, [refresh, generating]);
  async function resume(run: Run, index?: number) {
    if (busy || generating) return;
    const config = providers[run.provider];
    if (!config?.apiKey || (config.baseUrl ?? "").replace(/\/$/, "") !== run.baseUrl.replace(/\/$/, "")) {
      setError(zh ? "请先在设置中恢复该任务原供应商的 API Key 和地址。" : "Restore the original provider credentials and URL in Settings first.");
      return;
    }
    setBusy(run.filmRunId); setError(""); setRetry(undefined);
    try {
      const res = await fetch(`/api/project/${projectId}/storyboard-film`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filmRunId: run.filmRunId, apiKey: config.apiKey, ...(index !== undefined && { retrySegment: index, confirmRetry: true }) }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await onComplete();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(undefined); await refresh().catch(e => setError(String(e))); }
  }
  if (!runs.length && !error) return null;
  return <section className="mb-4 space-y-3 rounded-lg border border-border p-4" aria-label={zh ? "整片分段任务" : "Film segments"}>
    <div className="flex items-center justify-between"><h3 className="font-medium">{zh ? "整片分段任务与恢复" : "Film segments and recovery"}</h3>
      <Button variant="outline" size="sm" disabled={!!busy} onClick={() => refresh().catch(e => setError(String(e)))}>{zh ? "刷新状态" : "Refresh"}</Button></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {runs.slice(0, 5).map(run => <details key={run.filmRunId} open={!run.completed} className="rounded border border-border p-3">
      <summary className="cursor-pointer text-sm">{run.modelId} · {run.segments.filter(s => s.state === "completed").length}/{run.segments.length} · {run.completed ? (zh ? "已合成" : "Composed") : (zh ? "待完成" : "Pending")}</summary>
      <p className="my-2 text-xs text-muted-foreground">{zh ? "固定使用本次任务的模型、提示词和参考图。已完成分段不会重新生成；未知状态只查询原任务。" : "Uses the frozen model, prompts and references. Completed segments are reused; unknown tasks are polled, never resubmitted."}</p>
      {run.warnings.length > 0 && <p className="mb-2 text-xs text-amber-600">{zh ? run.warnings.join(" ") : "Tail frames guide continuity but cannot guarantee it. Review character, motion and audio seams before publishing. Use unified narration in Compose when needed."}</p>}
      <div className="grid gap-2 sm:grid-cols-2">{run.segments.map(segment => <div key={segment.index} className="rounded bg-muted/40 p-2 text-xs">
        <p>{zh ? "分段" : "Segment"} {segment.index + 1} · {segment.shotIds.join(", ")} · {segment.seconds}s · {segment.state}</p>
        {segment.taskId && <p className="break-all text-muted-foreground">Task: {segment.taskId}</p>}
        {segment.error && <p className="text-destructive">{segment.error}</p>}
        {segment.url && <video src={segment.url} controls preload="none" className="mt-2 max-h-48 w-full rounded" />}
        {segment.state === "failed" && <Button size="sm" variant="outline" disabled={!!busy || generating} onClick={() => setRetry({ run, index: segment.index })}>{zh ? "仅重试此段" : "Retry this segment"}</Button>}
      </div>)}</div>
      {!run.completed && <Button className="mt-3" size="sm" disabled={!!busy || generating || run.segments.some(s => s.state === "failed")} onClick={() => resume(run)}>{busy === run.filmRunId ? (zh ? "处理中…" : "Working…") : run.segments.some(s => s.state === "queued") ? (zh ? "恢复并继续未生成段（可能计费）" : "Resume and generate remaining segments (may incur cost)") : (zh ? "查询任务 / 恢复合成" : "Poll tasks / resume composition")}</Button>}
      {run.completed && <a className="mt-2 block text-sm underline" href={`/project/${projectId}/compose`}>{zh ? "继续一键合成" : "Continue to Compose"}</a>}
    </details>)}
    {retry && <div role="alert" className="rounded border border-amber-500 p-3 text-sm">
      <p>{zh ? `将重新付费生成第 ${retry.index + 1} 段，随后继续未完成分段。已完成段会保留。` : `Regenerate segment ${retry.index + 1} at additional cost, then continue remaining segments. Completed clips are retained.`}</p>
      <Button className="mr-2 mt-2" size="sm" disabled={!!busy || generating} onClick={() => resume(retry.run, retry.index)}>{zh ? "确认重试" : "Confirm retry"}</Button>
      <Button size="sm" variant="outline" onClick={() => setRetry(undefined)}>{zh ? "取消" : "Cancel"}</Button>
    </div>}
  </section>;
}
