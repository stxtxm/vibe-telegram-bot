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
      "⏳...",
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(streamer.isActive).toBe(true);
    expect(streamer.generation).toBe(1);
  });

  it("should start with reply to message", async () => {
    await streamer.start(1, 42);
    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      chatId,
      "⏳...",
      expect.objectContaining({ reply_to_message_id: 42 }),
    );
  });

  it("should handle send error gracefully", async () => {
    bot.api.sendMessage = vi.fn().mockRejectedValue(new Error("API error"));
    const msgId = await streamer.start(1);
    expect(msgId).toBe(0);
  });

  it("should accumulate response text without sending", async () => {
    await streamer.start(1);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    streamer.appendResponse("Hello ");
    streamer.appendResponse("world");
    expect(streamer["state"]?.accumulatedText).toBe("Hello world");
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("should accumulate thinking text", async () => {
    await streamer.start(1);
    streamer.appendThinking("Step 1: ");
    streamer.appendThinking("Step 2: ");
    expect(streamer["state"]?.thinkingText).toBe("Step 1: Step 2: ");
    expect(streamer["state"]?.hasShownThinking).toBe(true);
  });

  it("should send thinking as 💭 messages on timer", async () => {
    await streamer.start(1);
    streamer.appendThinking("Step 1 ");
    streamer.appendThinking("Step 2 ");
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    const call = bot.api.sendMessage.mock.calls[1];
    expect(call[0]).toBe(chatId);
    expect(call[1]).toBe("💭 Step 1 Step 2 ");
    expect(call[2]?.parse_mode).toBe("HTML");
  });

  it("should update progress to 💭 thinking indicator", async () => {
    await streamer.start(1);
    streamer.appendThinking("thinking...");
    await vi.advanceTimersByTimeAsync(600);
    expect(bot.api.editMessageText).toHaveBeenCalledWith(
      chatId, 100, "💭...", expect.anything(),
    );
  });

  it("should send tool entry immediately", async () => {
    await streamer.start(1);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    streamer.addToolEntry("📖", "read src/index.ts");
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    const call = bot.api.sendMessage.mock.calls[1];
    expect(call[0]).toBe(chatId);
    expect(call[1]).toBe("📖 read src/index.ts");
  });

  it("should accumulate multiple tool entries", async () => {
    await streamer.start(1);
    streamer.addToolEntry("📖", "read a.ts");
    streamer.addToolEntry("💻", "ls -la");
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(3);
    expect(streamer["state"]?.toolEntries).toHaveLength(2);
  });

  it("should send response text at finalize only", async () => {
    await streamer.start(1);
    streamer.appendResponse("Full response content. ");
    streamer.appendResponse("Sent at the end only.");
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    await streamer.finalize("", "5s");
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(3);
    const resp = bot.api.sendMessage.mock.calls[1];
    expect(resp[0]).toBe(chatId);
    expect(resp[1]).toBe("Full response content. Sent at the end only.");
    expect(resp[2]?.parse_mode).toBe("HTML");
  });

  it("should escape HTML in response at finalize", async () => {
    await streamer.start(1);
    streamer.appendResponse("<script>alert('xss')</script>");
    await streamer.finalize("", "5s");
    const resp = bot.api.sendMessage.mock.calls[1];
    expect(resp[1]).toBe("&lt;script&gt;alert('xss')&lt;/script&gt;");
    expect(resp[2]?.parse_mode).toBe("HTML");
  });

  it("should send thinking first then response at finalize", async () => {
    await streamer.start(1);
    streamer.appendThinking("Step 1: thinking...");
    streamer.appendResponse("Final answer here.");
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    await streamer.finalize("", "5s");
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(4);
    const think = bot.api.sendMessage.mock.calls[1];
    expect(think[1]).toContain("💭");
    const resp = bot.api.sendMessage.mock.calls[2];
    expect(resp[1]).toBe("Final answer here.");
  });

  it("should set usage data", async () => {
    await streamer.start(1);
    streamer.setUsage({ inputTokens: 100, outputTokens: 50, cost: 0.01 });
    expect(streamer.usage).toEqual({ inputTokens: 100, outputTokens: 50, cost: 0.01 });
  });

  it("should abort and cleanup", async () => {
    await streamer.start(1);
    streamer.appendResponse("Partial text");
    streamer.abort();
    expect(streamer.isActive).toBe(false);
    expect(streamer["state"]?.thinkingFlushTimer).toBeNull();
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
      (c: any[]) => c[0] === chatId && typeof c[1] === "string" && (c[1].includes("⏱") || c[1].includes("⏱️"))
    );
    expect(footerCall).toBeDefined();
    expect(footerCall[1]).not.toContain("💰");
  });

  it("should not send anything on flushNow when no thinking", async () => {
    await streamer.start(1);
    await streamer.flushNow();
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("should flush pending thinking on flushNow", async () => {
    await streamer.start(1);
    streamer.appendThinking("Pending thought");
    await streamer.flushNow();
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    const call = bot.api.sendMessage.mock.calls[1];
    expect(call[1]).toBe("💭 Pending thought");
  });

  it("should send nothing after finalize when no response", async () => {
    await streamer.start(1);
    await streamer.finalize("", "5s");
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("should split long response into multiple messages at finalize", async () => {
    await streamer.start(1);
    const longText = "a".repeat(5000);
    streamer.appendResponse(longText);
    await streamer.finalize("", "5s");
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(4);
    const chunk1 = bot.api.sendMessage.mock.calls[1][1];
    const chunk2 = bot.api.sendMessage.mock.calls[2][1];
    expect(chunk1 + chunk2).toBe(longText);
  });

  it("should edit progress to ✅ Done on finalize", async () => {
    await streamer.start(1);
    await streamer.finalize("", "5s");
    expect(bot.api.editMessageText).toHaveBeenCalledWith(chatId, 100, "✅ Done");
  });

  it("should edit progress to ⏹️ on abort", async () => {
    await streamer.start(1);
    streamer.abort();
    expect(bot.api.editMessageText).toHaveBeenCalledWith(chatId, 100, "⏹️ Annulé");
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
