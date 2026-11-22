/**
 * الأنواع المشتركة بين طبقات المشروع.
 */

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";
export type KeyStatus = "active" | "exhausted" | "disabled";

export type ErrorClass =
  | "disabled"
  | "exhausted"
  | "provider"
  | "params"
  | "temporary"
  | "unknown";

export interface TaskAttempt {
  provider: string;
  keyId?: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: ErrorClass | string;
  error?: string;
  /** ملاحظة داخلية: rebuild = إعادة إنشاء نفس المهمة على مفتاح تالٍ */
  note?: string;
  at: string;
}

export interface TaskRecord {
  id: string;
  provider: TaskProvider | null;
  providerTaskId: string | null;
  keyId: string | null;
  model: string;
  type: MediaType;
  prompt: string;
  params: Record<string, unknown>;
  status: TaskStatus;
  progress: number;
  resultUrls: string[];
  errorMessage: string | null;
  attempts: TaskAttempt[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ApiKeyRecord {
  id: string;
  provider: ProviderId;
  label: string;
  apiKey: string;
  status: KeyStatus;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  active: number;
}

export interface ProgressSink {
  (percent: number, message: string): void | Promise<void>;
}
