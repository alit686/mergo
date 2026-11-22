"use client";

import { useCallback, useEffect, useState } from "react";

/* ----------------------------- الأنواع ----------------------------- */

type KeyStatus = "active" | "exhausted" | "disabled";
type TaskStatus = "pending" | "processing" | "completed" | "failed";
type TaskType = "image" | "video" | "merge";
type Provider = "kie" | "cometapi";

interface KeyRow {
  id: string;
  provider: Provider;
  label: string;
  apiKey: string; // مقنّعة دائمًا
  status: KeyStatus;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastError: string | null;
  createdAt: string;
}

interface TaskRow {
  id: string;
  type: TaskType;
  model: string;
  prompt: string;
  status: TaskStatus;
  progress: number;
  resultUrls: string[];
  errorMessage: string | null;
  attempts: number;
  createdAt: string;
}

interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  active: number;
}

interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

/* ----------------------------- أدوات مساعدة ----------------------------- */

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "بانتظار",
  processing: "قيد المعالجة",
  completed: "مكتملة",
  failed: "فاشلة",
};
const STATUS_BADGE: Record<TaskStatus, string> = {
  pending: "bg-slate-500/15 text-slate-300 border border-slate-500/30",
  processing: "bg-cyan-500/15 text-cyan-300 border border-cyan-500/30",
  completed: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
  failed: "bg-red-500/15 text-red-300 border border-red-500/30",
};
const TYPE_BADGE: Record<TaskType, string> = {
  image: "bg-violet-500/15 text-violet-300 border border-violet-500/30",
  video: "bg-cyan-500/15 text-cyan-300 border border-cyan-500/30",
  merge: "bg-amber-500/15 text-amber-300 border border-amber-500/30",
};
const TYPE_LABEL: Record<TaskType, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const KEY_STATUS_BADGE: Record<KeyStatus, string> = {
  active: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
  exhausted: "bg-amber-500/15 text-amber-300 border border-amber-500/30",
  disabled: "bg-slate-500/15 text-slate-400 border border-slate-500/30",
};
const PROVIDER_LABEL: Record<Provider, string> = { kie: "kie.ai", cometapi: "CometAPI" };

function timeAgo(iso: string): string {
  if (!iso) return "—";
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return "—";
  const s = Math.floor(diff / 1000);
  if (s < 60) return "قبل ثوانٍ";
  if (s < 3600) return `قبل ${Math.floor(s / 60)} د`;
  if (s < 86400) return `قبل ${Math.floor(s / 3600)} س`;
  return `قبل ${Math.floor(s / 86400)} ي`;
}

function copyText(text: string): Promise<void> {
  return navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("no clipboard"));
}

/* ----------------------------- المكونات ----------------------------- */

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [stats, setStats] = useState<TaskStats>({ total: 0, completed: 0, failed: 0, active: 0 });
  const [tasks, setTasks] = useState<TaskRow[]>([]);

  const [provider, setProvider] = useState<Provider>("kie");
  const [label, setLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [mcpUrl, setMcpUrl] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const loadHealth = useCallback(() => {
    api<Health>("/api/health")
      .then((h) => {
        setHealth(h);
        if (typeof window !== "undefined") {
          setMcpUrl(`${window.location.origin}${h.mcpEndpoint}`);
        }
      })
      .catch(() => setHealth(null));
  }, []);

  const loadKeys = useCallback(() => {
    api<KeyRow[]>("/api/keys").then(setKeys).catch(() => setKeys([]));
  }, []);

  const loadTasks = useCallback(() => {
    api<{ stats: TaskStats; tasks: TaskRow[] }>("/api/tasks?limit=12")
      .then((d) => {
        setStats(d.stats);
        setTasks(d.tasks);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadHealth();
    loadKeys();
    loadTasks();
    const t1 = setInterval(loadTasks, 5000);
    const t2 = setInterval(loadHealth, 15000);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [loadHealth, loadKeys, loadTasks]);

  /* ---------- إضافة مفتاح ---------- */
  async function addKey(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setKeyMsg(null);
    try {
      const k = await api<KeyRow>("/api/keys", {
        method: "POST",
        body: JSON.stringify({ provider, api_key: newKey, label: label || undefined }),
      });
      setKeyMsg({ ok: true, text: `✓ تمت إضافة المفتاح (${PROVIDER_LABEL[k.provider]})` });
      setNewKey("");
      setLabel("");
      await loadKeys();
    } catch (err) {
      setKeyMsg({ ok: false, text: err instanceof Error ? err.message : "خطأ غير معروف" });
    } finally {
      setBusy(false);
    }
  }

  /* ---------- أدوات المفاتيح ---------- */
  async function toggleKey(k: KeyRow) {
    const next = k.status === "disabled" ? "active" : "disabled";
    try {
      await api(`/api/keys/${k.id}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
      await loadKeys();
    } catch (err) {
      alert(err instanceof Error ? err.message : "خطأ");
    }
  }
  async function removeKey(id: string) {
    if (!confirm("هل تريد حذف هذا المفتاح نهائيًا؟")) return;
    try {
      await api(`/api/keys/${id}`, { method: "DELETE" });
      await loadKeys();
    } catch (err) {
      alert(err instanceof Error ? err.message : "خطأ");
    }
  }

  /* ---------- نسخ جاهز للربط ---------- */
  const mcpServerJson = (
    type?: "http" | "mcp",
  ): string => {
    const h = health?.authRequired;
    const base = {
      "media-generator": {
        ...(type ? { type } : {}),
        url: mcpUrl,
        ...(h ? { headers: { Authorization: `Bearer ${h ? "YOUR_ACCESS_TOKEN" : ""}` } } : {}),
      },
    };
    return JSON.stringify({ mcpServers: base }, null, 2);
  };

  function tabConfig(tab: string): string {
    if (tab === "claude") return mcpServerJson("http");
    if (tab === "cursor") return mcpServerJson();
    return mcpServerJson();
  }

  const [activeTab, setActiveTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");

  const toolChips = [
    { name: "generate_image", desc: "توليد صورة من وصف نصي (flare-text-to-image)" },
    { name: "generate_video", desc: "توليد فيديو بصوت متزامن (grok-imagine-video)" },
    { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب" },
    { name: "get_task", desc: "تتبّع أي مهمة حتى الاكتمال (كل ~10 ثوانٍ)" },
    { name: "list_media", desc: "استرجاع الوسائط المولّدة السابقة بروابطها" },
  ];

  const TAB_HINTS: Record<typeof activeTab, string> = {
    chatgpt: "في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».",
    claude: "انسخ في الملف claude_desktop_config.json الخاص بـ Claude Desktop.",
    cursor: "انسخ في ملف mcp.json أو في Cursor: Settings → MCP → Add (صيغة mcp.json).",
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 space-y-6">
      {/* ======= الهيدر ======= */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-cyan-500 to-violet-500 grid place-items-center text-white text-lg font-black">
            🎬
          </div>
          <div>
            <h1 className="text-lg font-extrabold text-white">MCP Media Generator</h1>
            <p className="text-xs text-slate-400">توليد صور وفيديو بالذكاء الاصطناعي + دمج المقاطع — خادم MCP</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-semibold border ${
            health?.database === "turso-connected"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : "border-red-500/30 bg-red-500/10 text-red-300"
          }`}>
            <span className={`h-2 w-2 rounded-full ${health?.database === "turso-connected" ? "bg-emerald-400 animate-pulse" : "bg-red-400"}`} />
            {health?.database === "turso-connected" ? "Turso متصل" : health ? "Turso غير متصل" : "جارٍ الفحص…"}
          </span>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-semibold border ${
            health?.merger?.healthy
              ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-300"
              : "border-slate-500/30 bg-slate-500/10 text-slate-300"
          }`}>
            {health?.merger?.healthy ? "خدمة الدمج جاهزة ✓" : "خدمة الدمج غير مهيأة"}
          </span>
          {health?.authRequired && (
            <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-semibold border border-amber-500/30 bg-amber-500/10 text-amber-300">
              🔒 حماية /mcp مفعّلة
            </span>
          )}
        </div>
      </header>

      {/* ======= البطاقة أ: مدير المفاتيح ======= */}
      <section className="card">
        <h2 className="mb-1 text-base font-bold text-white">🔑 مدير المفاتيح</h2>
        <p className="mb-4 text-xs leading-relaxed text-slate-400">
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
        </p>

        <form onSubmit={addKey} className="mb-5 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-400">المزود</label>
            <select
              className="field w-36"
              value={provider}
              onChange={(e) => setProvider(e.target.value as Provider)}
            >
              <option value="kie">kie.ai</option>
              <option value="cometapi">CometAPI</option>
            </select>
          </div>
          <div className="flex flex-col gap-1 flex-1 min-w-[220px]">
            <label className="text-xs text-slate-400">المفتاح (API Key)</label>
            <input
              className="field"
              dir="ltr"
              placeholder="kie-xxxxxxxx… أو cometapi-…"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-1 flex-1 min-w-[180px]">
            <label className="text-xs text-slate-400">تسمية اختيارية</label>
            <input className="field" placeholder="مثال: المفتاح الرئيسي" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <button type="submit" className="btn-primary" disabled={busy || !newKey.trim()}>
            {busy ? "جارٍ الإضافة…" : "+ إضافة"}
          </button>
        </form>

        {keyMsg && (
          <p className={`mb-4 text-sm ${keyMsg.ok ? "text-emerald-300" : "text-red-300"}`}>{keyMsg.text}</p>
        )}

        <div className="space-y-2">
          {keys.length === 0 && (
            <p className="rounded-xl border border-dashed border-slate-600 p-4 text-center text-sm text-slate-500">
              لا توجد مفاتيح بعد — أضف أول مفتاح أعلاه.
            </p>
          )}
          {keys.map((k) => (
            <div key={k.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-700/60 bg-ink-900/60 px-4 py-3">
              <span className="badge badge-info">{PROVIDER_LABEL[k.provider]}</span>
              <span className={`badge ${KEY_STATUS_BADGE[k.status]}`}>
                {k.status === "active" ? "نشط" : k.status === "exhausted" ? "رصيد منتهي" : "معطّل"}
              </span>
              <span className="font-mono text-sm text-slate-300" dir="ltr">
                {k.apiKey}
              </span>
              {k.label && <span className="text-xs text-slate-400">({k.label})</span>}
              <div className="ms-auto flex items-center gap-1.5 text-xs text-slate-400">
                <span title="استخدام">🔄 {k.usageCount}</span>
                <span className="text-emerald-400">✓ {k.successCount}</span>
                <span className="text-red-400">✗ {k.failCount}</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                {k.lastError && (
                  <span className="max-w-[220px] truncate text-amber-400" title={k.lastError}>
                    {k.lastError}
                  </span>
                )}
                <button
                  className="btn-ghost !px-2.5 !py-1 text-xs"
                  onClick={() => toggleKey(k)}
                  title={k.status === "disabled" ? "تفعيل" : "تعطيل"}
                >
                  {k.status === "disabled" ? "تفعيل" : "تعطيل"}
                </button>
                <button className="btn-danger !px-2.5 !py-1 text-xs" onClick={() => removeKey(k.id)}>
                  حذف
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ======= البطاقة ب: لوحة المهام ======= */}
      <section className="card">
        <h2 className="mb-4 text-base font-bold text-white">📋 لوحة المهام</h2>

        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "الإجمالي", value: stats.total, cls: "text-slate-100" },
            { label: "مكتملة", value: stats.completed, cls: "text-emerald-300" },
            { label: "فاشلة", value: stats.failed, cls: "text-red-300" },
            { label: "جارية", value: stats.active, cls: "text-cyan-300" },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-slate-700/60 bg-ink-900/60 p-4 text-center">
              <div className={`text-2xl font-extrabold ${s.cls}`}>{s.value}</div>
              <div className="mt-1 text-xs text-slate-400">{s.label}</div>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          {tasks.length === 0 && (
            <p className="rounded-xl border border-dashed border-slate-600 p-4 text-center text-sm text-slate-500">
              لا توجد مهام بعد. استدعِ الأدوات من أي عميل MCP وستظهر هنا لحظيًا.
            </p>
          )}
          {tasks.map((t) => (
            <div key={t.id} className="rounded-xl border border-slate-700/60 bg-ink-900/60 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`badge ${TYPE_BADGE[t.type]}`}>{TYPE_LABEL[t.type]}</span>
                <span className={`badge ${STATUS_BADGE[t.status]}`}>{STATUS_LABEL[t.status]}</span>
                <span className="text-xs text-slate-400">{t.model}</span>
                <span className="ms-auto text-xs text-slate-500">{timeAgo(t.createdAt)}</span>
              </div>
              {t.prompt && (
                <p className="mt-2 line-clamp-1 text-xs text-slate-300">{t.prompt}</p>
              )}
              {/* شريط التقدم */}
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className={`h-full rounded-full transition-all ${
                    t.status === "failed"
                      ? "bg-red-400"
                      : t.status === "completed"
                        ? "bg-emerald-400"
                        : "bg-gradient-to-l from-cyan-400 to-violet-400"
                  }`}
                  style={{ width: `${t.progress}%` }}
                />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span className="font-mono" dir="ltr">#{t.id.slice(0, 8)}</span>
                <span>{t.progress}%</span>
                {t.attempts > 0 && <span>مجردات: {t.attempts}</span>}
                {t.status === "completed" && t.resultUrls.length > 0 && (
                  <span className="flex flex-wrap gap-1">
                    {t.resultUrls.map((u, i) => (
                      <a
                        key={i}
                        href={u}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="badge badge-info"
                      >
                        🖼 فتح الرابط {i + 1}
                      </a>
                    ))}
                  </span>
                )}
                {t.status === "failed" && t.errorMessage && (
                  <span className="text-red-300">{t.errorMessage}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ======= البطاقة ج: ربط السيرفر ======= */}
      <section className="card">
        <h2 className="mb-4 text-base font-bold text-white">🔌 ربط السيرفر</h2>

        <div className="mb-4 flex items-center gap-2">
          <input className="field font-mono" dir="ltr" readOnly value={mcpUrl || "جارٍ التحميل…"} />
          <button
            className="btn-ghost"
            onClick={() => {
              copyText(mcpUrl);
              setCopied("url");
              setTimeout(() => setCopied(null), 1500);
            }}
          >
            {copied === "url" ? "✓ نُسخ" : "نسخ الرابط"}
          </button>
        </div>

        {/* التبويبات */}
        <div className="mb-3 flex gap-2">
          {(
            [
              { id: "chatgpt", label: "ChatGPT / GPT Agents" },
              { id: "claude", label: "Claude Desktop" },
              { id: "cursor", label: "Cursor / Windsurf / Cline" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === tab.id
                  ? "bg-cyan-500/20 text-cyan-200 border border-cyan-500/40"
                  : "border border-slate-600 text-slate-400 hover:bg-slate-800"
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <p className="mb-2 text-xs text-slate-400">{TAB_HINTS[activeTab]}</p>

        <div className="relative">
          <pre className="overflow-auto rounded-xl border border-slate-700/60 bg-black/40 p-4 font-mono text-xs leading-relaxed text-emerald-200" dir="ltr">
            {tabConfig(activeTab)}
          </pre>
          <button
            className="absolute end-2 top-2 btn-ghost !px-3 !py-1 text-xs"
            onClick={() => {
              copyText(tabConfig(activeTab));
              setCopied("tab");
              setTimeout(() => setCopied(null), 1500);
            }}
          >
            {copied === "tab" ? "✓ نُسخ" : "نسخ"}
          </button>
        </div>

        {/* رقائق الأدوات */}
        <div className="mt-5">
          <p className="mb-2 text-xs font-semibold text-slate-400">الأدوات المتاحة (5)</p>
          <div className="flex flex-wrap gap-2">
            {toolChips.map((t) => (
              <span key={t.name} className="inline-flex items-center gap-1 rounded-full border border-slate-600 bg-ink-900/60 px-3 py-1 text-xs text-slate-200">
                <span className="font-mono text-cyan-300">{t.name}</span>
                <span className="text-slate-400">— {t.desc}</span>
              </span>
            ))}
          </div>
        </div>

        <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">
          ⚠️ <strong>الفيديو يحتاج دقائق:</strong> يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ —
          وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
        </p>
      </section>

      {/* ======= الفوتر ======= */}
      <footer className="pb-8 pt-2 text-center text-xs text-slate-600">
        media-generator-mcp v1.2.0 — kie.ai + CometAPI + خدمة دمج الفيديو — مفاتيحك لا تُكشف أبدًا
      </footer>
    </main>
  );
}