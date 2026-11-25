/**
 * خادم MCP — Streamable HTTP عبر WebStandardStreamableHTTPServerTransport.
 *
 * الأدوات الخمس (أوصاف إنجليزية للعميل، محتوى عربي للنتائج):
 * 1) generate_image
 * 2) generate_video
 * 3) merge_videos
 * 4) get_task
 * 5) list_media
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { startGeneration, startMerge, refreshTask } from "@/lib/generation";
import { ToolInputError } from "@/lib/errors";
import { listRecentTasks } from "@/lib/turso";
import type { MediaType, TaskStatus } from "@/lib/types";

/* ------------------- ثوابت ------------------- */

const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" };
const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

/* ------------------- جلسات MCP ------------------- */

interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  mcp: McpServer;
}
const sessions = new Map<string, McpSession>();

function requireAuth(req: NextRequest): Response | null {
  const token = process.env.MCP_ACCESS_TOKEN?.trim();
  if (!token) return null;
  const auth = req.headers.get("authorization") ?? "";
  if (auth === `Bearer ${token}`) return null;
  return NextResponse.json(
    { error: "Unauthorized — مطلوب Bearer token صحيح على مسار /mcp" },
    { status: 401 },
  );
}

/* ------------------- الصياغة العربية للنتائج ------------------- */

function noKeysMsg(model: string): string {
  return `❌ لا توجد مفاتيح نشطة لخدمة ${model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`;
}
function processingMsg(taskId: string): string {
  return `⏳ المهمة قيد المعالجة — task_id: ${taskId}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}
function errMsg(msg: string): string {
  return `❌ ${msg}`;
}
function okImage(url: string, taskId: string): string {
  return `✅ تم توليد الصورة بنجاح\n\n![image](${url})\n\nالرابط المباشر: ${url}\n\n🆔 task_id: ${taskId}`;
}
function okVideo(urls: string[], taskId: string): string {
  return `✅ تم توليد الفيديو بنجاح\n${urls.map((u) => `- ${u}`).join("\n")}\n\n🆔 task_id: ${taskId}\nاستخدمه مع merge_videos (task_ids) أو get_task.`;
}
function okMerge(urls: string[], taskId: string): string {
  return `✅ تم دمج المقاطع بنجاح\n${urls.map((u) => `- ${u}`).join("\n")}\n\n🆔 task_id: ${taskId}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
}
function msgOf(err: unknown): string {
  if (err instanceof ToolInputError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
function fail(text: string): { content: { type: "text"; text: string }[]; isError: boolean } {
  return { content: [{ type: "text", text }], isError: true };
}

/* ------------------- مخططات zod (تُحوَّل تلقائيًا لـ JSON Schema) ------------------- */

const IMAGE_MODELS = ["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"] as const;
const VIDEO_MODELS = ["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"] as const;
const ASPECTS = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"] as const;

const generateImageSchema = z.object({
  prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
  model: z.enum(IMAGE_MODELS).default("gpt-image-2-6/flare-text-to-image"),
  aspect_ratio: z.enum(ASPECTS).default("auto"),
  resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
  background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
  output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
  wait_seconds: z.number().int().min(0).max(240).default(90),
});

const generateVideoSchema = z.object({
  prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
  image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
  model: z.enum(VIDEO_MODELS).default("grok-imagine-video-1-5-preview"),
  aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
  resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
  enable_audio: z.boolean().default(true),
  duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
  wait_seconds: z.number().int().min(0).max(240).default(25),
});

const mergeVideosSchema = z.object({
  urls: z.array(z.string()).min(2).max(10).optional().describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
  task_ids: z.array(z.string()).min(2).max(10).optional().describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
  wait_seconds: z.number().int().min(0).max(240).default(60),
});

const getTaskSchema = z.object({ task_id: z.string() });

const listMediaSchema = z.object({
  type: z.enum(["image", "video", "merge"]).optional(),
  status: z.enum(["completed", "failed", "processing"]).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

/* ------------------- إنشاء McpServer مع الأدوات الخمس ------------------- */

function createMcpServer(): McpServer {
  const mcp = new McpServer(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
    capabilities: { tools: {} },
  });

  mcp.registerTool(
    "generate_image",
    {
      description:
        "Generate an image using gpt-image-2-6/flare-text-to-image (auto failover across all active keys). Always returns a task_id: if completed within the wait window you also get the image URL, otherwise call get_task every ~10s until completed then show the URL.",
      inputSchema: generateImageSchema,
    },
    async (args) => {
      try {
        const out = await startGeneration({
          type: "image",
          prompt: args.prompt,
          model: args.model,
          aspectRatio: args.aspect_ratio,
          resolution: args.resolution,
          background: args.background,
          outputFormat: args.output_format,
          waitSeconds: args.wait_seconds,
        });
        if (out.noKeysForModel) return fail(noKeysMsg(out.noKeysForModel));
        const t = out.task;
        if (!t) return fail("❌ تعذّر إنشاء المهمة.");
        if (t.status === "completed" && t.resultUrls.length) return { content: [{ type: "text", text: okImage(t.resultUrls[0], t.id) }] };
        if (t.status === "failed") return fail(t.errorMessage ?? "خطأ غير معروف.");
        return { content: [{ type: "text", text: processingMsg(t.id) }] };
      } catch (err) {
        return fail(msgOf(err));
      }
    },
  );

  mcp.registerTool(
    "generate_video",
    {
      description:
        "Generate a video using grok-imagine-video-1-5-preview with native synchronous audio (dialogue/music/sfx). Optionally image-to-video. Video needs minutes: brief wait with live progress then returns task_id — poll with get_task every ~10s. Always keep the returned task_id: merge_videos accepts it (task_ids) to concatenate finished clips.",
      inputSchema: generateVideoSchema,
    },
    async (args) => {
      try {
        const out = await startGeneration({
          type: "video",
          prompt: args.prompt,
          model: args.model,
          aspectRatio: args.aspect_ratio,
          resolution: args.resolution,
          enableAudio: args.enable_audio,
          duration: args.duration,
          imageUrl: args.image_url,
          waitSeconds: args.wait_seconds,
        });
        if (out.noKeysForModel) return fail(noKeysMsg(out.noKeysForModel));
        const t = out.task;
        if (!t) return fail("❌ تعذّر إنشاء المهمة.");
        if (t.status === "completed" && t.resultUrls.length) return { content: [{ type: "text", text: okVideo(t.resultUrls, t.id) }] };
        if (t.status === "failed") return fail(t.errorMessage ?? "خطأ غير معروف.");
        return { content: [{ type: "text", text: processingMsg(t.id) }] };
      } catch (err) {
        return fail(msgOf(err));
      }
    },
  );

  mcp.registerTool(
    "merge_videos",
    {
      description:
        "Concatenate several video clips into one final video in the given order. Pass 'urls' (public direct video links) or 'task_ids' (completed video task IDs resolved from the database). Merge is usually fast: brief wait with live progress then returns a merge task_id — poll with get_task. ⚠️ the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: mergeVideosSchema,
    },
    async (args) => {
      try {
        const out = await startMerge({
          urls: args.urls,
          taskIds: args.task_ids,
          waitSeconds: args.wait_seconds,
        });
        const t = out.task;
        if (!t) return fail("❌ تعذّر إنشاء مهمة الدمج.");
        if (t.status === "completed" && t.resultUrls.length) return { content: [{ type: "text", text: okMerge(t.resultUrls, t.id) }] };
        if (t.status === "failed") return fail(t.errorMessage ?? "فشل الدمج.");
        return { content: [{ type: "text", text: processingMsg(t.id) }] };
      } catch (err) {
        return fail(msgOf(err));
      }
    },
  );

  mcp.registerTool(
    "get_task",
    {
      description:
        "Poll any task — image generation, video generation, or merge — by its task_id. Reads the database and refreshes from the provider/service if still running. Poll every ~10s; when completed you'll find result URLs — show them to the user and stop polling.",
      inputSchema: getTaskSchema,
    },
    async (args) => {
      try {
        const taskId = args.task_id.trim();
        if (!taskId) return fail("task_id مطلوب.");
        const task = await refreshTask(taskId);
        if (!task) return fail(`المهمة غير موجودة: ${taskId}`);
        if (task.status === "completed" && task.resultUrls.length) {
          const text = task.type === "image" ? okImage(task.resultUrls[0], task.id)
            : task.type === "merge" ? okMerge(task.resultUrls, task.id) : okVideo(task.resultUrls, task.id);
          return { content: [{ type: "text", text }] };
        }
        if (task.status === "failed") return fail(task.errorMessage ?? "خطأ غير معروف.");
        return { content: [{ type: "text", text: `⏳ المهمة قيد المعالجة — task_id: ${task.id}\nالحالة: ${task.status} (${task.progress}%)\nتابع بـ get_task كل ~10 ثوانٍ.` }] };
      } catch (err) {
        return fail(msgOf(err));
      }
    },
  );

  mcp.registerTool(
    "list_media",
    {
      description:
        "List recently generated images/videos/merges with their stored URLs from the database (no regeneration). Use it to recall previous results.",
      inputSchema: listMediaSchema,
    },
    async (args) => {
      try {
        const filter: { type?: MediaType; status?: TaskStatus } = {};
        if (args.type) filter.type = args.type as MediaType;
        if (args.status) filter.status = args.status as TaskStatus;
        const tasks = await listRecentTasks(args.limit, filter);
        const lines = tasks.map((t) =>
          `- **${t.type.toUpperCase()}** | ${t.model} | ${t.status} | ${t.resultUrls.length ? `رابط: ${t.resultUrls[0]}` : "—"} | ${new Date(t.createdAt).toLocaleString("ar-SA")}`);
        return { content: [{ type: "text", text: lines.length ? `أحدث ${tasks.length} مهمة:\n\n${lines.join("\n")}` : "لا توجد مهام تطابق المرشحات." }] };
      } catch (err) {
        return fail(msgOf(err));
      }
    },
  );

  return mcp;
}

/* ------------------- معالجة طلبات HTTP ------------------- */

export async function POST(req: NextRequest): Promise<Response> {
  const authIssue = requireAuth(req);
  if (authIssue) return authIssue;

  const headerSid = req.headers.get("mcp-session-id") ?? undefined;
  let session: McpSession | undefined = headerSid ? sessions.get(headerSid) : undefined;
  const isFirstRequest = !session;

  if (isFirstRequest) {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    const mcp = createMcpServer();
    await mcp.connect(transport);
    session = { transport, mcp };
  }

  // session non-null هنا لأننا إما استرجعنا الجلسة الموجودة أو أنشأنا جديدة
  const active: McpSession = session!;
  const response = await active.transport.handleRequest(req);

  if (isFirstRequest && active.transport.sessionId) {
    sessions.set(active.transport.sessionId, active);
  }

  return response;
}

export async function GET(req: NextRequest): Promise<Response> {
  const authIssue = requireAuth(req);
  if (authIssue) return authIssue;

  const headerSid = req.headers.get("mcp-session-id") ?? undefined;
  const session = headerSid ? sessions.get(headerSid) : undefined;
  if (!session) {
    return NextResponse.json({ error: "لم يتم العثور على الجلسة. أنشئ جلسة عبر POST أولًا." }, { status: 400 });
  }
  return session.transport.handleRequest(req);
}

export async function HEAD(): Promise<Response> {
  return NextResponse.json(null, { status: 200 });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const authIssue = requireAuth(req);
  if (authIssue) return authIssue;

  const headerSid = req.headers.get("mcp-session-id") ?? undefined;
  if (!headerSid) {
    return NextResponse.json({ error: "mcp-session-id مطلوب." }, { status: 400 });
  }

  const session = sessions.get(headerSid);
  if (!session) {
    return NextResponse.json({ error: "الجلسة غير موجودة." }, { status: 404 });
  }

  try {
    const fakeReq = new Request(new URL("http://localhost"), {
      method: "DELETE",
      headers: { "mcp-session-id": headerSid },
    });
    const res = await session.transport.handleRequest(fakeReq);
    sessions.delete(headerSid);
    return res;
  } catch {
    sessions.delete(headerSid);
    return NextResponse.json({ ok: true, message: "تم إنهاء الجلسة." });
  }
}