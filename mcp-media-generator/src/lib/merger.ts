/**
 * عميل Video Merger API v2 (المشروع الثاني: video-merger).
 * لا مفاتيح ولا توثيق. كل الوسائط تبقى على خدمة الدمج — نخزّن الروابط فقط.
 */

const RAW_BASE = process.env.MERGER_API_BASE?.trim() ?? "";

export function getMergerBase(): string {
  return RAW_BASE.replace(/\/+$/, "");
}

/** نعتبره غير مضبوط إذا كان فارغًا أو ما زال Placeholder من البرومبت. */
export function isMergerConfigured(): boolean {
  const base = getMergerBase();
  return /^https?:\/\//i.test(base) && !base.includes("xxxxxxxx");
}

export class MergeServiceError extends Error {
  status: number | null;
  body?: string;

  constructor(status: number | null, message: string, body?: string) {
    super(message);
    this.name = "MergeServiceError";
    this.status = status;
    this.body = body;
  }
}

export class MergeNotFoundError extends MergeServiceError {
  constructor(jobId: string) {
    super(404, `مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة): ${jobId}`);
    this.name = "MergeNotFoundError";
  }
}

type Json = Record<string, unknown>;

async function readJson(res: Response): Promise<{ json: Json; text: string }> {
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {
    json = {};
  }
  return { json, text };
}

function pickStatus(json: Json): string {
  return String(json.status ?? json.state ?? "").toLowerCase();
}

const DONE = new Set(["done", "completed", "complete", "success", "succeeded", "finished"]);
const FAILED = new Set(["error", "failed", "failure", "cancelled", "canceled"]);

export interface MergeJobState {
  status: "queued" | "processing" | "done" | "failed";
  progress: number;
  videoUrl?: string;
  downloadUrl?: string;
  expiresAt?: string;
  error?: string;
  raw: Json;
}

function parseState(json: Json, jobId: string): MergeJobState {
  const rawStatus = pickStatus(json);
  const errorText =
    typeof json.error === "string" && json.error.trim()
      ? json.error.trim()
      : typeof json.message === "string" && json.message.trim()
        ? json.message.trim()
        : undefined;

  let status: MergeJobState["status"];
  if (DONE.has(rawStatus)) status = "done";
  else if (FAILED.has(rawStatus)) status = "failed";
  else if (!rawStatus && errorText) status = "failed"; // جسم فيه error بدون status = فشل فوري
  else if (rawStatus === "queued" || rawStatus === "pending" || rawStatus === "waiting") status = "queued";
  else status = "processing";

  const videoUrl = typeof json.videoUrl === "string" ? json.videoUrl : undefined;
  const downloadUrl = typeof json.downloadUrl === "string" ? json.downloadUrl : undefined;
  const url = videoUrl ?? downloadUrl ?? (status === "done" ? `${getMergerBase()}/api/jobs/${jobId}/video` : undefined);

  let progress = Number(json.progress ?? 0);
  if (!Number.isFinite(progress)) progress = 0;
  if (progress > 0 && progress <= 1) progress = progress * 100;
  if (status === "done") progress = 100;

  if (status === "failed" && !errorText) {
    return { status, progress: progress || 0, error: "فشل الدمج لدى الخدمة.", raw: json };
  }

  return {
    status,
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    videoUrl: url,
    downloadUrl,
    expiresAt: typeof json.expiresAt === "string" ? json.expiresAt : undefined,
    error: errorText,
    raw: json,
  };
}

export interface CreatedMergeJob {
  jobId: string;
  status: string;
  statusUrl?: string;
  processUrl?: string;
  expiresAt?: string;
}

export async function createMergeJob(urls: string[]): Promise<CreatedMergeJob> {
  if (!isMergerConfigured()) {
    throw new MergeServiceError(0, "خدمة دمج الفيديو غير مهيأة (MERGER_API_BASE).");
  }
  let res: Response;
  try {
    res = await fetch(`${getMergerBase()}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: urls }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new MergeServiceError(0, `network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { json, text } = await readJson(res);
  if (!res.ok) {
    throw new MergeServiceError(
      res.status,
      typeof json.error === "string" ? json.error : `HTTP ${res.status}`,
      text.slice(0, 600),
    );
  }
  const jobId = typeof json.jobId === "string" ? json.jobId : "";
  if (!jobId) throw new MergeServiceError(500, "خدمة الدمج لم تُعِد معرّف مهمة (jobId)");

  return {
    jobId,
    status: typeof json.status === "string" ? json.status : "queued",
    statusUrl: typeof json.statusUrl === "string" ? json.statusUrl : undefined,
    processUrl: typeof json.processUrl === "string" ? json.processUrl : undefined,
    expiresAt: typeof json.expiresAt === "string" ? json.expiresAt : undefined,
  };
}

/** تنفيذ الدمج (blocking ~10–15 ثانية). أخطاء 4xx/5xx معلنة = فشل نهائي. */
export async function processMergeJob(jobId: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${getMergerBase()}/api/jobs/${encodeURIComponent(jobId)}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    throw new MergeServiceError(0, `network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { json, text } = await readJson(res);
  if (res.status === 202) return; // قيد المعالجة بالفعل
  if (!res.ok) {
    throw new MergeServiceError(
      res.status,
      typeof json.error === "string" ? json.error : `HTTP ${res.status}`,
      text.slice(0, 600),
    );
  }
}

/** قفل ذاكرة يمنع تشغيل process مرتين بالتزامن مع get_task. */
const processInFlight = new Set<string>();

export function ensureMergeProcess(jobId: string): void {
  if (!isMergerConfigured() || processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  void processMergeJob(jobId)
    .catch(() => {
      /* الخطأ سيظهر عبر الاستعلام — لا نرمي داخل الخلفية */
    })
    .finally(() => processInFlight.delete(jobId));
}

export function isProcessInFlight(jobId: string): boolean {
  return processInFlight.has(jobId);
}

export async function checkMergeJob(jobId: string): Promise<MergeJobState> {
  if (!isMergerConfigured()) {
    throw new MergeServiceError(0, "خدمة دمج الفيديو غير مهيأة (MERGER_API_BASE).");
  }
  let res: Response;
  try {
    res = await fetch(`${getMergerBase()}/api/jobs/${encodeURIComponent(jobId)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new MergeServiceError(0, `network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (res.status === 404) throw new MergeNotFoundError(jobId);

  const { json, text } = await readJson(res);
  if (!res.ok) {
    throw new MergeServiceError(
      res.status,
      typeof json.error === "string" ? json.error : `HTTP ${res.status}`,
      text.slice(0, 600),
    );
  }
  return parseState(json, jobId);
}

export async function mergerHealthy(): Promise<boolean> {
  if (!isMergerConfigured()) return false;
  try {
    const res = await fetch(`${getMergerBase()}/api/config`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteMergeJob(jobId: string): Promise<void> {
  if (!isMergerConfigured()) return;
  try {
    await fetch(`${getMergerBase()}/api/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* تنظيف اختياري */
  }
}
