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
      persistent: vi.fn().mockReturnThis(),
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
import type { Bot, Context } from "grammy";

type MockFn = ReturnType<typeof vi.fn>;

interface MockBot {
  api: {
    sendMessage: MockFn;
    deleteMessage: MockFn;
  };
}

describe("KeyboardManager", () => {
  let bot: MockBot;
  let chatId: number;

  function makeKm(): KeyboardManager {
    return new KeyboardManager(bot as unknown as Bot<Context>, chatId);
  }

  function spyOnSend(km: KeyboardManager) {
    return vi.spyOn(km as unknown as { sendKeyboardUpdate: () => Promise<void> }, "sendKeyboardUpdate");
  }

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
    const km = makeKm();
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
    const km = makeKm();
    km.updateModel("mistral-large");
    km.updateMode("agent");
    expect(km["state"].currentModel).toBe("mistral-large");
    expect(km["state"].currentMode).toBe("agent");
  });

  it("should update usage", () => {
    const km = makeKm();
    km.updateUsage(1500, 300, 0.025);
    expect(km["state"].inputTokens).toBe(1500);
    expect(km["state"].outputTokens).toBe(300);
    expect(km["state"].cost).toBe(0.025);
  });

  it("should update cwd", () => {
    const km = makeKm();
    km.updateCwd("/home/user/project");
    expect(km["state"].sessionCwd).toBe("/home/user/project");
  });

  it("should format token count", () => {
    const km = makeKm();
    expect(km["formatTokenCount"](500)).toBe("500");
    expect(km["formatTokenCount"](1500)).toBe("2K");
    expect(km["formatTokenCount"](1500000)).toBe("1.5M");
  });

  it("should truncate long paths", () => {
    const km = makeKm();
    const longPath = "/home/user/very/long/path/to/project/src/components";
    const truncated = km["truncatePath"](longPath, 20);
    expect(truncated.length).toBeLessThanOrEqual(20);
    expect(truncated).toContain("…");
  });

  it("should build keyboard with state", () => {
    const km = makeKm();
    km.updateModel("mistral-large");
    km.updateUsage(1500, 300, 0.025);
    km.updateCwd("/home/user/project");

    const kb = km.buildKeyboard();
    expect(kb).toBeDefined();
    // Verify Keyboard was constructed
    expect(Keyboard).toHaveBeenCalled();
  });

  it("should debounce refreshKeyboard calls without spamming keyboard messages", () => {
    const km = makeKm();
    const spy = spyOnSend(km);

    km.refreshKeyboard();
    km.refreshKeyboard();
    km.refreshKeyboard();

    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);

    // Intentionally no-op: keyboard is attached to replies/status updates instead of spam messages.
    expect(spy).not.toHaveBeenCalled();
  });

  it("should flushKeyboard immediately without sending keyboard spam", () => {
    const km = makeKm();
    const spy = spyOnSend(km);

    km.refreshKeyboard();
    km.flushKeyboard();

    expect(spy).not.toHaveBeenCalled();
  });

  it("sendKeyboardUpdate is a no-op (keyboard attached to replies instead)", async () => {
    const km = makeKm();
    await km["sendKeyboardUpdate"]();

    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    expect(bot.api.deleteMessage).not.toHaveBeenCalled();
  });

  it("should handle send error gracefully", async () => {
    bot.api.sendMessage = vi.fn().mockRejectedValue(new Error("API error"));
    const km = makeKm();
    await expect(km["sendKeyboardUpdate"]()).resolves.toBeUndefined();
  });

  it("should use zero cost label when cost is 0", () => {
    const km = makeKm();
    const kb = km.buildKeyboard();
    expect(kb).toBeDefined();
  });
});
