/// <reference types="bun-types" />

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskStore } from "./task-store"
import type { BackgroundTask } from "./types"

function task(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: `bg_${Math.random().toString(36).slice(2, 10)}`,
    parentSessionID: "ses_parent",
    parentMessageID: "msg_1",
    description: "test task",
    prompt: "do stuff",
    agent: "explore",
    status: "completed",
    ...overrides,
  }
}

let dir: string
let store: TaskStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omo-store-"))
  store = new TaskStore(join(dir, "test.db"))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("TaskStore", () => {
  describe("#given a completed task", () => {
    describe("#when upsert then load", () => {
      test("#then fields round-trip correctly", () => {
        const t = task({
          id: "bg_abc",
          sessionID: "ses_child",
          status: "completed",
          startedAt: new Date("2026-01-01T00:00:00Z"),
          completedAt: new Date("2026-01-02T00:00:00Z"),
          category: "quick",
          model: { providerID: "anthropic", modelID: "claude-opus-4-6", variant: "max" },
        })
        store.upsert(t)

        const restored = store.load("bg_abc")
        expect(restored).toBeDefined()
        expect(restored!.sessionID).toBe("ses_child")
        expect(restored!.status).toBe("completed")
        expect(restored!.description).toBe("test task")
        expect(restored!.agent).toBe("explore")
        expect(restored!.category).toBe("quick")
        expect(restored!.model?.providerID).toBe("anthropic")
        expect(restored!.model?.variant).toBe("max")
      })
    })
  })

  describe("#given a running task in DB", () => {
    describe("#when loadAll", () => {
      test("#then status becomes interrupt", () => {
        const t = task({ id: "bg_run", sessionID: "ses_1", status: "running", startedAt: new Date() })
        store.upsert(t)

        const fresh = new TaskStore(join(dir, "test.db"))
        const all = fresh.loadAll()
        fresh.close()

        expect(all.length).toBe(1)
        expect(all[0].status).toBe("interrupt")
        expect(all[0].completedAt).toBeDefined()
      })
    })
  })

  describe("#given a pending task in DB", () => {
    describe("#when loadAll", () => {
      test("#then status becomes interrupt", () => {
        store.upsert(task({ id: "bg_pend", status: "pending" }))

        const fresh = new TaskStore(join(dir, "test.db"))
        const loaded = fresh.load("bg_pend")
        fresh.close()

        expect(loaded!.status).toBe("interrupt")
      })
    })
  })

  describe("#given an existing task", () => {
    describe("#when upsert with new status", () => {
      test("#then status updates", () => {
        const t = task({ id: "bg_upd", sessionID: "ses_1", status: "running" })
        store.upsert(t)

        t.status = "completed"
        t.completedAt = new Date()
        store.upsert(t)

        const loaded = store.load("bg_upd")
        expect(loaded!.status).toBe("completed")
        expect(loaded!.completedAt).toBeDefined()
      })
    })
  })

  describe("#given old completed tasks", () => {
    describe("#when prune with short TTL", () => {
      test("#then old tasks removed", () => {
        const t = task({ id: "bg_old", sessionID: "ses_1", status: "completed" })
        store.upsert(t)

        const pruned = store.prune(0)
        expect(pruned).toBe(1)
        expect(store.load("bg_old")).toBeUndefined()
      })
    })
  })

  describe("#given nonexistent task", () => {
    describe("#when load", () => {
      test("#then returns undefined", () => {
        expect(store.load("bg_nope")).toBeUndefined()
      })
    })
  })

  describe("#given empty DB", () => {
    describe("#when loadAll", () => {
      test("#then returns empty array", () => {
        expect(store.loadAll()).toEqual([])
      })
    })
  })

  describe("#given task with error", () => {
    describe("#when upsert then load", () => {
      test("#then error preserved", () => {
        const t = task({ id: "bg_err", sessionID: "ses_1", status: "error", error: "model timeout" })
        store.upsert(t)

        const loaded = store.load("bg_err")
        expect(loaded!.status).toBe("error")
        expect(loaded!.error).toBe("model timeout")
      })
    })
  })

  describe("#given task without model", () => {
    describe("#when upsert then load", () => {
      test("#then model is undefined", () => {
        store.upsert(task({ id: "bg_nomodel", sessionID: "ses_1" }))
        const loaded = store.load("bg_nomodel")
        expect(loaded!.model).toBeUndefined()
      })
    })
  })

  describe("#given multiple tasks", () => {
    describe("#when loadAll", () => {
      test("#then all returned", () => {
        store.upsert(task({ id: "bg_1", sessionID: "ses_1", status: "completed" }))
        store.upsert(task({ id: "bg_2", sessionID: "ses_2", status: "error" }))
        store.upsert(task({ id: "bg_3", sessionID: "ses_3", status: "running" }))

        const all = store.loadAll()
        expect(all.length).toBe(3)
        expect(all.find((t) => t.id === "bg_3")!.status).toBe("interrupt")
      })
    })
  })
})
