import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { getDataDir } from "@/lib/paths";
import { apiError } from "@/lib/api-error";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const EXTENSIONS_BY_MIME: Record<string, string[]> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
};

/**
 * POST /api/characters/sheet/upload — replace a presenter's multi-view sheet.
 * The sheet is intentionally stored as one image so the existing referenceImages[0]
 * contract remains unchanged for storyboard and film generation.
 */
export async function POST(req: NextRequest) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return apiError(req, "无效的上传数据，请检查图片文件", "Invalid upload data, please check the image file", 400);
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return apiError(req, "请上传一张多视图定妆照", "Please upload one multi-view reference sheet", 400);
  }
  if (!file.size) {
    return apiError(req, "图片文件不能为空", "The image file cannot be empty", 400);
  }
  if (file.size > MAX_FILE_SIZE) {
    return apiError(req, "定妆照不能超过 20MB", "The reference sheet cannot exceed 20MB", 413);
  }

  const mime = file.type.toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(mime)) {
    return apiError(req, "格式不支持，仅允许 JPG、PNG 或 WEBP 图片", "Unsupported format; only JPG, PNG, or WEBP images are allowed", 415);
  }

  const rawName = file.name.replace(/[/\\]/g, "");
  const ext = rawName.split(".").pop()?.toLowerCase() || "";
  if (!EXTENSIONS_BY_MIME[mime]?.includes(ext)) {
    return apiError(req, "图片扩展名与格式不匹配，请重新导出为 JPG、PNG 或 WEBP", "The file extension does not match its format; export it as JPG, PNG, or WEBP", 415);
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const dir = join(getDataDir(), "uploads", "characters");
  await mkdir(dir, { recursive: true });
  const fileName = `sheet-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await writeFile(join(dir, fileName), bytes);

  return NextResponse.json({ url: `/api/files/characters/${fileName}` });
}
