import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { settings } from "@/lib/db/schema";

const ALLOWED_KEYS = new Set([
  "daihuo-jianshou-settings",
  "daihuo-jianshou-brand",
  "daihuo-jianshou-characters",
]);

function readKey(request: NextRequest): string | null {
  const key = request.nextUrl.searchParams.get("key");
  return key && ALLOWED_KEYS.has(key) ? key : null;
}

export async function GET(request: NextRequest) {
  const key = readKey(request);
  if (!key) return NextResponse.json({ error: "invalid store key" }, { status: 400 });

  try {
    const row = getDb().select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
    return NextResponse.json({ value: row?.value ?? null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取设置失败" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const key = readKey(request);
  if (!key) return NextResponse.json({ error: "invalid store key" }, { status: 400 });

  try {
    const body = (await request.json()) as { value?: unknown };
    if (typeof body.value !== "string" || body.value.length > 2_000_000) {
      return NextResponse.json({ error: "invalid store value" }, { status: 400 });
    }
    const now = new Date();
    getDb().insert(settings).values({ key, value: body.value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: body.value, updatedAt: now } }).run();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存设置失败" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const key = readKey(request);
  if (!key) return NextResponse.json({ error: "invalid store key" }, { status: 400 });
  try {
    getDb().delete(settings).where(eq(settings.key, key)).run();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "删除设置失败" }, { status: 500 });
  }
}
