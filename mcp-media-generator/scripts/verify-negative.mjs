// مسارات سلبية عبر MCP: merge_videos بلا خدمة دمج، get_task لمعرّف مجهول، list_media
const BASE = process.env.BASE || "http://127.0.0.1:3000";
const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

let passed = 0, failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function readRpc(res) {
  const text = await res.text();
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) {
    const out = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (raw) { try { out.push(JSON.parse(raw)); } catch {} }
    }
    return out;
  }
  try { return [JSON.parse(text)]; } catch { return []; }
}

async function rpc(body, sid) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { ...headers, ...(sid ? { "mcp-session-id": sid } : {}) },
    body: JSON.stringify(body),
  });
  return { msgs: await readRpc(res), sid: res.headers.get("mcp-session-id") || sid };
}

const textOf = (m) => m?.result?.content?.map((c) => c.text || "").join("\n") || "";

(async () => {
  console.log("🧪 مسارات MCP السلبية\n");

  const init = await rpc({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "neg", version: "1" } },
  });
  const sid = init.sid;
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sid).catch(() => {});

  const merge = await rpc({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "merge_videos", arguments: { urls: ["https://example.com/a.mp4", "https://example.com/b.mp4"], wait_seconds: 0 } },
  }, sid);
  const m = merge.msgs.find((x) => x.id === 2);
  const mt = textOf(m);
  const health = await (await fetch(`${BASE}/api/health`)).json();
  if (health?.merger?.healthy) {
    // الخدمة مهيأة في هذه البيئة: نتأكد أن الاستدعاء يبدأ مهمة فعلية
    check("merge مع خدمة مهيأة → يبدأ مهمة", !m?.result?.isError && /task_id/.test(mt), mt);
  } else {
    check("merge بلا MERGER_API_BASE → isError", m?.result?.isError === true, JSON.stringify(m));
    check("رسالة الدمج عربية وواضحة", /دمج|MERGER|غير مهيأ|غير متاح/.test(mt), mt);
  }
  check("لا تسريب تفاصيل تقنية حساسة", !/ECONNREFUSED|undefined|stack/i.test(mt), mt);

  const task = await rpc({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "get_task", arguments: { task_id: "unknown-task-xyz" } },
  }, sid);
  const t = task.msgs.find((x) => x.id === 3);
  check("get_task لمعرّف مجهول → isError", t?.result?.isError === true);
  check("رسالة «المهمة غير موجودة»", /غير موجودة/.test(textOf(t)), textOf(t));

  const list = await rpc({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "list_media", arguments: { limit: 5 } },
  }, sid);
  const l = list.msgs.find((x) => x.id === 4);
  check("list_media → نتيجة نصية عربية", !l?.result?.isError && /مهمة|لا توجد/.test(textOf(l)), textOf(l).slice(0, 120));

  const badArgs = await rpc({
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "generate_video", arguments: { prompt: "x", duration: 99 } },
  }, sid);
  const b = badArgs.msgs.find((x) => x.id === 5);
  check(
    "معامل خارج الحدود يُرفض (خطأ تحقق)",
    b?.result?.isError === true && /validation error|Invalid arguments|less than or equal/i.test(textOf(b)),
    textOf(b),
  );

  // تنظيف أي مهمة أنشأها هذا الاختبار
  const ids = new Set();
  for (const t of [mt, textOf(b)]) {
    for (const mm of t.matchAll(/task_id:\s*([^\s]+)/g)) ids.add(mm[1]);
  }
  for (const id of ids) {
    await fetch(`${BASE}/api/tasks?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  }

  console.log(`\n📊 النتيجة: ${passed} نجاح — ${failed} فشل`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
