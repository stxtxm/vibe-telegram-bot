import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock fs to use in-memory storage for isolation
const memStore = new Map<string, string>();
vi.mock("node:fs", () => ({
  promises: {
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async (path: string) => {
      const data = memStore.get(path.toString());
      if (!data) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return data;
    }),
    writeFile: vi.fn(async (path: string, data: string) => {
      memStore.set(path.toString(), data);
    }),
  },
  existsSync: vi.fn(() => true),
}));

import { TodoManager } from "../src/todo.js";

describe("TodoManager", () => {
  beforeEach(() => {
    memStore.clear();
  });

  it("should start empty", async () => {
    const tm = new TodoManager();
    await tm.load();
    expect(tm.list()).toHaveLength(0);
    expect(tm.format()).toContain("Aucune tâche");
  });

  it("should add items", async () => {
    const tm = new TodoManager();
    await tm.load();
    const item = await tm.add("Fix the bug");
    expect(item.id).toBe(1);
    expect(item.text).toBe("Fix the bug");
    expect(item.done).toBe(false);
    expect(tm.list()).toHaveLength(1);
  });

  it("should auto-increment ids", async () => {
    const tm = new TodoManager();
    await tm.load();
    const a = await tm.add("First");
    const b = await tm.add("Second");
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
  });

  it("should toggle done status", async () => {
    const tm = new TodoManager();
    await tm.load();
    await tm.add("Task");
    expect(await tm.toggle(1)).toBe(true);
    expect(tm.list()[0].done).toBe(true);
    expect(await tm.toggle(1)).toBe(true);
    expect(tm.list()[0].done).toBe(false);
  });

  it("should return false on toggling non-existent id", async () => {
    const tm = new TodoManager();
    await tm.load();
    expect(await tm.toggle(99)).toBe(false);
  });

  it("should remove item", async () => {
    const tm = new TodoManager();
    await tm.load();
    await tm.add("Task");
    expect(await tm.remove(1)).toBe(true);
    expect(tm.list()).toHaveLength(0);
  });

  it("should return false on removing non-existent id", async () => {
    const tm = new TodoManager();
    await tm.load();
    expect(await tm.remove(99)).toBe(false);
  });

  it("should clear done items", async () => {
    const tm = new TodoManager();
    await tm.load();
    await tm.add("Task 1");
    await tm.add("Task 2");
    await tm.toggle(1);
    await tm.clearDone();
    expect(tm.list()).toHaveLength(1);
    expect(tm.list()[0].text).toBe("Task 2");
  });

  it("should format output with pending and done sections", async () => {
    const tm = new TodoManager();
    await tm.load();
    await tm.add("First");
    await tm.add("Second");
    await tm.toggle(1);
    const formatted = tm.format();
    expect(formatted).toContain("✅");
    expect(formatted).toContain("À faire");
    expect(formatted).toContain("Terminé");
  });

  it("should persist data to disk and reload", async () => {
    const tm1 = new TodoManager();
    await tm1.load();
    await tm1.add("Persistent task");
    await tm1.add("Another");

    const tm2 = new TodoManager();
    await tm2.load();
    expect(tm2.list()).toHaveLength(2);
    expect(tm2.list()[0].text).toBe("Persistent task");
  });
});
