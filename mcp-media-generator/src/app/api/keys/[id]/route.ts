/**
 * واجهة إدارة مفتاح واحد: PATCH /api/keys/{id} و DELETE /api/keys/{id}
 * لا يُعاد المفتاح الخام أبدًا — القيمة مقنّعة في كل استجابة.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { deleteKey, getKeyById, setKeyStatus } from "@/lib/turso";
import { maskKey } from "@/lib/mask";
import type { KeyStatus } from "@/lib/types";

const VALID_STATUSES: KeyStatus[] = ["active", "exhausted", "disabled"];

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const key = await getKeyById(id);
  if (!key) {
    return NextResponse.json({ error: "المفتاح غير موجود." }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "يُرجى إرسال JSON صحيح." }, { status: 400 });
  }

  const newStatus = String(body.status ?? "").toLowerCase() as KeyStatus;
  if (!VALID_STATUSES.includes(newStatus)) {
    return NextResponse.json(
      { error: `الحالة غير صالحة. المتاح: ${VALID_STATUSES.join("، ")}` },
      { status: 400 },
    );
  }

  await setKeyStatus(id, newStatus);
  const updated = await getKeyById(id);
  if (!updated) {
    return NextResponse.json({ error: "المفتاح غير موجود." }, { status: 404 });
  }

  return NextResponse.json({ ...updated, apiKey: maskKey(updated.apiKey) });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const key = await getKeyById(id);
  if (!key) {
    return NextResponse.json({ error: "المفتاح غير موجود." }, { status: 404 });
  }

  await deleteKey(id);
  return NextResponse.json({ ok: true, message: "تم حذف المفتاح." });
}
