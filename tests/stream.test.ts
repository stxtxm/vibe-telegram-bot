import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  Bot: vi.fn(),
  InlineKeyboard: vi.fn().mockImplementation(function () {
    return {
      text: vi.fn().mockReturnThis(),
      row: vi.fn().mockReturnThis(),
    };
  }),
}));

import { ResponseStreamer, splitMessage, escapeHtml, escapeMarkdown } from "../src/bot/stream.js";
import { InlineKeyboard } from "grammy";

describe("ResponseStreamer", () => {
  let bot: any;
  let chatId: number;
  let streamer: ResponseStreamer;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    bot = {
      api: {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
        editMessageText: vi.fn().mockResolvedValue(undefined),
      },
    };
    chatId = 12345;
    streamer = new ResponseStreamer(bot, chatId);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should start and send initial message", async () => {
    const msgId = await streamer.start(1);
    expect(msgId).toBe(100);
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      chatId,
      "⏳ Thinking...",
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(streamer.isActive).toBe(true);
    expect(streamer.generation).toBe(1);
  });

  it("should start with reply to message", async () => {
    await streamer.start(1, 42);
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      chatId,
      "⏳ Thinking...",
      expect.objectContaining({ reply_to_message_id: 42 }),
    );
  });

  it("should handle send error gracefully", async () => {
    bot.api.sendMessage = vi.fn().mockRejectedValue(new Error("API error"));
    const msgId = await streamer.start(1);
    expect(msgId).toBe(0);
  });

  it("should accumulate response text", async () => {
    await streamer.start(1);
    streamer.appendResponse("Hello ");
    streamer.appendResponse("world");
    expect(streamer["state"]?.accumulatedText).toBe("Hello world");
  });

  it("should accumulate thinking text", async () => {
    await streamer.start(1);
    streamer.appendThinking("Step 1: ");
    streamer.appendThinking("Step 2: ");
    expect(streamer["state"]?.thinkingText).toBe("Step 1: Step 2: ");
    expect(streamer["state"]?.hasShownThinking).toBe(true);
  });

  it("should build combined text with thinking blockquote", async () => {
    await streamer.start(1);
    streamer.appendThinking("Reasoning...");
    streamer.appendResponse("Answer");
    const text = streamer["buildCombinedText"]();
    expect(text).toContain("<blockquote>");
    expect(text).toContain("Reasoning...");
    expect(text).toContain("Answer");
  });

  it("should build combined text without thinking", async () => {
    await streamer.start(1);
    streamer.appendResponse("Direct answer");
    const text = streamer["buildCombinedText"]();
    expect(text).not.toContain("<blockquote>");
    expect(text).toBe("Direct answer");
  });

  it("should escape HTML in thinking text", async () => {
    await streamer.start(1);
    streamer.appendThinking("<script>alert('xss')</script>");
    const text = streamer["buildCombinedText"]();
    expect(text).toContain("&lt;script&gt;");
    expect(text).not.toContain("<script>");
  });

  it("should set usage data", async () => {
    await streamer.start(1);
    streamer.setUsage({ inputTokens: 100, outputTokens: 50, cost: 0.01 });
    expect(streamer.usage).toEqual({ inputTokens: 100, outputTokens: 50, cost: 0.01 });
  });

  it("should generate different signatures for different text", async () => {
    await streamer.start(1);
    const sig1 = streamer["signature"]("hello");
    const sig2 = streamer["signature"]("world");
    expect(sig1).not.toBe(sig2);
  });

  it("should produce same signature for same text", async () => {
    await streamer.start(1);
    const sig1 = streamer["signature"]("hello world");
    const sig2 = streamer["signature"]("hello world");
    expect(sig1).toBe(sig2);
  });

  it("should not edit message if signature unchanged", async () => {
    await streamer.start(1);
    streamer["state"]!.lastSentSignature = streamer["signature"]("hello");
    streamer.appendResponse("hello");
    vi.advanceTimersByTime(1500);
    await Promise.resolve();
    expect(bot.api.editMessageText).not.toHaveBeenCalled();
  });

  it("should abort and cleanup", async () => {
    await streamer.start(1);
    streamer.appendResponse("Partial text");
    streamer.abort();
    expect(streamer.isActive).toBe(false);
    expect(streamer["state"]?.flushTimer).toBeNull();
  });

  it("should cancel with accumulated text", async () => {
    await streamer.start(1);
    streamer.appendResponse("Partial response");
    await streamer.cancelWithAccumulated();
    expect(streamer.isActive).toBe(false);
  });

  it("should ignore appends after abort", async () => {
    await streamer.start(1);
    streamer.abort();
    streamer.appendResponse("Should not be stored");
    expect(streamer["state"]?.accumulatedText).toBe("");
  });

  it("should send footer with cost", async () => {
    await streamer.start(1);
    streamer.setUsage({ inputTokens: 500, outputTokens: 100, cost: 0.05 });
    await streamer.finalize("", "5s");

    const footerCall = bot.api.sendMessage.mock.calls.find(
      (c: any[]) => c[0] === chatId && typeof c[1] === "string" && c[1].includes("💰")
    );
    expect(footerCall).toBeDefined();
    expect(footerCall[1]).toContain("$0.0500");
  });

  it("should send footer without cost", async () => {
    streamer.start(1);
    streamer.setUsage({ inputTokens: 500, outputTokens: 100, cost: 0 });
    await streamer.finalize("", "5s");

    const footerCall = bot.api.sendMessage.mock.calls.find(
      (c: any[]) => c[0] === chatId && typeof c[1] === "string" && c[1].includes("⏱️")
    );
    expect(footerCall).toBeDefined();
    expect(footerCall[1]).not.toContain("💰");
  });

  it("should handle message not found error", async () => {
    await streamer.start(1);
    streamer["state"]!.lastSentSignature = "old";
    bot.api.editMessageText = vi.fn().mockRejectedValue(new Error("message to edit not found"));

    streamer.appendResponse("New text");
    vi.advanceTimersByTime(1500);
    await Promise.resolve();
    await Promise.resolve();

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("should handle message not modified error", async () => {
    await streamer.start(1);
    streamer["state"]!.lastFlushTime = 0;
    bot.api.editMessageText = vi.fn().mockRejectedValue(new Error("message is not modified"));

    streamer.appendResponse("Same text");
    vi.advanceTimersByTime(1500);
    await Promise.resolve();

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
  });
});

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

describe("escapeHtml", () => {
  it("should escape &, <, >", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });
});

describe("escapeMarkdown", () => {
  it("should escape markdown special characters", () => {
    expect(escapeMarkdown("_*[]()~`>#+-=|{}.!")).toBe("\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!");
  });
});
