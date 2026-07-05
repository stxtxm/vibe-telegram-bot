import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config
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

vi.mock("grammy", () => {
  const mockKeyboard = vi.fn().mockImplementation(function () {
    return {
      text: vi.fn().mockReturnThis(),
      row: vi.fn().mockReturnThis(),
      resized: vi.fn().mockReturnThis(),
    };
  });
  return {
    Keyboard: mockKeyboard,
    InlineKeyboard: vi.fn().mockImplementation(function () {
      return {
        text: vi.fn().mockReturnThis(),
        row: vi.fn().mockReturnThis(),
      };
    }),
  };
});

import { KeyboardManager } from "../src/bot/keyboard.js";
import { Keyboard } from "grammy";

describe("KeyboardManager", () => {
  let bot: any;
  let chatId: number;

  beforeEach(() => {
    vi.clearAllMocks();
    bot = {
      api: {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
        deleteMessage: vi.fn().mockResolvedValue(undefined),
      },
    };
    chatId = 12345;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should initialize with default state", () => {
    const km = new KeyboardManager(bot, chatId);
    expect(km["state"]).toEqual({
      currentModel: "?",
      currentMode: "?",
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      sessionCwd: "?",
    });
  });

  it("should update model and mode", () => {
    const km = new KeyboardManager(bot, chatId);
    km.updateModel("mistral-large");
    km.updateMode("agent");
    expect(km["state"].currentModel).toBe("mistral-large");
    expect(km["state"].currentMode).toBe("agent");
  });

  it("should update usage", () => {
    const km = new KeyboardManager(bot, chatId);
    km.updateUsage(1500, 300, 0.025);
    expect(km["state"].inputTokens).toBe(1500);
    expect(km["state"].outputTokens).toBe(300);
    expect(km["state"].cost).toBe(0.025);
  });

  it("should update cwd", () => {
    const km = new KeyboardManager(bot, chatId);
    km.updateCwd("/home/user/project");
    expect(km["state"].sessionCwd).toBe("/home/user/project");
  });

  it("should format token count", () => {
    const km = new KeyboardManager(bot, chatId);
    expect(km["formatTokenCount"](500)).toBe("500");
    expect(km["formatTokenCount"](1500)).toBe("2K");
    expect(km["formatTokenCount"](1500000)).toBe("1.5M");
  });

  it("should truncate long paths", () => {
    const km = new KeyboardManager(bot, chatId);
    const longPath = "/home/user/very/long/path/to/project/src/components";
    const truncated = km["truncatePath"](longPath, 20);
    expect(truncated.length).toBeLessThanOrEqual(20);
    expect(truncated).toContain("…");
  });

  it("should build keyboard with state", () => {
    const km = new KeyboardManager(bot, chatId);
    km.updateModel("mistral-large");
    km.updateUsage(1500, 300, 0.025);
    km.updateCwd("/home/user/project");

    const kb = km.buildKeyboard();
    expect(kb).toBeDefined();
    // Verify Keyboard was constructed
    expect(Keyboard).toHaveBeenCalled();
  });

  it("should debounce refreshKeyboard calls", () => {
    const km = new KeyboardManager(bot, chatId);
    const spy = vi.spyOn(km as any, "sendKeyboardUpdate");

    km.refreshKeyboard();
    km.refreshKeyboard();
    km.refreshKeyboard();

    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("should flushKeyboard immediately", () => {
    const km = new KeyboardManager(bot, chatId);
    const spy = vi.spyOn(km as any, "sendKeyboardUpdate");

    km.refreshKeyboard();
    km.flushKeyboard();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("should send and delete message on update", async () => {
    const km = new KeyboardManager(bot, chatId);
    await km["sendKeyboardUpdate"]();

    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      chatId,
      "⌨️",
      expect.objectContaining({ disable_notification: true }),
    );
    expect(bot.api.deleteMessage).toHaveBeenCalledWith(chatId, 42);
  });

  it("should handle send error gracefully", async () => {
    bot.api.sendMessage = vi.fn().mockRejectedValue(new Error("API error"));
    const km = new KeyboardManager(bot, chatId);
    await expect(km["sendKeyboardUpdate"]()).resolves.toBeUndefined();
  });

  it("should use zero cost label when cost is 0", () => {
    const km = new KeyboardManager(bot, chatId);
    const kb = km.buildKeyboard();
    expect(kb).toBeDefined();
  });
});
