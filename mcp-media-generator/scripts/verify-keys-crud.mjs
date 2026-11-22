// اختبار CRUD للمفاتيح عبر HTTP: إضافة/تكرار/تعطيل/حذف + تأكيد التمويه الدائم
const BASE = process.env.BASE || "http://127.0.0.1:3000";

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function req(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { res, status: res.status, text, json };
}

const RAW = "sk-verify-CRUD-0123456789abcdef";
const RAW2 = "sk-verify-DUP-0123456789abcdef";

(async () => {
  console.log("🔑 اختبار CRUD للمفاتيح\n");

  const initial = await req("/api/keys");
  check("GET /api/keys → 200 + مصفوفة", initial.status === 200 && Array.isArray(initial.json), initial.text.slice(0, 120));
  const startCount = initial.json.length;

  // --- تحقق من المدخلات ---
  const badProvider = await req("/api/keys", { method: "POST", body: JSON.stringify({ provider: "openai", api_key: RAW }) });
  check("مزوّد غير صالح → 400", badProvider.status === 400, String(badProvider.status));

  const emptyKey = await req("/api/keys", { method: "POST", body: JSON.stringify({ provider: "kie", api_key: "   " }) });
  check("مفتاح فارغ → 400", emptyKey.status === 400, String(emptyKey.status));

  const badJson = await req("/api/keys", { method: "POST", body: "{not json" });
  check("JSON تالف → 400", badJson.status === 400, String(badJson.status));

  // --- إضافة ---
  const created = await req("/api/keys", {
    method: "POST",
    body: JSON.stringify({ provider: "kie", api_key: RAW, label: "مفتاح اختبار" }),
  });
  check("POST مفتاح صالح → 201", created.status === 201, created.text.slice(0, 160));
  check("الاستجابة تحتوي id وحالة active", Boolean(created.json?.id) && created.json?.status === "active", JSON.stringify(created.json));
  check("المفتاح مقنّع في الاستجابة", created.json?.apiKey && created.json.apiKey !== RAW && !created.text.includes(RAW), created.json?.apiKey);
  check("التسمية محفوظة", created.json?.label === "مفتاح اختبار", created.json?.label);
  const id = created.json?.id;

  // --- تكرار ---
  const dup = await req("/api/keys", {
    method: "POST",
    body: JSON.stringify({ provider: "kie", api_key: RAW, label: "مكرر" }),
  });
  check("نفس المفتاح مرة أخرى → 409", dup.status === 409, String(dup.status));
  check("رسالة التكرار عربية", /موجود بالفعل/.test(dup.json?.error || ""), dup.json?.error);

  // --- لا تسريب في القائمة ---
  const listed = await req("/api/keys");
  check("القائمة تحتوي المفتاح الجديد", listed.json?.length === startCount + 1, `count=${listed.json?.length}`);
  check("لا يوجد مفتاح خام في أي استجابة", !listed.text.includes(RAW) && !listed.text.includes(RAW2));
  check("القائمة تعرض القيمة المقنّعة", listed.json?.every((k) => String(k.apiKey || "").includes("•") || !String(k.apiKey || "").includes(RAW)));

  // --- تعطيل ---
  const patched = await req(`/api/keys/${id}`, { method: "PATCH", body: JSON.stringify({ status: "disabled" }) });
  check("PATCH /api/keys/{id} → 200 + disabled", patched.status === 200 && patched.json?.status === "disabled", patched.text.slice(0, 160));
  check("PATCH لا يكشف المفتاح الخام", !patched.text.includes(RAW));

  const badStatus = await req(`/api/keys/${id}`, { method: "PATCH", body: JSON.stringify({ status: "nonsense" }) });
  check("حالة غير صالحة → 400", badStatus.status === 400, String(badStatus.status));

  const patchMissing = await req("/api/keys/does-not-exist", { method: "PATCH", body: JSON.stringify({ status: "active" }) });
  check("PATCH لمفتاح غير موجود → 404", patchMissing.status === 404, String(patchMissing.status));

  const patchCollection = await req(`/api/keys?id=${id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) });
  check("PATCH على المجموعة بأسلوب قديم → 405", patchCollection.status === 405, String(patchCollection.status));

  // إعادة تفعيل للتأكد من الذهاب والعودة
  const reactivated = await req(`/api/keys/${id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) });
  check("إعادة التفعيل → active", reactivated.status === 200 && reactivated.json?.status === "active", reactivated.json?.status);

  // --- الحذف ---
  const del = await req(`/api/keys/${id}`, { method: "DELETE" });
  check("DELETE /api/keys/{id} → 200", del.status === 200 && del.json?.ok === true, del.text.slice(0, 120));

  const delAgain = await req(`/api/keys/${id}`, { method: "DELETE" });
  check("DELETE ثانٍ → 404", delAgain.status === 404, String(delAgain.status));

  const delCollection = await req(`/api/keys?id=${id}`, { method: "DELETE" });
  check("DELETE على المجموعة بأسلوب قديم → 405", delCollection.status === 405, String(delCollection.status));

  const after = await req("/api/keys");
  check("القائمة عادت لعددها الأصلي", after.json?.length === startCount, `count=${after.json?.length}`);
  check("لا أثر للمفتاح بعد الحذف", !after.text.includes(RAW));

  // --- الصحة ---
  const health = await req("/api/health");
  check("GET /api/health → ok:true", health.status === 200 && health.json?.ok === true, health.text.slice(0, 160));
  check("health لا يكشف أي مفتاح", !health.text.includes(RAW));

  console.log(`\n📊 النتيجة: ${passed} نجاح — ${failed} فشل`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error("✗ خطأ غير متوقع:", err); process.exit(1); });
