import { ProviderError, extractErrorMessage } from "../errors";
import type { AdapterInput, ProviderAdapter, ProviderCheckResult } from "./types";

/**
 * CometAPI — المزود الثاني.
 * الصور: نقطة متوافقة مع OpenAI ترجع النتيجة فورًا (url أو b64_json).
 * الفيديو: نقطة مهام غير متزامنة create/check؛ الشكل مُطبَّع دفاعيًا لأن
 * التوثيق قد يتغيّر — نقرأ الحقول المحتملة (id/task_id/status/state/video_url...).
 */

const BASE = (process.env.COMETAPI_BASE?.trim() || "https://api.cometapi.com").replace(/\/+$/, "");
const TIMEOUT_MS = 60_000;

type Json = Record<string, unknown>;

async function readJson(res: Response): Promise<{ json: Json; text: string }> {
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {
    json = { raw: text };
  }
  return { json, text };
}

async function request(path: string, key: string, init: RequestInit): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ProviderError("cometapi", 0, `network error: ${message}`);
  }

  const { json, text } = await readJson(res);
  if (!res.ok) {
    throw new ProviderError("cometapi", res.status, extractErrorMessage(json, `HTTP ${res.status}`), text.slice(0, 800));
  }
  // بعض الأخطاء تُرسل بحالة 200 مع error في الجسم
  if (json.error && !json.data) {
    throw new ProviderError("cometapi", 400, extractErrorMessage(json, "cometapi error"), text.slice(0, 800));
  }
  return json;
}

/** خريطة تقريبية لنسبة الأبعاد إلى مقاسات الصور المدعومة. */
function sizeFor(aspectRatio: string | undefined, resolution: string | undefined): string | undefined {
  const ratio = aspectRatio && aspectRatio !== "auto" ? aspectRatio : "1:1";
  const base = resolution === "4K" ? 4 : resolution === "2K" ? 2 : 1;
  const w1 = 1024 * base;
  const long = 1536 * base;
  const landscape = new Set(["3:2", "4:3", "5:4", "16:9", "2:1", "21:9", "3:1"]);
  const portrait = new Set(["2:3", "3:4", "4:5", "9:16", "1:2", "9:21", "1:3"]);
  if (ratio === "1:1") return `${w1}x${w1}`;
  if (landscape.has(ratio)) return `${long}x${w1}`;
  if (portrait.has(ratio)) return `${w1}x${long}`;
  return `${w1}x${w1}`;
}

function mimeFor(format: string | undefined): string {
  switch ((format ?? "png").toLowerCase()) {
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

function extractUrls(json: Json, format: string | undefined): string[] {
  const urls: string[] = [];
  const data = Array.isArray(json.data) ? (json.data as Json[]) : [];
  for (const item of data) {
    if (typeof item?.url === "string" && item.url.startsWith("http")) urls.push(item.url);
    else if (typeof item?.b64_json === "string" && item.b64_json.length > 0) {
      // لا ننزّل شيئًا على السيرفر: نحوّل base64 إلى data URL يُخزَّن كنص فقط.
      urls.push(`data:${mimeFor(format)};base64,${item.b64_json}`);
    }
  }
  return urls;
}

function extractVideoUrls(json: Json): string[] {
  const candidates: unknown[] = [];
  const data = json.data as unknown;
  const dataObj = data && typeof data === "object" && !Array.isArray(data) ? (data as Json) : {};

  candidates.push(
    dataObj.video_url,
    dataObj.videoUrl,
    dataObj.url,
    dataObj.output_url,
    json.video_url,
    json.videoUrl,
    json.output_url,
    json.url,
  );

  if (typeof json.video === "string") candidates.push(json.video);
  if (typeof dataObj.video === "string") candidates.push(dataObj.video);

  const arrays: unknown[] = [json.output, dataObj.output, json.outputs, dataObj.outputs, json.videos];
  for (const arr of arrays) {
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (typeof item === "string") candidates.push(item);
        else if (item && typeof item === "object") {
          const obj = item as Json;
          candidates.push(obj.url, obj.video_url, obj.videoUrl);
        }
      }
    }
  }

  if (Array.isArray(data)) {
    for (const item of data as Json[]) candidates.push(item?.url, item?.video_url);
  }

  return Array.from(
    new Set(candidates.filter((v): v is string => typeof v === "string" && /^https?:\/\//i.test(v))),
  );
}

function progressOf(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return n <= 1 ? Math.round(n * 100) : Math.round(n);
}

export const cometapiAdapter: ProviderAdapter = {
  id: "cometapi",

  async createTask(key, input) {
    const body: Json = {
      model: input.model,
      prompt: input.prompt,
      n: 1,
    };
    if (input.type === "image") {
      const size = sizeFor(input.aspectRatio, input.resolution);
      if (size) body.size = size;
      if (input.background && input.background !== "auto") body.background = input.background;
      if (input.outputFormat) body.output_format = input.outputFormat;
    } else {
      if (input.aspectRatio && input.aspectRatio !== "auto") body.aspect_ratio = input.aspectRatio;
      if (input.resolution) body.resolution = input.resolution;
      if (typeof input.enableAudio === "boolean") body.audio = input.enableAudio;
      if (input.duration) body.duration = input.duration;
      if (input.imageUrl) body.image_url = input.imageUrl;
    }

    const json = await request("/v1/video/generations", key, {
      method: "POST",
      body: JSON.stringify(body),
    });

    const data = (json.data ?? {}) as Json;
    const taskId = data.id ?? data.task_id ?? data.taskId ?? json.id ?? json.task_id;
    if (!taskId || typeof taskId !== "string") {
      throw new ProviderError("cometapi", 500, "cometapi: لم يُعِد المزود معرّف مهمة");
    }
    return { providerTaskId: taskId };
  },

  async createImageSync(key, input) {
    const body: Json = {
      model: input.model,
      prompt: input.prompt,
      n: 1,
      response_format: "url",
    };
    const size = sizeFor(input.aspectRatio, input.resolution);
    if (size) body.size = size;
    if (input.background && input.background !== "auto") body.background = input.background;
    if (input.outputFormat) body.output_format = input.outputFormat;

    const json = await request("/v1/images/generations", key, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const urls = extractUrls(json, input.outputFormat);
    if (!urls.length) {
      throw new ProviderError("cometapi", 500, "cometapi: لم تُرجِع نقطة الصور أي رابط نتيجة");
    }
    return { urls };
  },

  async checkTask(key, providerTaskId) {
    const json = await request(`/v1/video/generations/${encodeURIComponent(providerTaskId)}`, key, {
      method: "GET",
    });

    const data = (json.data ?? json) as Json;
    const status = String(data.status ?? data.state ?? json.status ?? json.state ?? "").toLowerCase();
    const urls = extractVideoUrls(json);

    if (urls.length && ["", "success", "succeeded", "completed", "done", "finished"].includes(status)) {
      return { status: "completed", urls, progress: 100 };
    }
    if (["failed", "fail", "error", "cancelled", "canceled"].includes(status)) {
      return {
        status: "failed",
        error:
          extractErrorMessage(data.fail_reason ?? data.error ?? json, "فشل توليد الفيديو لدى المزود.") ||
          "فشل توليد الفيديو لدى المزود.",
        progress: progressOf(data.progress),
      };
    }
    return { status: "processing", progress: progressOf(data.progress ?? json.progress) };
  },
};

export const __internal = { sizeFor, extractUrls, extractVideoUrls };
