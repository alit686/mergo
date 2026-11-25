import { ProviderError, extractErrorMessage } from "../errors";
import type { AdapterInput, ProviderAdapter } from "./types";

/**
 * kie.ai — Jobs API الموحّد.
 * إنشاء: POST /api/v1/jobs/createTask  → { code:200, data:{ taskId } }
 * حالة:  GET  /api/v1/jobs/recordInfo  → { code:200, data:{ state, resultJson (نص), failMsg } }
 * ملاحظة: انتبه أن resultJson نص JSON يحتاج parse ثانيًا.
 */

const BASE = (process.env.KIE_API_BASE?.trim() || "https://api.kie.ai").replace(/\/+$/, "");
const TIMEOUT_MS = 45_000;

type Json = Record<string, unknown>;

function isOkCode(code: unknown): boolean {
  if (code == null) return true;
  const n = Number(code);
  return n === 0 || n === 200;
}

/** بعض الأخطاء تأتي بحالة HTTP 200 وبـ code داخلي — نحوّلها لحالة HTTP مفهومة. */
function statusFromCode(code: unknown): number {
  const n = Number(code);
  if ([400, 401, 402, 403, 404, 422, 429].includes(n)) return n;
  if (n >= 500) return n;
  return 500;
}

async function call(url: string, init: RequestInit): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // انقطاع شبكة/timeout → مؤقت (المفتاح يبقى سليمًا)
    throw new ProviderError("kie", 0, `network error: ${message}`);
  }

  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new ProviderError("kie", res.status, extractErrorMessage(json, `HTTP ${res.status}`), text.slice(0, 800));
  }
  if (!isOkCode(json.code)) {
    throw new ProviderError(
      "kie",
      statusFromCode(json.code),
      extractErrorMessage({ ...json, message: json.msg ?? json.message }, "kie error"),
      text.slice(0, 800),
    );
  }
  return json;
}

function buildInput(input: AdapterInput): Json {
  // إعادة محاولة مبسّطة: بعض موديلات الفيديو ترفض الحقول الاختيارية
  // (resolution/aspect_ratio/enable_audio) بخطأ داخلي «Internal Error».
  if (input.type === "video" && input.minimal) {
    const minimal: Json = { prompt: input.prompt };
    if (input.duration) minimal.duration = input.duration;
    if (input.imageUrl) minimal.image_urls = [input.imageUrl];
    return minimal;
  }

  const payload: Json = { prompt: input.prompt };
  if (input.type === "image") {
    if (input.aspectRatio && input.aspectRatio !== "auto") payload.aspect_ratio = input.aspectRatio;
    if (input.resolution) payload.resolution = input.resolution;
    if (input.background && input.background !== "auto") payload.background = input.background;
    if (input.outputFormat) payload.output_format = input.outputFormat;
  } else {
    if (input.imageUrl) payload.image_urls = [input.imageUrl];
    if (input.aspectRatio && input.aspectRatio !== "auto") payload.aspect_ratio = input.aspectRatio;
    if (input.resolution) payload.resolution = input.resolution;
    if (typeof input.enableAudio === "boolean") payload.enable_audio = input.enableAudio;
    if (input.duration) payload.duration = input.duration;
  }
  return payload;
}

function parseResultUrls(data: Json): string[] {
  // resultJson نص JSON داخل JSON — نحاول parse ثانيًا
  const rawResult = data.resultJson ?? data.result_json ?? data.result;
  let parsed: unknown = rawResult;
  if (typeof rawResult === "string") {
    try {
      parsed = JSON.parse(rawResult);
    } catch {
      parsed = null;
    }
  }

  const urls: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) urls.push(value);
  };

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Json;
    const list = obj.resultUrls ?? obj.result_urls ?? obj.urls ?? obj.images ?? obj.videos;
    if (Array.isArray(list)) list.forEach(push);
    push(obj.resultUrl);
    push(obj.url);
    push(obj.videoUrl);
    push(obj.video_url);
  }
  push(data.resultUrl);
  push(data.url);

  // روابط قد تكون داخل data.output (نص أو كائن)
  const output = data.output;
  if (typeof output === "string") {
    if (/^https?:\/\//i.test(output)) push(output);
    else {
      try {
        const parsedOut = JSON.parse(output) as Json;
        const list = parsedOut.resultUrls ?? parsedOut.urls ?? parsedOut.videos;
        if (Array.isArray(list)) list.forEach(push);
        push(parsedOut.url);
      } catch {
        /* تجاهل */
      }
    }
  }

  return Array.from(new Set(urls));
}

function parseProgress(data: Json): number | undefined {
  const raw = data.progress ?? data.percent ?? data.percentage;
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return n <= 1 ? Math.round(n * 100) : Math.round(n);
}

export const kieAdapter: ProviderAdapter = {
  id: "kie",

  async createTask(key, input) {
    const json = await call(`${BASE}/api/v1/jobs/createTask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: input.model, input: buildInput(input) }),
    });

    const data = (json.data ?? {}) as Json;
    const taskId = data.taskId ?? data.task_id ?? (json.taskId as string | undefined);
    if (!taskId || typeof taskId !== "string") {
      throw new ProviderError("kie", 500, "kie: لم يُعِد المزود معرّف مهمة (taskId)");
    }
    return { providerTaskId: taskId };
  },

  async checkTask(key, providerTaskId) {
    const json = await call(
      `${BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
      },
    );

    const data = (json.data ?? {}) as Json;
    const state = String(data.state ?? data.status ?? "").toLowerCase();
    const progress = parseProgress(data);
    const failMessage =
      (typeof data.failMsg === "string" && data.failMsg) ||
      (typeof data.error === "string" && data.error) ||
      (typeof json.msg === "string" && json.msg) ||
      "";

    if (["success", "succeeded", "completed", "complete", "done", "finished"].includes(state)) {
      const urls = parseResultUrls(data);
      if (!urls.length) {
        return { status: "failed", error: "اكتملت المهمة لدى المزود دون إرجاع أي رابط نتيجة." };
      }
      return { status: "completed", urls, progress: 100 };
    }

    if (["fail", "failed", "error", "cancelled", "canceled"].includes(state)) {
      return { status: "failed", error: failMessage || "فشل التوليد لدى المزود.", progress };
    }

    return { status: "processing", progress };
  },
};
