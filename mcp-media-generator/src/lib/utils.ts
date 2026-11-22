/** أدوات مساعدة صغيرة (بدون اعتماديات خارجية). */

export function newId(): string {
  return crypto.randomUUID();
}

export function safeJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw !== "string") return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** قصّل نصaLerror لتفادي تسريب معلومات ضخمة للسجلات. */
export function shortText(value: unknown, max = 300): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
