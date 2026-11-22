# Mergo — توليد الوسائط ودمج الفيديو

مستودع يضم مشروعين متكاملين:

| المجلد | الوصف | التقنيات |
|---|---|---|
| [`mcp-media-generator`](./mcp-media-generator) | خادم MCP لتوليد الصور والفيديو مع تبديل تسلسلي لمفاتيح API ولوحة عربية | Next.js 15، TypeScript، MCP SDK، Turso |
| [`video-merger`](./video-merger) | خدمة دمج فيديوهات على Vercel بواجهة عربية وAPI عام | Node.js، ffmpeg-static، Turso Blobs |

## الموديلات الافتراضية

- **صورة:** `gpt-image-2-6/flare-text-to-image`
- **فيديو:** `grok-imagine-video-1-5-preview`

## الترتيب الصحيح للنشر

1. انشر **`video-merger`** أولًا واضبط `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN`.
2. انشر **`mcp-media-generator`** واضبط نفس متغيرات Turso + `MERGER_API_BASE` (رابط خدمة الدمج).
3. أضف مفتاح kie.ai من لوحة التحكم في خادم MCP.

## التشغيل محليًا

```bash
# خدمة الدمج
cd video-merger
npm install
cp .env.example .env      # املأ Turso
npm run dev               # http://localhost:3001

# خادم MCP
cd ../mcp-media-generator
npm install
cp .env.example .env.local  # املأ Turso و MERGER_API_BASE
npm run dev                 # http://localhost:3000
```

## الاختبارات

```bash
cd video-merger && npm test          # 29 وحدة + 51 HTTP
cd mcp-media-generator
npm run typecheck && npm run build
npm run verify:keys                  # يتطلب خادمًا يعمل على 3000
```

## الأمان

- لا تُرفع ملفات `.env*` أو قواعد `.data` إلى Git — وهي مستثناة في `.gitignore`.
- المفاتيح تُخزَّن في Turso وتُعرض مقنّعة فقط.
- `/mcp` يمكن حمايته بـ `MCP_ACCESS_TOKEN`، ويُفضّل حماية لوحة الإدارة عند النشر العام.
