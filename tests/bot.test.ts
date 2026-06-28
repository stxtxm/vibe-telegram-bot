import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies BEFORE importing from bot/index
vi.mock("../src/config.js", () => ({
  config: {
    telegram: { token: "mock-token", allowedUserId: 12345 },
    vibe: { projectDir: "/project" },
    server: { logLevel: "info" },
  },
}));

vi.mock("../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("grammy", () => ({
  Bot: vi.fn(() => ({
    api: { setMyCommands: vi.fn(), sendMessage: vi.fn(), editMessageText: vi.fn() },
    use: vi.fn(),
    command: vi.fn(),
    on: vi.fn(),
    catch: vi.fn(),
  })),
  InlineKeyboard: vi.fn(() => ({
    text: vi.fn().mockReturnThis(),
    row: vi.fn().mockReturnThis(),
  })),
}));

// Now import the testable functions
import { splitMessage, extractTodos } from "../src/bot/index.js";

describe("splitMessage", () => {
  it("should return single chunk for short messages", () => {
    expect(splitMessage("Hello world", 4096)).toEqual(["Hello world"]);
  });

  it("should split messages over max length", () => {
    const long = "a".repeat(5000);
    const result = splitMessage(long, 2000);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("a".repeat(2000));
    expect(result[1]).toBe("a".repeat(2000));
    expect(result[2]).toBe("a".repeat(1000));
  });

  it("should use default max of 4096", () => {
    const long = "a".repeat(10000);
    const result = splitMessage(long);
    expect(result).toHaveLength(3);
    expect(result[0].length).toBe(4096);
    expect(result[1].length).toBe(4096);
    expect(result[2].length).toBe(1808);
  });

  it("should handle exact max length", () => {
    const text = "a".repeat(4096);
    expect(splitMessage(text)).toHaveLength(1);
  });

  it("should break at newline when possible", () => {
    const a = "x".repeat(3000);
    const b = "y".repeat(3000);
    const text = a + "\n" + b;
    const result = splitMessage(text, 4000);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(a + "\n");
    expect(result[1]).toBe(b);
  });
});

describe("extractTodos", () => {
  it("should extract markdown checklist items", () => {
    expect(extractTodos("- [ ] Fix bug\n- [ ] Add tests")).toEqual(["Fix bug", "Add tests"]);
  });

  it("should extract TODO: prefixed items", () => {
    expect(extractTodos("TODO: Impl feature\nTODO: Write docs")).toEqual(["Impl feature", "Write docs"]);
  });

  it("should extract mixed formats", () => {
    expect(extractTodos("- [ ] Task one\nTODO: Task two\n* [ ] Task three")).toEqual(["Task one", "Task two", "Task three"]);
  });

  it("should extract **TODO:** items", () => {
    expect(extractTodos("- **TODO:** Important")).toEqual(["Important"]);
  });

  it("should not extract completed items", () => {
    expect(extractTodos("- [x] Done\n- [ ] Pending")).toEqual(["Pending"]);
  });

  it("should return empty array when no todos", () => {
    expect(extractTodos("Just text")).toEqual([]);
    expect(extractTodos("")).toEqual([]);
  });
});
