/**
 * واجهة برمجية لإدارة مفاتيح API (لللوحة الأمامية).
 * كل المفاتيح تُخفى دائمًا في الاستجابات (maskKey).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { findDuplicateKey, getKeyById, insertKey, listKeys } from "@/lib/turso";
import { maskKey } from "@/lib/mask";
import type { ProviderId } from "@/lib/types";

const VALID_PROVIDERS: ProviderId[] = ["kie", "cometapi"];

/** نسخة آمنة: المفتاح مقنّع دائمًا. */
function cleanMasked(key: Awaited<ReturnType<typeof getKeyById>> | null) {
  if (!key) return null;
  return { ...key, apiKey: maskKey(key.apiKey) };
}

/** GET /api/keys — قائمة المفاتيح (مقنّعة). */
export async function GET() {
  const keys = await listKeys();
  const safe = keys.map(cleanMasked);
  return NextResponse.json(safe);
}

/** POST /api/keys — إضافة مفتاح جديد. */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "يُرجى إرسال JSON صحيح." }, { status: 400 });
  }

  const provider = String(body.provider ?? "").toLowerCase() as ProviderId;
  if (!VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json(
      { error: `المزوّد غير صالح. المتاح: ${VALID_PROVIDERS.join("، ")}` },
      { status: 400 },
    );
  }

  const apiKey = String(body.api_key ?? "").trim();
  if (!apiKey) {
    return NextResponse.json({ error: "المفتاح مطلوب." }, { status: 400 });
  }

  const existing = await findDuplicateKey(provider, apiKey);
  if (existing) {
    return NextResponse.json(
      { error: `هذا المفتاح موجود بالفعل للمزوّد ${provider}.` },
      { status: 409 },
    );
  }

  const label = String(body.label ?? "").trim().slice(0, 200);
  const key = await insertKey(provider, apiKey, label);
  return NextResponse.json(cleanMasked(key), { status: 201 });
}

/**
 * PATCH/DELETE على المجموعة نفسها غير مدعومين — التعديل والحذف يتمّان
 * عبر /api/keys/{id} حيث يُحدَّد المفتاح صراحة في المسار.
 */
function methodNotAllowed() {
  return NextResponse.json(
    { error: "استخدم /api/keys/{id} لتعديل مفتاح أو حذفه." },
    { status: 405 },
  );
}

export async function PATCH() {
  return methodNotAllowed();
}

export async function DELETE() {
  return methodNotAllowed();
}