/**
 * إخفاء المفاتيح إلزامي في كل استجابة/سجل.
 * الطويل: أول 7 أحرف + 8 نقاط + آخر 4. القصير: أول 3 + 4 نقاط.
 */
export function maskKey(key: string | null | undefined): string {
  const clean = (key ?? "").trim();
  if (!clean) return "—";
  if (clean.length <= 10) return `${clean.slice(0, 3)}••••`;
  return `${clean.slice(0, 7)}••••••••${clean.slice(-4)}`;
}

/** آخر 4 أحرف فقط لتمييز المفتاح في السجلات دون كشفه. */
export function keyFingerprint(key: string | null | undefined): string {
  const clean = (key ?? "").trim();
  return clean ? `…${clean.slice(-4)}` : "—";
}
