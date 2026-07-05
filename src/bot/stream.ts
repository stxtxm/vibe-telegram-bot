import { type Bot, type Context, InlineKeyboard } from "grammy";
import { logger } from "../utils/logger.js";

const THROTTLE_MS = 1_000;
const TEXT_LIMIT = 3_800;

interface UsageData {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

interface StreamState {
  chatId: number;
  generation: number;
  streamMessageId: number | null;
  accumulatedText: string;
  thinkingText: string;
  hasShownThinking: boolean;
  lastSentSignature: string | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  lastFlushTime: number;
  usage: UsageData | null;
  isActive: boolean;
}

export class ResponseStreamer {
  private bot: Bot<Context>;
  private chatId: number;
  private state: StreamState | null = null;

  constructor(bot: Bot<Context>, chatId: number) {
    this.bot = bot;
    this.chatId = chatId;
  }

  start(generation: number, replyToMessageId?: number): Promise<number> {
    this.state = {
      chatId: this.chatId,
      generation,
      streamMessageId: null,
      accumulatedText: "",
      thinkingText: "",
      hasShownThinking: false,
      lastSentSignature: null,
      flushTimer: null,
      lastFlushTime: 0,
      usage: null,
      isActive: true,
    };

    const abortKb = new InlineKeyboard().text("Abort", `abort:${generation}`);
    const extra: Record<string, unknown> = { reply_markup: abortKb };
    if (replyToMessageId) {
      extra.reply_to_message_id = replyToMessageId;
    }

    return this.sendInitialMessage(extra);
  }

  private async sendInitialMessage(extra: Record<string, unknown>): Promise<number> {
    try {
      const msg = await this.bot.api.sendMessage(this.chatId, "⏳ Thinking...", extra as never);
      if (this.state) this.state.streamMessageId = msg.message_id;
      return msg.message_id;
    } catch (err) {
      logger.warn("[Stream] Failed to send initial message:", err);
      return 0;
    }
  }

  get streamMessageId(): number | null {
    return this.state?.streamMessageId ?? null;
  }

  get isActive(): boolean {
    return this.state?.isActive ?? false;
  }

  get generation(): number {
    return this.state?.generation ?? 0;
  }

  get usage(): UsageData | null {
    return this.state?.usage ?? null;
  }

  appendResponse(text: string): void {
    if (!this.state?.isActive) { logger.debug("[Stream] appendResponse skipped: inactive"); return; }
    this.state.accumulatedText += text;
    logger.debug(`[Stream] appendResponse: +${text.length} chars, total=${this.state.accumulatedText.length}`);
    this.scheduleFlush(false);
  }

  appendThinking(text: string): void {
    if (!this.state?.isActive) return;
    this.state.thinkingText += text;
    this.state.hasShownThinking = true;
    this.scheduleFlush(false);
  }

  setUsage(usage: UsageData): void {
    if (!this.state?.isActive) return;
    this.state.usage = usage;
  }

  private scheduleFlush(isFinal: boolean): void {
    if (!this.state) return;
    if (this.state.flushTimer) {
      clearTimeout(this.state.flushTimer);
      this.state.flushTimer = null;
    }
    if (isFinal) {
      this.flushState(true).catch(() => {});
    } else {
      this.state.flushTimer = setTimeout(() => {
        if (this.state?.isActive) {
          this.flushState(false).catch(() => {});
        }
      }, THROTTLE_MS);
    }
  }

  flushNow(): Promise<void> {
    if (!this.state) return Promise.resolve();
    if (this.state.flushTimer) {
      clearTimeout(this.state.flushTimer);
      this.state.flushTimer = null;
    }
    return this.flushState(false);
  }

  private async flushState(isFinal: boolean): Promise<void> {
    const s = this.state;
    if (!s || !s.isActive) { logger.debug("[Stream] flushState: inactive"); return; }

    const text = this.buildCombinedText();
    if (!text && !isFinal) {
      logger.debug("[Stream] flushState: no text, not final");
      return;
    }

    // Truncate for editMessageText (Telegram 4096 limit)
    const displayText = text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) + "…" : text;

    const sig = this.signature(displayText);
    if (!isFinal && sig === s.lastSentSignature) return;

    const now = Date.now();
    if (!isFinal && now - s.lastFlushTime < THROTTLE_MS) {
      this.scheduleFlush(false);
      return;
    }
    s.lastFlushTime = now;

    const chatId = s.chatId;
    const msgId = s.streamMessageId;

    if (msgId !== null) {
      try {
        await this.bot.api.editMessageText(chatId, msgId, displayText || "⏳ Thinking...", { parse_mode: "HTML" } as never);
        s.lastSentSignature = sig;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("message is not modified")) {
          return;
        }
        if (msg.includes("message to edit not found") || msg.includes("message not found")) {
          s.streamMessageId = null;
          await this.sendFreshMessage(displayText, s);
          return;
        }
        logger.warn("[Stream] editMessageText error:", msg);
      }
    } else {
      await this.sendFreshMessage(displayText, s);
    }
  }

  private async sendFreshMessage(text: string, s: StreamState): Promise<void> {
    // Also cap fresh messages to TEXT_LIMIT
    const displayText = text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) + "…" : text;
    try {
      const msg = await this.bot.api.sendMessage(s.chatId, displayText || "⏳ Thinking...", { parse_mode: "HTML" } as never);
      s.streamMessageId = msg.message_id;
      s.lastSentSignature = this.signature(displayText);
    } catch (err) {
      try {
        const msg = await this.bot.api.sendMessage(s.chatId, displayText || "⏳ Thinking...");
        s.streamMessageId = msg.message_id;
        s.lastSentSignature = this.signature(displayText);
      } catch (e2) {
        logger.warn("[Stream] Failed to send fresh message:", e2);
      }
    }
  }

  private buildCombinedText(): string {
    if (!this.state) return "";
    const { hasShownThinking, thinkingText, accumulatedText } = this.state;
    let text = "";
    if (hasShownThinking && thinkingText) {
      const escaped = this.escapeHtml(thinkingText);
      text += `<blockquote>${escaped}</blockquote>\n\n`;
    }
    if (accumulatedText) {
      text += this.escapeHtml(accumulatedText);
    }
    return text;
  }

  private signature(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async finalize(toolSummary: string, duration: string): Promise<void> {
    const s = this.state;
    if (!s) { logger.debug("[Stream] finalize: no state"); return; }
    logger.debug(`[Stream] finalize: acc=${s.accumulatedText.length} chars, thinking=${s.thinkingText.length}, msgId=${s.streamMessageId}`);

    this.cancelTimer();
    await this.flushState(true);

    // If response was truncated, send the full text as a separate message
    const rawLen = (s.accumulatedText || "").length;
    if (rawLen > TEXT_LIMIT) {
      logger.debug("[Stream] sending full response as separate messages");
      this.sendFullResponse(s).catch(() => {});
    }

    // Append footer to the stream message (keep the response text visible)
    await this.appendFooter(toolSummary, duration);

    this.cleanup();
  }

  private async sendFullResponse(s: StreamState): Promise<void> {
    const chunks = splitMessage(s.accumulatedText, TEXT_LIMIT);
    for (const chunk of chunks) {
      const escaped = this.escapeHtml(chunk);
      try {
        await this.bot.api.sendMessage(s.chatId, escaped, { parse_mode: "HTML" } as never);
      } catch {
        try { await this.bot.api.sendMessage(s.chatId, chunk); } catch { /* ignore */ }
      }
    }
  }

  private async appendFooter(toolSummary: string, duration: string): Promise<void> {
    const s = this.state;
    if (!s) return;

    let footer = "";
    if (s.usage) {
      footer = `⏱️ ${duration}  🤖 ${s.usage.inputTokens}→${s.usage.outputTokens} tok`;
      if (s.usage.cost > 0) {
        footer += `  💰 $${s.usage.cost.toFixed(4)}`;
      }
    } else {
      footer = `⏱️ ${duration}`;
    }
    if (toolSummary) {
      footer = `⚙️ ${toolSummary}\n` + footer;
    }

    if (s.streamMessageId) {
      const existing = this.buildCombinedText();
      if (existing) {
        const sep = `\n\n━━━━━━━━━━━━━━━━━━\n`;
        const updated = existing + sep + footer;
        // Only edit if it fits within limit
        if (updated.length <= TEXT_LIMIT) {
          try {
            await this.bot.api.editMessageText(s.chatId, s.streamMessageId, updated, { parse_mode: "HTML" } as never);
            s.streamMessageId = null;
            return;
          } catch {
            // Fall through to send separate footer message
          }
        }
      }
    }

    // Fallback: send footer as a new message
    try {
      const fallbackText = `✅ **Done**\n${footer}`;
      await this.bot.api.sendMessage(s.chatId, fallbackText, { parse_mode: "Markdown" } as never);
    } catch {
      try { await this.bot.api.sendMessage(s.chatId, footer); } catch { /* ignore */ }
    }
  }

  cancelWithAccumulated(): Promise<void> {
    return this.finalize("", "");
  }

  abort(): void {
    const s = this.state;
    if (!s) return;
    this.cancelTimer();
    this.cleanup();
  }

  private cancelTimer(): void {
    if (this.state?.flushTimer) {
      clearTimeout(this.state.flushTimer);
      this.state.flushTimer = null;
    }
  }

  private cleanup(): void {
    if (this.state) {
      this.state.isActive = false;
      this.state.streamMessageId = null;
    }
  }
}

export function splitMessage(text: string, max = 4096): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    if (start + max >= text.length) {
      out.push(text.slice(start));
      break;
    }
    const end = start + max;
    const nl = text.lastIndexOf("\n", end);
    if (nl > start) {
      out.push(text.slice(start, nl + 1));
      start = nl + 1;
    } else {
      out.push(text.slice(start, end));
      start = end;
    }
  }
  return out;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}
