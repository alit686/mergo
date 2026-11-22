import type { MediaType, ProviderId } from "./types";

/**
 * سجل الموديلات: الاسم القانوني كما يراه عميل MCP، مع صيغ بديلة (نقاط/شرطات)
 * واسم الموديل الخاص بكل مزود. الأسماء قابلة للتجاوز عبر متغيرات البيئة.
 */
export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: Exclude<MediaType, "merge">;
  providers: ProviderId[];
  providerModel: Record<ProviderId, string>;
}

export const IMAGE_MODEL = "gpt-image-2-6/flare-text-to-image";
export const VIDEO_MODEL = "grok-imagine-video-1-5-preview";
export const MERGE_MODEL = "video-merger";

/** توحيد الاسم: حروف صغيرة، بلا مسافات، النقاط تصبح شرطات (2.6 → 2-6). */
export function normalizeModelName(name: string): string {
  return (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\./g, "-")
    .replace(/-+/g, "-");
}

function envOr(key: string, fallback: string): string {
  const value = process.env[key]?.trim();
  return value ? value : fallback;
}

/** يُقرأ عند الطلب حتى تعمل تجاوزات البيئة على Vercel دون إعادة بناء. */
export function getModels(): ModelDef[] {
  return [
    {
      canonical: IMAGE_MODEL,
      aliases: ["gpt-image-2.6/flare-text-to-image", "gpt-image-2-6-flare-text-to-image"],
      type: "image",
      providers: ["kie", "cometapi"],
      providerModel: {
        kie: envOr("KIE_IMAGE_MODEL", IMAGE_MODEL),
        cometapi: envOr("COMETAPI_IMAGE_MODEL", "gpt-image-2.6-flare-text-to-image"),
      },
    },
    {
      canonical: VIDEO_MODEL,
      aliases: ["grok-imagine-video-1.5-preview", "grok-imagine-video-1-5"],
      type: "video",
      providers: ["kie", "cometapi"],
      providerModel: {
        kie: envOr("KIE_VIDEO_MODEL", VIDEO_MODEL),
        cometapi: envOr("COMETAPI_VIDEO_MODEL", VIDEO_MODEL),
      },
    },
  ];
}

/** يبحث بالاسم القانوني أو أي صيغة بديلة؛ null إذا كان الموديل غير معروف. */
export function resolveModel(name?: string | null, type?: Exclude<MediaType, "merge">): ModelDef | null {
  const models = getModels();
  if (!name || !name.trim()) {
    if (!type) return null;
    return models.find((m) => m.type === type) ?? null;
  }
  const wanted = normalizeModelName(name);
  for (const model of models) {
    const names = [model.canonical, ...model.aliases].map(normalizeModelName);
    if (names.includes(wanted)) return model;
  }
  return null;
}

export function modelTypeLabel(type: MediaType): string {
  return type === "image" ? "صورة" : type === "video" ? "فيديو" : "دمج";
}
