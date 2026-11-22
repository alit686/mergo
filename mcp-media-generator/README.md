# 🎨 MCP Media Generator

خادم **MCP** (Model Context Protocol) مبني على Next.js 15 لتوليد الصور والفيديو ودمج المقاطع، مع **تبديل تسلسلي صامت لمفاتيح API** ولوحة تحكم عربية (RTL).

> الأدوات والأوصاف موجّهة بالإنجليزية لنموذج الذكاء الاصطناعي، أما نتائج الأدوات والواجهة فبالعربية.

---

## ✨ المزايا

- **5 أدوات MCP**: `generate_image`، `generate_video`، `merge_videos`، `get_task`، `list_media`.
- **تبديل مفاتيح تلقائي**: عند أي فشل (رصيد منتهٍ، مفتاح غير صالح، 429، 5xx) ينتقل الخادم للمفتاح التالي بالترتيب `created_at ASC, id ASC` — بنفس `task_id` ودون إظهار أي خطأ متعلق بالمفاتيح للمستخدم.
- **استئناف المهام**: كل 45 ثانية تُعاد المحاولة تلقائيًا عبر `get_task` حتى مع نفاد كل المفاتيح مؤقتًا.
- **إشعارات تقدم** (`notifications/progress`) أثناء الانتظار.
- **لوحة إدارة عربية**: إضافة/تعطيل/حذف المفاتيح، إحصائيات المهام، نسخ إعدادات MCP الجاهزة.
- **بدون تنزيل وسائط**: الخادم يعيد الروابط فقط.
- **دمج فيديو** عبر خدمة `video-merger` المنفصلة (المشروع الثاني).

---

## 🧱 التقنيات

| العنصر | الإصدار |
|---|---|
| Next.js (App Router) | 15.5.29 |
| React | 19.1 |
| TypeScript | 5.6 |
| Tailwind CSS | 3.4 |
| `@modelcontextprotocol/sdk` | 1.32.2 |
| `@libsql/client` (Turso / libSQL) | 0.18 |
| Zod | 3.25 |

كل مسارات API و`/mcp` تعمل بـ `runtime = "nodejs"`، و`/mcp` و`/api/health` بـ `dynamic = "force-dynamic"`.

---

## 🚀 التشغيل محليًا

```bash
npm install
cp .env.example .env.local   # ثم املأ القيم
npm run dev                  # http://localhost:3000
```

بدون `TURSO_DATABASE_URL` يعمل المشروع على ملف libSQL محلي داخل `.data/` (للتطوير فقط).

### أوامر

```bash
npm run dev        # تطوير
npm run build      # بناء إنتاجي
npm run start      # تشغيل البناء
npm run typecheck  # tsc --noEmit
```

---

## ⚙️ متغيرات البيئة

| المتغير | إلزامي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ في الإنتاج | رابط قاعدة Turso (`libsql://…`) |
| `TURSO_AUTH_TOKEN` | ✅ في الإنتاج | توكن Turso |
| `MERGER_API_BASE` | للدمج | رابط نشر `video-merger` مثل `https://your-merger.vercel.app` |
| `MCP_ACCESS_TOKEN` | لا | إن ضُبط، يتطلب `Authorization: Bearer <token>` على `/mcp` |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` | لا | تجاوز أسماء موديلات kie.ai |
| `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | لا | تجاوز أسماء موديلات CometAPI |

> لا تُضاف ملفات `.env*` إلى Git — `.gitignore` يغطيها.

---

## 🔌 نقاط النهاية

| الطريقة | المسار | الوظيفة |
|---|---|---|
| `POST/GET/DELETE` | `/mcp` | Streamable HTTP MCP (جلسات عبر `mcp-session-id`) |
| `GET` | `/api/health` | حالة القاعدة، الموديلات، خدمة الدمج، هل المصادقة مطلوبة |
| `GET` | `/api/keys` | قائمة المفاتيح (مقنّعة دائمًا) |
| `POST` | `/api/keys` | إضافة مفتاح — `{provider, api_key, label?}` |
| `PATCH` | `/api/keys/{id}` | تغيير الحالة — `{status: "active"\|"exhausted"\|"disabled"}` |
| `DELETE` | `/api/keys/{id}` | حذف المفتاح |
| `GET` | `/api/tasks` | المهام + الإحصائيات (`?type=&status=&limit=`) |
| `DELETE` | `/api/tasks?id=` | حذف مهمة |

### أمثلة

```bash
# إضافة مفتاح
curl -X POST http://localhost:3000/api/keys \
  -H 'Content-Type: application/json' \
  -d '{"provider":"kie","api_key":"YOUR_KEY","label":"أساسي"}'

# تعطيله
curl -X PATCH http://localhost:3000/api/keys/<id> \
  -H 'Content-Type: application/json' \
  -d '{"status":"disabled"}'

# حذفه
curl -X DELETE http://localhost:3000/api/keys/<id>
```

> **كل** الاستجابات تُرجع المفتاح مقنّعًا (`sk-veri••••••••cdef`) ولا تعيد القيمة الخام أبدًا. التكرار لنفس المفتاح والمزوّد يعيد `409`.

---

## 🛠️ أدوات MCP

### `generate_image`
| المعامل | النوع | الافتراضي |
|---|---|---|
| `prompt` | string (مطلوب) | — |
| `model` | `gpt-image-2-6/flare-text-to-image` أو `gpt-image-2.6/flare-text-to-image` | الأولى |
| `aspect_ratio` | auto, 1:1, 3:2, … 21:9 | `auto` |
| `resolution` | `1K` / `2K` / `4K` | `1K` |
| `background` | `auto` / `transparent` / `opaque` | `auto` |
| `output_format` | `png` / `jpeg` / `webp` / `gif` | `png` |
| `wait_seconds` | 0–240 | `90` |

### `generate_video`
| المعامل | النوع | الافتراضي |
|---|---|---|
| `prompt` | string (حتى 4096) | — |
| `image_url` | رابط صورة اختياري (image-to-video) | — |
| `model` | `grok-imagine-video-1-5-preview` أو `…1.5-preview` | الأولى |
| `aspect_ratio` | auto, 1:1, 16:9, 9:16, 3:2, 2:3 | `auto` |
| `resolution` | `480p` / `720p` / `1080p` | `480p` |
| `enable_audio` | boolean | `true` |
| `duration` | 1–15 ثانية | `8` |
| `wait_seconds` | 0–240 | `25` |

### `merge_videos`
- `urls[]` **أو** `task_ids[]` (2–10، بالترتيب المطلوب).
- `wait_seconds` (0–240، افتراضي 60).
- ملف الدمج يبقى ~24 ساعة على خدمة الدمج فقط.

### `get_task`
- `task_id` — يعمل مع الصور والفيديو والدمج، ويحدّث الحالة من المزوّد إن كانت قيد المعالجة.

### `list_media`
- `type?` (image/video/merge)، `status?` (completed/failed/processing)، `limit` (1–50، افتراضي 10).

---

## 🔑 منطق تبديل المفاتيح

1. يُختار المفتاح التالي من القاعدة بالترتيب `created_at ASC, id ASC` مع تصفية المزوّد والموديل.
2. عند `401/402/429/5xx` أو رصيد منتهٍ: يُسجَّل فشل المفتاح، ويُجرَّب التالي **بصمت** وبنفس `task_id`.
3. إذا نفدت كل المفاتيح: تُترك المهمة `processing`، وتُعاد المحاولة بعد **45 ثانية** عند أي `get_task`.
4. لا تُعاد للمستخدم أي رسالة عن المفاتيح أو الأرصدة أو أخطاء المزوّد الخام.

---

## 🗄️ قاعدة البيانات

جداول Turso (تُنشأ تلقائيًا):

- `api_keys` — المفتاح، المزوّد، التسمية، الحالة، عدّادات النجاح/الفشل، `last_used_at`.
- `tasks` — النوع، الموديل، الطلب، الحالة، التقدم، `result_urls`، `attempts` (سجل JSON للمحاولات)، الخطأ.
- `key_usage` — سجل استخدام المفتاح لكل مهمة.

---

## 🧪 التحقق المنفَّذ

```bash
npm run typecheck   # نظيف
npm run build       # 5 مسارات + /api/keys/[id]
```

تم اختبار الخادم حيًا على نسخة الإنتاج:

- `initialize` + `tools/list`: الأدوات الخمس بمخططاتها ✓
- `generate_image` و`generate_video` بدون مفاتيح: رسالة عربية `❌ لا توجد مفاتيح نشطة…` بدون تسريب، **ودون إنشاء مهام عالقة** ✓ (9/9)
- CRUD المفاتيح: **26/26** فحصًا (إضافة، تكرار 409، تعطيل، تفعيل، حذف، 404/405/400، وتأكيد التمويه) ✓
- مسارات سلبية: `get_task` لمعرّف مجهول، `list_media`، رفض المعاملات خارج الحدود (**6/6**) ✓
- **دمج e2e حقيقي عبر MCP**: مقطعان عامان ← خدمة `video-merger` ← ffmpeg ← Turso ← بث `Range 206` (**11/11**) ✓
- `GET /api/health`: `ok:true` و`database:"turso-connected"` و`merger.healthy:true` عند ضبط `MERGER_API_BASE` ✓

### إعادة تشغيل التحقق

```bash
# يتطلب خادمًا يعمل على http://127.0.0.1:3000
npm start
npm run verify:no-keys    # 9 فحوص
npm run verify:keys       # 26 فحصًا
npm run verify:negative   # 6 فحوص
npm run verify:merge      # 11 فحصًا (يتطلب MERGER_API_BASE)
```

> **غير مُختبر فعليًا**: التوليد الحقيقي عبر kie.ai/CometAPI، وسلوك تبديل المفاتيح عند فشل حقيقي، وإعادة المحاولة كل 45 ثانية — كلها تتطلب مفاتيح مزوّد حقيقية (لا تتوفر في بيئة الاختبار).

---

## ☁️ النشر على Vercel

1. أنشئ قاعدة Turso ثم اضبط `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN`.
2. انشر `video-merger` أولًا، ثم اضبط `MERGER_API_BASE` هنا.
3. (اختياري) اضبط `MCP_ACCESS_TOKEN` لحماية `/mcp`.
4. `vercel deploy` — لا حاجة لإعدادات بناء خاصة.

بعد النشر:
```json
{
  "mcpServers": {
    "media-generator": {
      "type": "http",
      "url": "https://<your-domain>/mcp",
      "headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }
    }
  }
}
```

---

## 📁 الهيكل

```
src/
  app/
    page.tsx                 ← لوحة التحكم العربية
    mcp/route.ts             ← خادم MCP والأدوات الخمس
    api/health/route.ts
    api/keys/route.ts        ← GET/POST
    api/keys/[id]/route.ts   ← PATCH/DELETE
    api/tasks/route.ts
  lib/
    turso.ts                 ← المخطط + CRUD + ترتيب المفاتيح
    generation.ts            ← قلب التبديل/الاستئناف/الدمج
    providers/               ← kie.ts + cometapi.ts
    errors.ts                ← تصنيف الأخطاء وتنقيتها
    merger.ts                ← عميل خدمة الدمج
    models.ts                ← تعريف الموديلات وأسماؤها
```
