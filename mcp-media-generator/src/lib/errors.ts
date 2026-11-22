import type { ErrorClass } from "./types";

/** خطأ موحّد من أي مزود: الحالة + الرسالة ليُصنَّف في جدول 4.2. */
export class ProviderError extends Error {
  status: number | null;
  provider: string;
  body?: string;

  constructor(provider: string, status: number | null, message: string, body?: string) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
    this.body = body;
  }
}

/** خطأ معطيات من المستخدم — يوقف المهمة فورًا ولا يُبدَّل المفتاح بسببه. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

const EXHAUSTED_RE =
  /insufficient|quota|balance|credit|out of credits|exhausted|充值|billing|payment required|no funds|not enough/i;
const DISABLED_RE =
  /invalid\s*(api[\s_-]*)?key|invalid_key|unauthorized|forbidden|authentication|auth failed|api key.*(invalid|expired|revoked)|no auth|token.*(invalid|expired)/i;
const MODEL_RE =
  /model not found|unsupported model|model_not_found|does not exist|no such model|model.*not supported|unknown model/i;

/**
 * ترتيب الفحص مقصود:
 * 1) نفاد الرصيد قبل 400 لأن بعض المزودين يرسلونه بحالة 400.
 * 2) 401/403 = مفتاح مرفوض.
 * 3) الموديل غير مدعوم → جرّب مزودًا آخر.
 * 4) 400/422 = معطيات → توقف.
 * 5) 429/5xx/شبكة = مؤقت → المفتاح يبقى سليمًا.
 */
export function classifyProviderError(status: number | null, message: string): ErrorClass {
  const msg = message ?? "";
  const http = status ?? 0;

  // نفاد الرصيد أولًا (402 أو كلمات مفتاحية حتى لو كانت الحالة 400)
  if (http === 402 || EXHAUSTED_RE.test(msg)) return "exhausted";

  // مفتاح مرفوض
  if (http === 401 || http === 403) return "disabled";
  if (DISABLED_RE.test(msg)) return "disabled";

  // الموديل غير مدعوم لدى هذا المزود
  if (MODEL_RE.test(msg) && (http === 400 || http === 404 || http === 422 || http === 0)) {
    return "provider";
  }

  // معطيات الطلب — التبديل لن يحل المشكلة
  if (http === 400 || http === 422) return "params";

  // مؤقت: Rate limit، أخطاء خادم، انقطاع شبكة/timeout/abort
  if (http === 429 || http >= 500 || http === 0 || http === 408) return "temporary";

  // 404 غالبًا يعني مسارًا/مهمة غير موجودة لدى المزود → جرّب مزودًا آخر
  if (http === 404) return "provider";

  return "unknown";
}

/**
 * هل رسالة فشل المهمة (بعد إنشائها) تشير لمشكلة مفتاح/رصيد؟
 * عندها نعيد إنشاء نفس المهمة على المفتاح التالي بصمت (قسم 4.3.2).
 */
export function isKeyOrBalanceFailure(message: string | null | undefined): boolean {
  const msg = message ?? "";
  return /insufficient|balance|credit|quota|exhausted|402|401|403|unauthorized|forbidden|invalid\s*(api[\s_-]*)?key|充值/i.test(
    msg,
  );
}

/** استخراج رسالة خطأ من جسم استجابة غير معروف الشكل (دفاعي). */
export function extractErrorMessage(payload: unknown, fallback: string): string {
  if (payload == null) return fallback;
  if (typeof payload === "string") return payload || fallback;
  if (typeof payload !== "object") return String(payload);

  const obj = payload as Record<string, unknown>;
  const candidates: unknown[] = [
    obj.message,
    obj.msg,
    obj.error,
    obj.detail,
    (obj.data as Record<string, unknown> | undefined)?.message,
    (obj.data as Record<string, unknown> | undefined)?.msg,
    (obj.error as Record<string, unknown> | undefined)?.message,
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
    if (c && typeof c === "object") {
      const nested = extractErrorMessage(c, "");
      if (nested) return nested;
    }
  }
  try {
    const raw = JSON.stringify(payload);
    return raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
  } catch {
    return fallback;
  }
}

/** هل النص يحتوي على أي أثر لمفتاح/رصيد؟ (لمنع تسريب الأخطاء للعميل) */
export function sanitizePublicError(message: string | null | undefined): string {
  const msg = (message ?? "").trim();
  if (!msg) return "خطأ غير معروف في المزود.";
  if (/api[\s_-]*key|مفتاح|رصيد|balance|quota|credit|insufficient|exhausted|充值/i.test(msg)) {
    return "تعذّر إكمال التوليد حاليًا لدى المزود. أعد المحاولة لاحقًا.";
  }
  return msg;
}
