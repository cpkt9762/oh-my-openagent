import { Database } from "bun:sqlite"
import { join } from "node:path"
import { mkdirSync, existsSync } from "node:fs"
import { getDataDir } from "../../shared/data-path"
import { log } from "../../shared"
import type { BackgroundTask, BackgroundTaskStatus } from "./types"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  parent_id TEXT NOT NULL,
  description TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL,
  category TEXT,
  model_provider TEXT,
  model_id TEXT,
  model_variant TEXT,
  error TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_task_parent ON task(parent_id);
CREATE INDEX IF NOT EXISTS idx_task_status ON task(status);
`

const TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface TaskRow {
  id: string
  session_id: string | null
  parent_id: string
  description: string
  agent: string
  status: string
  category: string | null
  model_provider: string | null
  model_id: string | null
  model_variant: string | null
  error: string | null
  started_at: number | null
  completed_at: number | null
  created_at: number
}

function dbPath(): string {
  const dir = join(getDataDir(), "opencode", "omo")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, "background-tasks.db")
}

function toTask(row: TaskRow): BackgroundTask {
  const status: BackgroundTaskStatus =
    row.status === "running" || row.status === "pending" ? "interrupt" : (row.status as BackgroundTaskStatus)
  return {
    id: row.id,
    sessionID: row.session_id ?? undefined,
    parentSessionID: row.parent_id,
    parentMessageID: "",
    description: row.description,
    prompt: "",
    agent: row.agent,
    status,
    category: row.category ?? undefined,
    model:
      row.model_provider && row.model_id
        ? { providerID: row.model_provider, modelID: row.model_id, variant: row.model_variant ?? undefined }
        : undefined,
    error: row.error ?? undefined,
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at) : status === "interrupt" ? new Date() : undefined,
  }
}

export class TaskStore {
  private db: InstanceType<typeof Database>

  constructor(path?: string) {
    const p = path ?? dbPath()
    this.db = new Database(p, { create: true })
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run("PRAGMA busy_timeout = 3000")
    this.db.exec(SCHEMA)
  }

  upsert(task: BackgroundTask): void {
    try {
      this.db
        .prepare(
          `
        INSERT INTO task (id, session_id, parent_id, description, agent, status,
          category, model_provider, model_id, model_variant, error, started_at, completed_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        ON CONFLICT(id) DO UPDATE SET
          session_id = ?2, status = ?6, error = ?11,
          started_at = ?12, completed_at = ?13
      `,
        )
        .run(
          task.id,
          task.sessionID ?? null,
          task.parentSessionID,
          task.description,
          task.agent,
          task.status,
          task.category ?? null,
          task.model?.providerID ?? null,
          task.model?.modelID ?? null,
          task.model?.variant ?? null,
          task.error ?? null,
          task.startedAt?.getTime() ?? null,
          task.completedAt?.getTime() ?? null,
        )
    } catch (err) {
      log("[task-store] upsert failed:", String(err))
    }
  }

  load(id: string): BackgroundTask | undefined {
    const row = this.db.prepare("SELECT * FROM task WHERE id = ?").get(id) as TaskRow | null
    if (!row) return undefined
    return toTask(row)
  }

  loadAll(): BackgroundTask[] {
    const rows = this.db.prepare("SELECT * FROM task").all() as TaskRow[]
    return rows.map(toTask)
  }

  prune(ttl = TASK_TTL_MS): number {
    const cutoff = Date.now() - ttl
    const result = this.db
      .prepare("DELETE FROM task WHERE created_at < ? AND status NOT IN ('running', 'pending')")
      .run(cutoff)
    return result.changes
  }

  close(): void {
    try {
      this.db.close()
    } catch {}
  }
}
