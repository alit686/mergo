export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { getModels } from "@/lib/models";
import { getMergerBase, isMergerConfigured, mergerHealthy } from "@/lib/merger";

/**
 * GET /api/health — حالة الخدمة متضمنة قاعدة البيانات وخدمة الدمج.
 */
export async function GET(_req: NextRequest) {
  const [dbOk, mergerOk] = await Promise.all([
    dbHealthy(),
    mergerHealthy(),
  ]);

  const authRequired = Boolean(process.env.MCP_ACCESS_TOKEN);
  const models = getModels().map((m) => ({
    canonical: m.canonical,
    type: m.type,
    providers: m.providers,
  }));

  return NextResponse.json({
    ok: dbOk,
    database: dbOk ? "turso-connected" : "turso-disconnected",
    mcpEndpoint: "/mcp",
    models,
    merger: {
      base: getMergerBase() || "(غير مهيأ)",
      healthy: mergerOk,
    },
    authRequired,
  });
}