// اختبار MCP: initialize ← tools/list ← generate_image بدون مفاتيح (يجب أن يرد عربيًا)
const BASE = process.env.BASE || "http://127.0.0.1:3000";
const headers = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

/** يقرأ استجابة قد تكون JSON أو SSE */
async function readRpc(res) {
  const text = await res.text();
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) {
    const messages = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      try { messages.push(JSON.parse(raw)); } catch {}
    }
    return messages;
  }
  try { return [JSON.parse(text)]; } catch { return []; }
}

async function rpc(body, sid) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { ...headers, ...(sid ? { "mcp-session-id": sid } : {}) },
    body: JSON.stringify(body),
  });
  const msgs = await readRpc(res);
  return { res, msgs, sid: res.headers.get("mcp-session-id") || sid };
}

(async () => {
  console.log("🔌 اختبار MCP\n");

  const init = await rpc({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "verify-script", version: "1.0.0" },
    },
  });
  const initMsg = init.msgs.find((m) => m.id === 1);
  check("initialize → 200 + result", init.res.status === 200 && Boolean(initMsg?.result), JSON.stringify(initMsg));
  check("إرجاع mcp-session-id", Boolean(init.sid), init.sid || "missing");
  const sid = init.sid;

  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sid).catch(() => {});

  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
  const toolsMsg = list.msgs.find((m) => m.id === 2);
  const tools = toolsMsg?.result?.tools || [];
  const names = tools.map((t) => t.name).sort();
  check("tools/list يعرض 5 أدوات", tools.length === 5, `count=${tools.length}`);
  check(
    "الأدوات المطلوبة موجودة",
    ["generate_image", "generate_video", "merge_videos", "get_task", "list_media"].every((n) => names.includes(n)),
    names.join(","),
  );

  const call = await rpc({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "generate_image", arguments: { prompt: "a red fox in snow", model: "gpt-image-2-6/flare-text-to-image" } },
  }, sid);
  const callMsg = call.msgs.find((m) => m.id === 3);
  const text = callMsg?.result?.content?.map((c) => c.text || "").join("\n") || "";
  check("generate_image بلا مفاتيح → isError", callMsg?.result?.isError === true, JSON.stringify(callMsg));
  check("الرسالة عربية وتذكر غياب المفاتيح", /لا توجد مفاتيح|أضف مفتاح/.test(text), text);
  check("لا تسريب أسماء مزوّدين/مفاتيح", !/sk-|Bearer|kie\.ai|cometapi/i.test(text), text);

  const videoCall = await rpc({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "generate_video", arguments: { prompt: "a cat walking", model: "grok-imagine-video-1-5-preview" } },
  }, sid);
  const videoMsg = videoCall.msgs.find((m) => m.id === 4);
  const videoText = videoMsg?.result?.content?.map((c) => c.text || "").join("\n") || "";
  check("generate_video بلا مفاتيح → isError عربي", videoMsg?.result?.isError === true && /لا توجد مفاتيح/.test(videoText), videoText);

  const tasks = await (await fetch(`${BASE}/api/tasks?limit=50`)).json();
  check("لا تُنشأ مهام عالقة عند غياب المفاتيح", tasks?.stats?.total === 0, JSON.stringify(tasks?.stats));

  console.log(`\n📊 النتيجة: ${passed} نجاح — ${failed} فشل`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error("✗ خطأ غير متوقع:", err); process.exit(1); });
