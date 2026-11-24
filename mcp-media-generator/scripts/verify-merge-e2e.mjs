// اختبار دمج كامل من MCP → video-merger → ffmpeg → Turso → بث Range
const BASE = process.env.BASE || "http://127.0.0.1:3000";
const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

let passed = 0, failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

let sid = null;
let idSeq = 10;
async function rpc(body) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { ...headers, ...(sid ? { "mcp-session-id": sid } : {}) },
    body: JSON.stringify(body),
  });
  sid = res.headers.get("mcp-session-id") || sid;
  const msgs = await readRpc(res);
  return msgs.find((m) => m.id === body.id) || msgs[0];
}

const textOf = (m) => m?.result?.content?.map((c) => c.text || "").join("\n") || "";

const URLS = [
  "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
  "https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4",
];

(async () => {
  console.log("🎬 اختبار دمج e2e عبر MCP\n");

  const init = await rpc({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
  });
  check("initialize", Boolean(init?.result), JSON.stringify(init).slice(0, 160));
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});

  const health = await (await fetch(`${BASE}/api/health`)).json();
  check("health: merger.healthy = true", health?.merger?.healthy === true, JSON.stringify(health?.merger));

  const start = await rpc({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "merge_videos", arguments: { urls: URLS, wait_seconds: 0 } },
  });
  const startText = textOf(start);
  console.log("    بدء الدمج:", startText.split("\n")[0]);
  const taskId = (startText.match(/task_id:\s*([^\s]+)/) || [])[1];
  check("merge_videos يعيد task_id", Boolean(taskId), startText);
  if (!taskId) throw new Error("لا task_id — لا يمكن المتابعة");

  let done = null;
  const deadline = Date.now() + 200_000;
  let lastStatus = "";
  while (Date.now() < deadline) {
    await sleep(3000);
    const poll = await rpc({
      jsonrpc: "2.0", id: ++idSeq, method: "tools/call",
      params: { name: "get_task", arguments: { task_id: taskId } },
    });
    const text = textOf(poll);
    if (poll?.result?.isError) {
      check("get_task أثناء الدمج لا يفشل", false, text);
      break;
    }
    if (/تم دمج المقاطع بنجاح/.test(text)) { done = text; break; }
    const st = (text.match(/الحالة:\s*([^\s(]+)/) || [])[1] || "";
    if (st !== lastStatus) { console.log(`    الحالة: ${st || "…"}`); lastStatus = st; }
    if (/فشل/.test(text) && poll?.result?.isError) break;
  }

  check("اكتمل الدمج خلال المهلة", Boolean(done), lastStatus);
  if (!done) throw new Error("انتهت المهلة");

  const link = (done.match(/https?:\/\/[^\s)]+/) || [])[0];
  check("النتيجة تحتوي رابطًا", Boolean(link), done.slice(0, 200));
  check("تنبيه الحذف بعد 24 ساعة", /24 ساعة/.test(done));

  if (link) {
    const head = await fetch(link, { headers: { Range: "bytes=0-99" } });
    const buf = Buffer.from(await head.arrayBuffer());
    check("بث Range من الناتج → 206", head.status === 206, `status=${head.status}`);
    check("Content-Type video/mp4", String(head.headers.get("content-type")).includes("video/mp4"), head.headers.get("content-type"));
    check("100 بايت مستلمة", buf.length === 100, `len=${buf.length}`);
    check("بداية MP4 صالحة (ftyp)", buf.subarray(4, 8).toString("latin1") === "ftyp", buf.subarray(0, 12).toString("latin1"));

    // حذف مهمة الدمج من الخدمة نفسها (لا توجد أداة حذف في MCP)
    const jobId = (link.match(/\/api\/jobs\/([^/]+)\/video/) || [])[1];
    const mergerBase = health?.merger?.base || "http://127.0.0.1:3001";
    if (jobId) {
      const del = await fetch(`${mergerBase}/api/jobs/${jobId}`, { method: "DELETE" }).catch(() => ({ status: 0 }));
      check("حذف مهمة الدمج بعد الاختبار", del.status === 200, `status=${del.status}`);
    }
  }

  console.log(`\n📊 النتيجة: ${passed} نجاح — ${failed} فشل`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error("✗ خطأ:", err.message); process.exit(1); });
