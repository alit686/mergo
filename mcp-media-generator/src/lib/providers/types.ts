import type { ProviderId } from "../types";

/** مدخلات موحّدة يترجمها كل مزود إلى شكل طلبه الحقيقي. */
export interface AdapterInput {
  type: "image" | "video";
  prompt: string;
  /** اسم الموديل لدى المزود (وليس الاسم القانوني) */
  model: string;
  aspectRatio?: string;
  resolution?: string;
  background?: string;
  outputFormat?: string;
  enableAudio?: boolean;
  duration?: number;
  imageUrl?: string;
  /**
   * إعادة محاولة مبسّطة: يُرسل الحقل الأساسي فقط (prompt + المدة + الصورة).
   * تُستخدم عندما يرفض المزود الطلب الكامل بخطأ داخلي غير مفيد.
   */
  minimal?: boolean;
}

export interface ProviderCheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  id: ProviderId;
  /** مهمة غير متزامنة (فيديو، وصور بعض المزودين). */
  createTask(key: string, input: AdapterInput): Promise<{ providerTaskId: string }>;
  /** صور متزامنة عبر نقطة متوافقة مع OpenAI (CometAPI). */
  createImageSync?(key: string, input: AdapterInput): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية. */
  checkTask(key: string, providerTaskId: string): Promise<ProviderCheckResult>;
}
