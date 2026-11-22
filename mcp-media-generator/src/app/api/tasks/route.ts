/**
 * نقطة نهاية المهام: GET (قائمة وإحصائيات)، DELETE (حذف).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { deleteTask, getTask, listRecentTasks, taskStats } from "@/lib/turso";
import type { MediaType, TaskStatus } from "@/lib/types";

/** GET /api/tasks — أحدث المهام + الإحصائيات.
 *  معاملات: ?type=image|video|merge&status=completed|failed|processing&limit=10
 */
export async function GET(req: NextRequest) {
  const type = (req.nextUrl.searchParams.get("type") ?? undefined) as MediaType | undefined;
  const status = (req.nextUrl.searchParams.get("status") ?? undefined) as TaskStatus | undefined;
  const limit = Math.min(50, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 10));

  const [stats, tasks] = await Promise.all([
    taskStats(),
    listRecentTasks(limit, { type, status }),
  ]);

  return NextResponse.json({
    stats: {
      total: stats.total,
      completed: stats.completed,
      failed: stats.failed,
      active: stats.active,
    },
    tasks: tasks.map((t) => ({
      id: t.id,
      type: t.type,
      model: t.model,
      prompt: t.prompt,
      status: t.status,
      progress: t.progress,
      resultUrls: t.resultUrls,
      errorMessage: t.errorMessage,
      attempts: t.attempts.length,
      createdAt: t.createdAt,
    })),
  });
}

/** DELETE /api/tasks — حذف مهمة. */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "معرّف المهمة (id) مطلوب." }, { status: 400 });
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: "المهمة غير موجودة." }, { status: 404 });

  await deleteTask(id);
  return NextResponse.json({ ok: true });
}