import {
  getKeyById,
  getKeyPool,
  getTask,
  insertTask,
  recordKeyOutcome,
  setKeyStatus,
  updateTask,
} from "./turso";
import { resolveModel, type ModelDef } from "./models";
import { getAdapter } from "./providers";
import {
  ProviderError,
  ToolInputError,
  classifyProviderError,
  isKeyOrBalanceFailure,
  sanitizePublicError,
} from "./errors";
import {
  MergeNotFoundError,
  MergeServiceError,
  checkMergeJob,
  createMergeJob,
  ensureMergeProcess,
  isMergerConfigured,
} from "./merger";
import { clamp, shortText, sleep } from "./utils";
import { maskKey } from "./mask";
import type { ApiKeyRecord, ProgressSink, ProviderId, TaskAttempt, TaskRecord } from "./types";

const POLL_INTERVAL_MS = 3000;
/** تهدئة إعادة المحاولة عندما لا يوجد مفتاح صالح — تُقاس من آخر محاولة مسجّلة. */
const RESUME_COOLDOWN_MS = 45_000;

export interface RunContext {
  report?: ProgressSink;
}

export interface StartGenerationArgs {
  type: "image" | "video";
  prompt: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  background?: string;
  outputFormat?: string;
  enableAudio?: boolean;
  duration?: number;
  imageUrl?: string;
  waitSeconds: number;
}

export interface StartMergeArgs {
  urls?: string[];
  taskIds?: string[];
  waitSeconds: number;
}

export interface RunOutcome {
  /** غير موجودة فقط عندما لا توجد أي مفاتيح نشطة لهذا النوع. */
  task?: TaskRecord;
  /** يُملأ فقط عندما لا توجد أي مفاتيح نشطة — لتُصاغ رسالة no_keys المحددة. */
  noKeysForModel?: string;
}

/* ----------------------------- أدوات داخلية ----------------------------- */

function errorInfo(err: unknown): { status: number | null; message: string } {
  if (err instanceof ProviderError) return { status: err.status, message: err.message };
  if (err instanceof MergeServiceError) return { status: err.status, message: err.message };
  if (err instanceof Error) return { status: 0, message: err.message };
  return { status: 0, message: String(err) };
}

function keyLabel(key: ApiKeyRecord): string {
  return key.label?.trim() ? key.label.trim() : maskKey(key.apiKey);
}

function attemptOf(
  key: ApiKeyRecord,
  ok: boolean,
  errorClass?: string,
  error?: string,
  note?: string,
): TaskAttempt {
  return {
    provider: key.provider,
    keyId: key.id,
    keyLabel: keyLabel(key),
    ok,
    errorClass,
    error: error ? shortText(error) : undefined,
    note,
    at: new Date().toISOString(),
  };
}

async function markFailed(task: TaskRecord, message: string): Promise<TaskRecord> {
  const updated = await updateTask(task.id, {
    status: "failed",
    errorMessage: sanitizePublicError(message),
    progress: task.progress,
  });
  return updated ?? task;
}

function adapterInput(task: TaskRecord, providerModel: string, minimal = false) {
  const p = task.params;
  const str = (key: string) => (typeof p[key] === "string" ? (p[key] as string) : undefined);
  return {
    type: task.type === "video" ? ("video" as const) : ("image" as const),
    prompt: task.prompt,
    model: providerModel,
    aspectRatio: str("aspect_ratio"),
    resolution: str("resolution"),
    background: str("background"),
    outputFormat: str("output_format"),
    enableAudio: typeof p.enable_audio === "boolean" ? (p.enable_audio as boolean) : undefined,
    duration: typeof p.duration === "number" ? (p.duration as number) : undefined,
    imageUrl: str("image_url"),
    minimal,
  };
}

interface TryStartResult {
  task: TaskRecord;
  started: boolean;
  failedFinal: boolean;
}

/**
 * جوهر التبديل التسلسلي: نجرّب المفاتيح بالترتيب (created_at ASC) واحدًا واحدًا.
 * كل محاولة تُسجَّل وعدّادات المفتاح تُحدَّث. أي خطأ مفتاح/رصيد ⇒ التالي فورًا،
 * وأي خطأ معطيات ⇒ توقف نهائي (لأن تبديل المفتاح لن يحلّه).
 */
async function tryStart(
  task: TaskRecord,
  def: ModelDef,
  pool: ApiKeyRecord[],
  fromIndex: number,
): Promise<TryStartResult> {
  for (let i = Math.max(0, fromIndex); i < pool.length; i++) {
    const key = pool[i];
    const adapter = getAdapter(key.provider);
    const providerModel = def.providerModel[key.provider] ?? def.canonical;
    const input = adapterInput(task, providerModel);

    try {
      // الصور لدى CometAPI متزامنة — تُكمل المهمة فورًا
      if (def.type === "image" && typeof adapter.createImageSync === "function") {
        const { urls } = await adapter.createImageSync(key.apiKey, input);
        await recordKeyOutcome(key.id, true);
        const updated = await updateTask(task.id, {
          provider: key.provider,
          keyId: key.id,
          providerTaskId: null,
          status: "completed",
          progress: 100,
          resultUrls: urls,
          errorMessage: null,
          appendAttempts: [attemptOf(key, true, undefined, undefined, "sync-image")],
        });
        return { task: updated ?? task, started: true, failedFinal: false };
      }

      const { providerTaskId } = await adapter.createTask(key.apiKey, input);
      await recordKeyOutcome(key.id, true);
      const updated = await updateTask(task.id, {
        provider: key.provider,
        keyId: key.id,
        providerTaskId,
        status: "processing",
        progress: 5,
        errorMessage: null,
        appendAttempts: [attemptOf(key, true)],
      });
      return { task: updated ?? task, started: true, failedFinal: false };
    } catch (err) {
      const { status, message } = errorInfo(err);
      const errorClass = classifyProviderError(status, message);

      await recordKeyOutcome(key.id, false, message);
      await updateTask(task.id, { appendAttempts: [attemptOf(key, false, errorClass, message)] });

      if (errorClass === "disabled") {
        await setKeyStatus(key.id, "disabled", shortText(message));
      } else if (errorClass === "exhausted") {
        await setKeyStatus(key.id, "exhausted", shortText(message));
      } else if (errorClass === "params") {
        // معطيات خاطئة: توقف فوري — التبديل لن يفيد
        const failed = await updateTask(task.id, {
          status: "failed",
          errorMessage: sanitizePublicError(message),
        });
        return { task: failed ?? task, started: false, failedFinal: true };
      }
      // disabled / exhausted / provider / temporary / unknown ⇒ المفتاح التالي
    }
  }

  // فشلت كل المفاتيح: نُبقي المهمة processing بانتظار رصيد/مفتاح، وتُعاد تلقائيًا لاحقًا
  const awaiting = await updateTask(task.id, {
    status: "processing",
    providerTaskId: null,
    keyId: null,
    errorMessage: "بانتظار توفر مفتاح صالح…",
  });
  return { task: awaiting ?? task, started: false, failedFinal: false };
}

/** إعادة إنشاء نفس المهمة (نفس task_id) على المفتاح التالي بعد فشل مفتاح/رصيد. */
async function rebuildOnNextKey(task: TaskRecord, def: ModelDef): Promise<TaskRecord> {
  const pool = await getKeyPool(def.providers);
  if (!pool.length) {
    const awaiting = await updateTask(task.id, {
      status: "processing",
      providerTaskId: null,
      keyId: null,
      errorMessage: "بانتظار توفر مفتاح صالح…",
    });
    return awaiting ?? task;
  }
  const currentIndex = pool.findIndex((k) => k.id === task.keyId);
  const nextIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
  if (nextIndex >= pool.length) {
    const awaiting = await updateTask(task.id, {
      status: "processing",
      providerTaskId: null,
      keyId: null,
      errorMessage: "بانتظار توفر مفتاح صالح…",
    });
    return awaiting ?? task;
  }
  const result = await tryStart(task, def, pool, nextIndex);
  return result.task;
}

/** هل جُرِّبت إعادة المحاولة المبسّطة لهذه المهمة؟ */
function usedMinimalRetry(task: TaskRecord): boolean {
  return task.attempts.some((a) => a.note === "retry-minimal");
}

/**
 * مزوّد kie يُرجع أحيانًا «Internal Error» لمهام الفيديو عند إرسال حقول اختيارية
 * (resolution/aspect_ratio/enable_audio) مع مدة طويلة. نعيد إنشاء المهمة بالحقول
 * الأساسية فقط، مع الإبقاء على نفس task_id للمستخدم. الفشل السابق لا يستهلك رصيدًا.
 */
async function retryWithMinimalInput(task: TaskRecord, key: ApiKeyRecord): Promise<boolean> {
  if (task.type !== "video" || task.provider !== "kie") return false;
  if (usedMinimalRetry(task)) return false;
  const def = resolveModel(task.model);
  if (!def) return false;
  const providerModel = def.providerModel[key.provider] ?? def.canonical;
  try {
    const { providerTaskId } = await getAdapter(key.provider).createTask(
      key.apiKey,
      adapterInput(task, providerModel, true),
    );
    await updateTask(task.id, {
      providerTaskId,
      status: "processing",
      progress: 5,
      errorMessage: null,
      appendAttempts: [attemptOf(key, true, undefined, undefined, "retry-minimal")],
    });
    return true;
  } catch {
    return false;
  }
}

/** هل مضى وقت التهدئة (45 ثانية) منذ آخر محاولة؟ */
function cooldownElapsed(task: TaskRecord): boolean {
  const last = task.attempts[task.attempts.length - 1];
  const lastAt = last ? Date.parse(last.at) : 0;
  return Date.now() - (Number.isFinite(lastAt) ? lastAt : 0) >= RESUME_COOLDOWN_MS;
}

/** استئناف مهمة بانتظار مفتاح — يُستدعى من get_task مع تهدئة 45 ثانية. */
async function resumeAwaiting(task: TaskRecord): Promise<TaskRecord> {
  if (!cooldownElapsed(task)) return task;
  const def = resolveModel(task.model);
  if (!def) return markFailed(task, "الموديل المرتبط بالمهمة لم يعد معروفًا.");
  const pool = await getKeyPool(def.providers);
  if (!pool.length) return task; // لا مفاتيح بعد — ننتظر بهدوء
  const result = await tryStart(task, def, pool, 0);
  return result.task;
}

function softProgress(task: TaskRecord, providerProgress?: number): number {
  if (typeof providerProgress === "number" && providerProgress > 0) {
    return clamp(Math.max(task.progress, providerProgress), 0, 95);
  }
  return clamp(task.progress + 4, 0, 92);
}

/** استعلام واحد من المزود لمهمة جارية (صورة/فيديو). */
async function pollProviderOnce(task: TaskRecord): Promise<TaskRecord> {
  if (task.status !== "processing" && task.status !== "pending") return task;
  if (!task.provider || task.provider === "merger" || !task.providerTaskId || !task.keyId) return task;

  const key = await getKeyById(task.keyId);
  if (!key) return markFailed(task, "تعذّر متابعة المهمة لأن المفتاح المرتبط لم يعد موجودًا.");

  const adapter = getAdapter(task.provider as ProviderId);
  try {
    const result = await adapter.checkTask(key.apiKey, task.providerTaskId);

    if (result.status === "completed") {
      await recordKeyOutcome(key.id, true);
      const urls = result.urls ?? [];
      if (!urls.length) return markFailed(task, "اكتملت المهمة دون أي رابط نتيجة.");
      const updated = await updateTask(task.id, {
        status: "completed",
        progress: 100,
        resultUrls: urls,
        errorMessage: null,
      });
      return updated ?? task;
    }

    if (result.status === "failed") {
      const reason = result.error ?? "فشل التوليد لدى المزود.";
      if (isKeyOrBalanceFailure(reason)) {
        // فشل مفتاح/رصيد بعد بدء المهمة: نفس task_id يُعاد إنشاؤه على المفتاح التالي
        const errorClass = classifyProviderError(402, reason);
        await recordKeyOutcome(key.id, false, reason);
        await updateTask(task.id, {
          appendAttempts: [attemptOf(key, false, errorClass, reason, "rebuild")],
        });
        if (errorClass === "exhausted") await setKeyStatus(key.id, "exhausted", shortText(reason));
        if (errorClass === "disabled") await setKeyStatus(key.id, "disabled", shortText(reason));
        const def = resolveModel(task.model);
        if (!def) return markFailed(task, "الموديل المرتبط بالمهمة لم يعد معروفًا.");
        return rebuildOnNextKey(task, def);
      }

      // خطأ داخلي غامض من مزوّد الفيديو: نعيد إنشاء المهمة بحقول أساسية فقط
      // (نفس task_id للمستخدم). الفشل لا يستهلك رصيدًا، لذا المحاولة مجانية عمليًا.
      if (await retryWithMinimalInput(task, key)) {
        const retried = await getTask(task.id);
        return retried ?? task;
      }

      return markFailed(task, reason);
    }

    const updated = await updateTask(task.id, {
      progress: softProgress(task, result.progress),
      errorMessage: null,
    });
    return updated ?? task;
  } catch (err) {
    const { status, message } = errorInfo(err);
    const errorClass = classifyProviderError(status, message);

    if (errorClass === "disabled" || errorClass === "exhausted") {
      await recordKeyOutcome(key.id, false, message);
      await updateTask(task.id, {
        appendAttempts: [attemptOf(key, false, errorClass, message, "rebuild")],
      });
      if (errorClass === "disabled") await setKeyStatus(key.id, "disabled", shortText(message));
      else await setKeyStatus(key.id, "exhausted", shortText(message));
      const def = resolveModel(task.model);
      if (!def) return markFailed(task, "الموديل المرتبط بالمهمة لم يعد معروفًا.");
      return rebuildOnNextKey(task, def);
    }

    if (errorClass === "params") return markFailed(task, message);
    // مؤقت/شبكة/مزود: نُبقي المهمة جارية ونحاول في الاستدعاء التالي
    const updated = await updateTask(task.id, { progress: softProgress(task) });
    return updated ?? task;
  }
}

/* ------------------------------- الدمج -------------------------------- */

const PRIVATE_HOST_RE =
  /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;

/** نرفض الروابط غير العامة (أمان SSRF) وغير المباشرة. */
function validatePublicUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "رابط غير صالح";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "يجب أن يكون الرابط http أو https";
  if (PRIVATE_HOST_RE.test(url.hostname) || url.hostname.endsWith(".local")) return "الرابط ليس عامًا";
  if (/^(data|file|blob):/i.test(raw)) return "الرابط غير مباشر";
  return null;
}

export async function startMerge(args: StartMergeArgs, ctx: RunContext = {}): Promise<RunOutcome> {
  const urls: string[] = [];
  const failedIds: string[] = [];

  // ترتيب الدمج: روابط task_ids أولًا (بترتيبها) ثم urls المباشرة
  for (const id of args.taskIds ?? []) {
    const t = await getTask(id);
    if (!t) {
      failedIds.push(`${id}: المهمة غير موجودة`);
      continue;
    }
    if (t.type !== "video") {
      failedIds.push(`${id}: ليست مهمة فيديو`);
      continue;
    }
    if (t.status !== "completed" || !t.resultUrls.length) {
      failedIds.push(`${id}: مهمة غير مكتملة (${t.status})`);
      continue;
    }
    urls.push(t.resultUrls[0]);
  }
  for (const raw of args.urls ?? []) {
    const clean = (raw ?? "").trim();
    if (!clean) continue;
    const problem = validatePublicUrl(clean);
    if (problem) failedIds.push(`${clean}: ${problem}`);
    else urls.push(clean);
  }

  if (failedIds.length) {
    throw new ToolInputError(
      `❌ تعذّر تجهيز مقاطع الدمج:\n${failedIds.map((f) => `- ${f}`).join("\n")}\n\nمرّر urls (روابط مباشرة عامة) أو task_ids لمهام فيديو مكتملة.`,
    );
  }
  if (urls.length < 2) {
    throw new ToolInputError(
      "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.",
    );
  }
  if (urls.length > 10) {
    throw new ToolInputError("❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).");
  }
  if (!isMergerConfigured()) {
    throw new ToolInputError(
      "❌ خدمة دمج الفيديو غير مهيأة على السيرفر. اضبط MERGER_API_BASE على عنوان نشر خدمة الدمج ثم أعد المحاولة.",
    );
  }

  // تسجيل المهمة قبل أي نداء خارجي
  let task = await insertTask({
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${urls.length} مقاطع`,
    params: { urls, task_ids: args.taskIds ?? [] },
    provider: "merger",
    status: "processing",
    progress: 1,
  });

  try {
    const created = await createMergeJob(urls);
    task =
      (await updateTask(task.id, {
        provider: "merger",
        providerTaskId: created.jobId,
        progress: 5,
        errorMessage: null,
        appendAttempts: [
          {
            provider: "merger",
            ok: true,
            note: "create",
            at: new Date().toISOString(),
          },
        ],
      })) ?? task;
    ensureMergeProcess(created.jobId);
  } catch (err) {
    const { status, message } = errorInfo(err);
    if (status && status >= 400 && status < 500) {
      // خطأ معلن من الخدمة = فشل حتمي فوري
      return { task: await markFailed(task, `فشل إنشاء مهمة الدمج: ${message}`) };
    }
    // خطأ شبكة عندنا = مؤقت → تبقى المهمة جارية وتُعاد المحاولة في get_task
    task =
      (await updateTask(task.id, {
        status: "processing",
        errorMessage: "خدمة الدمج غير متاحة مؤقتًا…",
        appendAttempts: [
          { provider: "merger", ok: false, errorClass: "temporary", error: shortText(message), at: new Date().toISOString() },
        ],
      })) ?? task;
  }

  const deadline = Date.now() + clamp(args.waitSeconds, 0, 240) * 1000;
  return { task: await waitLoop(task, deadline, ctx) };
}

/** تحديث مهمة دمج من الخدمة؛ ينشئ المهمة مجددًا إذا فشل إنشاؤها سابقًا. */
async function refreshMerge(task: TaskRecord): Promise<TaskRecord> {
  if (!isMergerConfigured()) return markFailed(task, "خدمة دمج الفيديو غير مهيأة على السيرفر.");

  if (!task.providerTaskId) {
    // إعادة محاولة الإنشاء بعد انقطاع شبكة (بتهدئة)
    if (!cooldownElapsed(task)) return task;
    const stored = Array.isArray(task.params.urls) ? (task.params.urls as string[]) : [];
    if (stored.length < 2) return markFailed(task, "بيانات مقاطع الدمج مفقودة.");
    try {
      const created = await createMergeJob(stored);
      const updated = await updateTask(task.id, {
        provider: "merger",
        providerTaskId: created.jobId,
        progress: 5,
        errorMessage: null,
      });
      ensureMergeProcess(created.jobId);
      return updated ?? task;
    } catch (err) {
      const { status, message } = errorInfo(err);
      if (status && status >= 400 && status < 500) {
        return markFailed(task, `فشل إنشاء مهمة الدمج: ${message}`);
      }
      return (await updateTask(task.id, { errorMessage: "خدمة الدمج غير متاحة مؤقتًا…" })) ?? task;
    }
  }

  try {
    const state = await checkMergeJob(task.providerTaskId);

    if (state.status === "done" && state.videoUrl) {
      return (
        (await updateTask(task.id, {
          status: "completed",
          progress: 100,
          resultUrls: [state.videoUrl],
          errorMessage: null,
        })) ?? task
      );
    }
    if (state.status === "failed") {
      return markFailed(task, state.error ?? "فشل الدمج لدى الخدمة.");
    }

    ensureMergeProcess(task.providerTaskId);
    return (
      (await updateTask(task.id, {
        progress: clamp(5 + state.progress * 0.9, 5, 95),
        errorMessage: null,
      })) ?? task
    );
  } catch (err) {
    if (err instanceof MergeNotFoundError) return markFailed(task, err.message);
    if (err instanceof MergeServiceError && err.status && err.status >= 400) {
      return markFailed(task, `فشل الدمج: ${err.message}`);
    }
    return task; // خطأ شبكة لدينا → مؤقت
  }
}

/* ---------------------------- نافذة الانتظار ---------------------------- */

async function waitLoop(task: TaskRecord, deadline: number, ctx: RunContext): Promise<TaskRecord> {
  let current = task;
  let tick = 0;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, remaining)));
    if (current.status === "completed" || current.status === "failed") return current;

    if (current.type === "merge") {
      current = await refreshMerge(current);
    } else if (!current.providerTaskId) {
      current = await resumeAwaiting(current);
    } else {
      current = await pollProviderOnce(current);
    }

    tick += 1;
    if (current.status === "completed" || current.status === "failed") {
      if (ctx.report) await ctx.report(current.status === "completed" ? 100 : 0, current.status === "completed" ? "اكتملت المهمة ✅" : "فشلت المهمة ❌");
      return current;
    }

    const pct = clamp(Math.max(current.progress, 10 + tick * 7), 0, 95);
    if (ctx.report) {
      await ctx.report(pct, current.type === "merge" ? `قيد الدمج… ${pct}%` : `قيد التوليد… ${pct}%`);
    }
  }

  return current;
}

/* ------------------------------ الواجهة العامة ------------------------------ */

export async function startGeneration(args: StartGenerationArgs, ctx: RunContext = {}): Promise<RunOutcome> {
  const def = resolveModel(args.model, args.type);
  if (!def || def.type !== args.type) {
    const expected = args.type === "image" ? "gpt-image-2-6/flare-text-to-image" : "grok-imagine-video-1-5-preview";
    throw new ToolInputError(
      `❌ موديل غير معروف أو لا يطابق نوع المهمة: ${args.model ?? "—"}. الموديل المتاح لهذا النوع: ${expected}`,
    );
  }
  if (!args.prompt?.trim()) {
    throw new ToolInputError("❌ الوصف (prompt) مطلوب ولا يمكن أن يكون فارغًا.");
  }

  const params = {
    aspect_ratio: args.aspectRatio,
    resolution: args.resolution,
    background: args.background,
    output_format: args.outputFormat,
    enable_audio: args.enableAudio,
    duration: args.duration,
    image_url: args.imageUrl,
  };

  // نتحقق من توفر مفتاح *قبل* إنشاء أي مهمة — لا نريد صفوفًا عالقة بلا نهاية
  const pool = await getKeyPool(def.providers);
  if (!pool.length) {
    return { noKeysForModel: def.canonical };
  }

  // نسجّل المهمة قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال
  let task = await insertTask({
    model: def.canonical,
    type: def.type,
    prompt: args.prompt.trim(),
    params,
    status: "processing",
    progress: 0,
  });

  const started = await tryStart(task, def, pool, 0);
  task = started.task;

  if (task.status === "completed" || task.status === "failed") return { task };

  const deadline = Date.now() + clamp(args.waitSeconds, 0, 240) * 1000;
  return { task: await waitLoop(task, deadline, ctx) };
}

/** get_task: يحدّث المهمة الجارية من المزود/خدمة الدمج ثم يعيدها. */
export async function refreshTask(taskId: string, ctx: RunContext = {}): Promise<TaskRecord | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") return task;

  let current: TaskRecord;
  if (task.type === "merge") current = await refreshMerge(task);
  else if (!task.providerTaskId) current = await resumeAwaiting(task);
  else current = await pollProviderOnce(task);

  if (current.status === "processing") {
    const pct = clamp(Math.max(current.progress, 10), 0, 95);
    if (ctx.report) await ctx.report(pct, `قيد المعالجة… ${pct}%`);
  }
  return current;
}
