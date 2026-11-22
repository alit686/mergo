import { createClient, type Client, type InValue, type Row } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import { safeJson } from "./utils";
import type {
  ApiKeyRecord,
  KeyStatus,
  MediaType,
  ProviderId,
  TaskAttempt,
  TaskRecord,
  TaskStats,
  TaskStatus,
} from "./types";

/**
 * عميل Turso واحد لكل عملية (يُعاد استخدامه داخل نفس الـ instance).
 * في التطوير المحلي فقط — وعند غياب TURSO_DATABASE_URL — نستخدم ملف libSQL محلي
 * حتى تعمل التجارب. على Vercel لا يوجد نظام ملفات دائم، لذلك الإنتاج يشترط Turso.
 */
const remoteUrl = process.env.TURSO_DATABASE_URL?.trim();
const remoteToken = process.env.TURSO_AUTH_TOKEN?.trim();

function localFallbackUrl(): string {
  // /tmp متاح على Vercel لكنه غير دائم — نستخدمه فقط لتفادي انهيار الاستيراد.
  const dir = process.env.VERCEL ? "/tmp/mcp-media-generator" : path.join(process.cwd(), ".data");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* تجاهل: بعض البيئات للقراءة فقط */
  }
  return `file:${path.join(dir, "local.db")}`;
}

export const isRemoteDatabase = Boolean(remoteUrl);

export const db: Client = createClient({
  url: remoteUrl || localFallbackUrl(),
  authToken: remoteToken,
});

let schemaPromise: Promise<void> | null = null;

/** إنشاء الجداول عند أول وصول — لا حاجة لأداة migrations. */
export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.batch(
        [
          `CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            provider TEXT,
            provider_task_id TEXT,
            key_id TEXT,
            model TEXT NOT NULL,
            type TEXT NOT NULL,
            prompt TEXT DEFAULT '',
            params_json TEXT DEFAULT '{}',
            status TEXT NOT NULL,
            progress INTEGER DEFAULT 0,
            result_urls_json TEXT,
            error_message TEXT,
            attempts_json TEXT DEFAULT '[]',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            completed_at TEXT
          )`,
          `CREATE TABLE IF NOT EXISTS api_keys (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            label TEXT DEFAULT '',
            api_key TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            usage_count INTEGER DEFAULT 0,
            success_count INTEGER DEFAULT 0,
            fail_count INTEGER DEFAULT 0,
            last_used_at TEXT,
            last_checked_at TEXT,
            last_error TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          )`,
          `CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks (created_at DESC)`,
          `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status)`,
          `CREATE INDEX IF NOT EXISTS idx_keys_provider ON api_keys (provider, status)`,
        ],
        "write",
      );
    })().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    const result = await db.execute("SELECT 1 AS ok");
    return Number(result.rows[0]?.ok) === 1;
  } catch {
    return false;
  }
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value: unknown): string | null {
  return value == null ? null : String(value);
}

/* ------------------------------- المهام ------------------------------- */

function rowToTask(row: Row): TaskRecord {
  const r = row as unknown as Record<string, unknown>;
  return {
    id: String(r.id),
    provider: (r.provider as TaskRecord["provider"]) ?? null,
    providerTaskId: str(r.provider_task_id),
    keyId: str(r.key_id),
    model: String(r.model ?? ""),
    type: (r.type as MediaType) ?? "image",
    prompt: String(r.prompt ?? ""),
    params: safeJson<Record<string, unknown>>(r.params_json, {}),
    status: (r.status as TaskStatus) ?? "pending",
    progress: num(r.progress),
    resultUrls: safeJson<string[]>(r.result_urls_json, []),
    errorMessage: str(r.error_message),
    attempts: safeJson<TaskAttempt[]>(r.attempts_json, []),
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
    completedAt: str(r.completed_at),
  };
}

export interface InsertTaskInput {
  id?: string;
  provider?: string | null;
  providerTaskId?: string | null;
  keyId?: string | null;
  model: string;
  type: MediaType;
  prompt?: string;
  params?: Record<string, unknown>;
  status?: TaskStatus;
  progress?: number;
}

export async function insertTask(input: InsertTaskInput): Promise<TaskRecord> {
  await ensureSchema();
  const id = input.id ?? crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO tasks
      (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, result_urls_json, attempts_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]')`,
    args: [
      id,
      input.provider ?? null,
      input.providerTaskId ?? null,
      input.keyId ?? null,
      input.model,
      input.type,
      input.prompt ?? "",
      JSON.stringify(input.params ?? {}),
      input.status ?? "pending",
      input.progress ?? 0,
    ],
  });
  const task = await getTask(id);
  if (!task) throw new Error("failed to insert task");
  return task;
}

export async function getTask(id: string): Promise<TaskRecord | null> {
  await ensureSchema();
  const result = await db.execute({ sql: `SELECT * FROM tasks WHERE id = ?`, args: [id] });
  const row = result.rows[0];
  return row ? rowToTask(row) : null;
}

export interface TaskPatch {
  provider?: string | null;
  providerTaskId?: string | null;
  keyId?: string | null;
  status?: TaskStatus;
  progress?: number;
  resultUrls?: string[];
  errorMessage?: string | null;
  appendAttempts?: TaskAttempt[];
  /** لمس updated_at فقط لإعادة ضبط تهدئة إعادة المحاولة. */
  touch?: boolean;
}

/** تعديل جزئي: يضيف attempts ويضبط completed_at تلقائيًا عند الاكتمال/الفشل. */
export async function updateTask(id: string, patch: TaskPatch): Promise<TaskRecord | null> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];

  const set = (column: string, value: InValue) => {
    sets.push(`${column} = ?`);
    args.push(value);
  };

  if (patch.provider !== undefined) set("provider", patch.provider);
  if (patch.providerTaskId !== undefined) set("provider_task_id", patch.providerTaskId);
  if (patch.keyId !== undefined) set("key_id", patch.keyId);
  if (patch.status !== undefined) set("status", patch.status);
  if (patch.progress !== undefined) set("progress", Math.max(0, Math.min(100, Math.round(patch.progress))));
  if (patch.resultUrls !== undefined) set("result_urls_json", JSON.stringify(patch.resultUrls));
  if (patch.errorMessage !== undefined) set("error_message", patch.errorMessage);

  if (patch.appendAttempts?.length) {
    const current = await getTask(id);
    const merged = [...(current?.attempts ?? []), ...patch.appendAttempts];
    set("attempts_json", JSON.stringify(merged));
  }

  if (patch.status === "completed" || patch.status === "failed") {
    sets.push(`completed_at = COALESCE(completed_at, datetime('now'))`);
  }

  sets.push(`updated_at = datetime('now')`);

  if (!sets.length) return getTask(id);
  if (args.length) args.push(id);
  await db.execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });

  return getTask(id);
}

export interface TaskFilter {
  type?: MediaType;
  status?: TaskStatus;
}

export async function listRecentTasks(limit = 20, filter: TaskFilter = {}): Promise<TaskRecord[]> {
  await ensureSchema();
  const clauses: string[] = [];
  const args: InValue[] = [];
  if (filter.type) {
    clauses.push("type = ?");
    args.push(filter.type);
  }
  if (filter.status) {
    clauses.push("status = ?");
    args.push(filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  args.push(Math.max(1, Math.min(100, Math.round(limit))));
  const result = await db.execute({
    sql: `SELECT * FROM tasks ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    args,
  });
  return result.rows.map(rowToTask);
}

export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const result = await db.execute(
    `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS active
     FROM tasks`,
  );
  const row = (result.rows[0] ?? {}) as unknown as Record<string, unknown>;
  return {
    total: num(row.total),
    completed: num(row.completed),
    failed: num(row.failed),
    active: num(row.active),
  };
}

export async function deleteTask(id: string): Promise<void> {
  await ensureSchema();
  await db.execute({ sql: `DELETE FROM tasks WHERE id = ?`, args: [id] });
}

/* ------------------------------ المفاتيح ------------------------------ */

function rowToKey(row: Row): ApiKeyRecord {
  const r = row as unknown as Record<string, unknown>;
  return {
    id: String(r.id),
    provider: String(r.provider) as ProviderId,
    label: String(r.label ?? ""),
    apiKey: String(r.api_key ?? ""),
    status: (String(r.status ?? "active") as KeyStatus) ?? "active",
    usageCount: num(r.usage_count),
    successCount: num(r.success_count),
    failCount: num(r.fail_count),
    lastUsedAt: str(r.last_used_at),
    lastCheckedAt: str(r.last_checked_at),
    lastError: str(r.last_error),
    createdAt: String(r.created_at ?? ""),
  };
}

export async function listKeys(): Promise<ApiKeyRecord[]> {
  await ensureSchema();
  const result = await db.execute(`SELECT * FROM api_keys ORDER BY created_at ASC, id ASC`);
  return result.rows.map(rowToKey);
}

export async function getKeyById(id: string): Promise<ApiKeyRecord | null> {
  await ensureSchema();
  const result = await db.execute({ sql: `SELECT * FROM api_keys WHERE id = ?`, args: [id] });
  const row = result.rows[0];
  return row ? rowToKey(row) : null;
}

/**
 * ترتيب تسلسلي صارم بترتيب الإضافة (created_at ASC, id ASC).
 * المفتاح المستنزف يبقى في القائمة — الاستثناء الوحيد هو disabled اليدوي.
 */
export async function getKeyPool(providers: ProviderId[]): Promise<ApiKeyRecord[]> {
  await ensureSchema();
  if (!providers.length) return [];
  const placeholders = providers.map(() => "?").join(", ");
  const result = await db.execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return result.rows.map(rowToKey);
}

export async function findDuplicateKey(provider: ProviderId, apiKey: string): Promise<ApiKeyRecord | null> {
  await ensureSchema();
  const result = await db.execute({
    sql: `SELECT * FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1`,
    args: [provider, apiKey],
  });
  const row = result.rows[0];
  return row ? rowToKey(row) : null;
}

export async function insertKey(provider: ProviderId, apiKey: string, label: string): Promise<ApiKeyRecord> {
  await ensureSchema();
  const id = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status) VALUES (?, ?, ?, ?, 'active')`,
    args: [id, provider, label, apiKey],
  });
  const key = await getKeyById(id);
  if (!key) throw new Error("failed to insert key");
  return key;
}

export async function setKeyStatus(id: string, status: KeyStatus, lastError?: string | null): Promise<void> {
  await ensureSchema();
  await db.execute({
    sql: `UPDATE api_keys SET status = ?, last_checked_at = datetime('now'), last_error = COALESCE(?, last_error) WHERE id = ?`,
    args: [status, lastError ?? null, id],
  });
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await db.execute({ sql: `DELETE FROM api_keys WHERE id = ?`, args: [id] });
}

/** تحديث عدّادات المفتاح بعد كل محاولة (نجاحًا كانت أو فشلًا). */
export async function recordKeyOutcome(
  id: string,
  ok: boolean,
  error: string | null = null,
): Promise<void> {
  await ensureSchema();
  await db.execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            last_used_at = datetime('now'),
            last_checked_at = datetime('now'),
            last_error = CASE WHEN ? = 1 THEN last_error ELSE ? END
          WHERE id = ?`,
    args: [ok ? 1 : 0, ok ? 0 : 1, ok ? 1 : 0, error, id],
  });
}
