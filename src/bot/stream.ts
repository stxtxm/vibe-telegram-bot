import { type Bot, type Context, InlineKeyboard } from "grammy";
import { logger } from "../utils/logger.js";

const TEXT_LIMIT = 3_800;
const THINKING_FLUSH_MS = 600;
const RESPONSE_FLUSH_MS = 1200;
const RESPONSE_EDIT_LIMIT = 3800;

interface UsageData {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

interface ToolEntry {
  icon: string;
  label: string;
}

interface StreamState {
  chatId: number;
  generation: number;
  progressMessageId: number | null;
  responseMessageId: number | null;
  toolMessageIds: number[];
  thinkingText: string;
  thinkingLastSentLength: number;
  accumulatedText: string;
  toolEntries: ToolEntry[];
  hasShownThinking: boolean;
  thinkingFlushTimer: ReturnType<typeof setTimeout> | null;
  responseFlushTimer: ReturnType<typeof setTimeout> | null;
  lastSentLength: number;
  usage: UsageData | null;
  isActive: boolean;
}

export class ResponseStreamer {
  private bot: Bot<Context>;
  private chatId: number;
  private state: StreamState | null = null;
  private taskQ: Promise<void> = Promise.resolve();
  contextChars = 0;

  constructor(bot: Bot<Context>, chatId: number) {
    this.bot = bot;
    this.chatId = chatId;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.taskQ.then(fn, fn);
    this.taskQ = p.then(() => {}, () => {});
    return p;
  }

  start(generation: number, replyToMessageId?: number): Promise<number> {
    this.state = {
      chatId: this.chatId,
      generation,
      progressMessageId: null,
      responseMessageId: null,
      toolMessageIds: [],
      thinkingText: "",
      thinkingLastSentLength: 0,
      accumulatedText: "",
      toolEntries: [],
      hasShownThinking: false,
      thinkingFlushTimer: null,
      responseFlushTimer: null,
      lastSentLength: 0,
      usage: null,
      isActive: true,
    };
    const abortKb = new InlineKeyboard().text("Abort", `abort:${generation}`);
    const extra: Record<string, unknown> = { reply_markup: abortKb };
    if (replyToMessageId) {
      extra.reply_to_message_id = replyToMessageId;
    }
    return this.sendProgressMessage(extra);
  }

  private async sendProgressMessage(extra: Record<string, unknown>): Promise<number> {
    try {
      const msg = await this.bot.api.sendMessage(this.chatId, "⏳...", extra as never);
      if (this.state) this.state.progressMessageId = msg.message_id;
      return msg.message_id;
    } catch (err) {
      logger.warn("[Stream] Failed to send progress message:", err);
      return 0;
    }
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

  get progressMessageId(): number | null {
    return this.state?.progressMessageId ?? null;
  }

  appendResponse(text: string): void {
    if (!this.state?.isActive) return;
    this.state.accumulatedText += text;
    this.scheduleResponseFlush();
  }

  appendThinking(text: string): void {
    if (!this.state?.isActive) return;
    this.state.thinkingText += text;
    this.state.hasShownThinking = true;
    this.scheduleThinkingFlush();
  }

  addToolEntry(icon: string, label: string): void {
    if (!this.state?.isActive) return;
    this.state.toolEntries.push({ icon, label });
    // Like opencode: each tool as a new message at bottom, ephemeral
    const text = `${icon} ${escapeHtml(label.slice(0, 300))}`;
    this.enqueue(async () => {
      if (!this.state?.isActive) return;
      try {
        const msg = await this.bot.api.sendMessage(this.chatId, text, { parse_mode: "HTML" } as never);
        this.state?.toolMessageIds.push(msg.message_id);
      } catch {
        try {
          const msg = await this.bot.api.sendMessage(this.chatId, text);
          this.state?.toolMessageIds.push(msg.message_id);
        } catch { /* ignore */ }
      }
    }).catch(() => {});
  }

  private scheduleThinkingFlush(): void {
    const s = this.state;
    if (!s) return;
    if (s.thinkingFlushTimer) {
      clearTimeout(s.thinkingFlushTimer);
    }
    s.thinkingFlushTimer = setTimeout(() => {
      if (this.state?.isActive) {
        this.flushThinking().catch(() => {});
      }
    }, THINKING_FLUSH_MS);
  }

  private scheduleResponseFlush(): void {
    const s = this.state;
    if (!s) return;
    if (s.responseFlushTimer) return; // already scheduled
    s.responseFlushTimer = setTimeout(() => {
      if (this.state?.isActive) {
        this.flushResponse().catch(() => {});
      }
    }, RESPONSE_FLUSH_MS);
  }

  private async flushResponse(): Promise<void> {
    return this.enqueue(async () => {
      const s = this.state;
      if (!s || !s.isActive) return;
      if (s.accumulatedText.length <= s.lastSentLength) {
        s.responseFlushTimer = null;
        return;
      }
      // Defer response streaming while thinking is still flushing (like opencode)
      if (s.thinkingText.length > 0 && s.thinkingLastSentLength < s.thinkingText.length) {
        s.responseFlushTimer = null;
        return;
      }
      const display = s.accumulatedText.slice(0, RESPONSE_EDIT_LIMIT);
      const suffix = s.accumulatedText.length > RESPONSE_EDIT_LIMIT ? " …" : "";
      const html = escapeHtml(display + suffix);
      try {
        if (s.responseMessageId) {
          await this.bot.api.editMessageText(s.chatId, s.responseMessageId, html, {
            parse_mode: "HTML",
          } as never);
        } else {
          const msg = await this.bot.api.sendMessage(s.chatId, html, { parse_mode: "HTML" } as never);
          s.responseMessageId = msg.message_id;
        }
        s.lastSentLength = Math.min(s.accumulatedText.length, RESPONSE_EDIT_LIMIT);
      } catch {
        try {
          if (!s.responseMessageId) {
            const msg = await this.bot.api.sendMessage(s.chatId, html);
            s.responseMessageId = msg.message_id;
            s.lastSentLength = Math.min(s.accumulatedText.length, RESPONSE_EDIT_LIMIT);
          }
        } catch { /* ignore */ }
      } finally {
        s.responseFlushTimer = null;
        if (s.accumulatedText.length > s.lastSentLength) {
          this.scheduleResponseFlush();
        }
      }
    });
  }

  private async flushThinking(): Promise<void> {
    return this.enqueue(async () => {
      const s = this.state;
      if (!s || !s.isActive) return;
      if (s.thinkingText.length <= s.thinkingLastSentLength) return;

      const newText = s.thinkingText.slice(s.thinkingLastSentLength);
      s.thinkingLastSentLength = s.thinkingText.length;

      if (!newText) return;

      const escaped = escapeHtml(newText);
      const chunks = chunkText(escaped, TEXT_LIMIT);
      for (const chunk of chunks) {
        await this.sendHtml(`💭 ${chunk}`);
      }

      if (s.progressMessageId) {
        const ctxWarn = this.contextChars > 40_000
          ? ` [${(this.contextChars / 1000).toFixed(0)}K]`
          : "";
        this.bot.api.editMessageText(s.chatId, s.progressMessageId, `💭...${ctxWarn}`, {
          reply_markup: new InlineKeyboard().text("Abort", `abort:${s.generation}`),
        }).catch(() => {});
      }
    });
  }

  setUsage(usage: UsageData): void {
    if (!this.state?.isActive) return;
    this.state.usage = usage;
  }

  setToolSummary(_text: string): void {
    // Now shown in footer only
  }

  setProgressDone(): void {
    // No-op
  }

  async finalize(toolSummary: string, duration: string): Promise<void> {
    const s = this.state;
    if (!s) { logger.debug("[Stream] finalize: no state"); return; }
    logger.debug(`[Stream] finalize: acc=${s.accumulatedText.length} chars, thinking=${s.thinkingText.length}`);

    this.cancelTimers();
    this.cleanup();

    await this.enqueue(async () => {
      if (!this.state) return;

      // Flush remaining thinking
      if (this.state.thinkingText.length > this.state.thinkingLastSentLength) {
        const newText = this.state.thinkingText.slice(this.state.thinkingLastSentLength);
        this.state.thinkingLastSentLength = this.state.thinkingText.length;
        if (newText) {
          const escaped = escapeHtml(newText);
          const chunks = chunkText(escaped, TEXT_LIMIT);
          for (const chunk of chunks) {
            await this.sendHtml(`💭 ${chunk}`);
          }
        }
      }

      // Flush all accumulated response - downwards streaming (responseMessageId at bottom)
      if (this.state.accumulatedText.length > 0) {
        const escaped = escapeHtml(this.state.accumulatedText);
        const chunks = chunkText(escaped, TEXT_LIMIT);
        if (this.state.responseMessageId) {
          // Already streaming downwards - edit final first chunk
          try {
            await this.bot.api.editMessageText(this.chatId, this.state.responseMessageId, chunks[0], { parse_mode: "HTML" } as never);
          } catch {
            try { await this.bot.api.editMessageText(this.chatId, this.state.responseMessageId, chunks[0]); } catch { /* ignore */ }
          }
          for (let i = 1; i < chunks.length; i++) {
            await this.sendHtml(chunks[i]);
          }
        } else {
          // No streaming yet - create response message(s) at bottom
          for (const chunk of chunks) {
            const mid = await this.sendHtml(chunk);
            if (!this.state.responseMessageId && mid) this.state.responseMessageId = mid;
          }
        }
        // Mark progress as done (keep at top)
        if (this.state.progressMessageId) {
          try {
            await this.bot.api.editMessageText(this.chatId, this.state.progressMessageId, "✅ Terminé");
          } catch { /* ignore */ }
        }
      } else if (this.state.progressMessageId) {
        try {
          await this.bot.api.editMessageText(this.chatId, this.state.progressMessageId, "✅ Done");
        } catch { /* ignore */ }
      }

      // Delete all ephemeral tool messages (including bash) like opencode - leave only model messages
      for (const mid of this.state.toolMessageIds) {
        try { await this.bot.api.deleteMessage(this.chatId, mid); } catch { /* ignore */ }
      }
      this.state.toolMessageIds = [];

      // Send footer
      this.appendFooter(toolSummary, duration);
    });
  }

  private appendFooter(_toolSummary: string, duration: string): void {
    const s = this.state;
    if (!s) return;

    const stats: string[] = [];
    if (s.usage) {
      stats.push(`🤖 ${s.usage.inputTokens}→${s.usage.outputTokens}`);
      if (s.usage.cost > 0) {
        stats.push(`💰 $${s.usage.cost.toFixed(4)}`);
      }
    }
    stats.push(`⏱ ${duration}`);
    const footer = stats.join(" · ");

    this.bot.api.sendMessage(this.chatId, footer).catch(() => {});
  }

  cancelWithAccumulated(): Promise<void> {
    return this.finalize("", "");
  }

  abort(): void {
    const s = this.state;
    if (!s) return;
    this.cancelTimers();
    if (s.progressMessageId) {
      this.bot.api.editMessageText(s.chatId, s.progressMessageId, "⏹️ Annulé").catch(() => {});
    }
    this.cleanup();
  }

  flushNow(): Promise<void> {
    if (!this.state) return Promise.resolve();
    this.cancelTimers();
    if (this.state.thinkingText.length > this.state.thinkingLastSentLength) {
      return this.flushThinking();
    }
    return Promise.resolve();
  }

  private cancelTimers(): void {
    if (this.state?.thinkingFlushTimer) {
      clearTimeout(this.state.thinkingFlushTimer);
      this.state.thinkingFlushTimer = null;
    }
    if (this.state?.responseFlushTimer) {
      clearTimeout(this.state.responseFlushTimer);
      this.state.responseFlushTimer = null;
    }
  }

  private cleanup(): void {
    if (this.state) {
      this.state.isActive = false;
    }
  }

  private async sendHtml(text: string): Promise<number | null> {
    try {
      const msg = await this.bot.api.sendMessage(this.chatId, text, { parse_mode: "HTML" } as never);
      return msg.message_id;
    } catch {
      try {
        const msg = await this.bot.api.sendMessage(this.chatId, text);
        return msg.message_id;
      } catch { /* ignore */ }
    }
    return null;
  }
}

export function chunkText(text: string, limit: number): string[] {
  if (!text) return [];
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    if (start + limit >= text.length) {
      chunks.push(text.slice(start));
      break;
    }
    const end = start + limit;
    const nl = text.lastIndexOf("\n", end);
    if (nl > start && end - nl < 1000) {
      chunks.push(text.slice(start, nl + 1));
      start = nl + 1;
    } else {
      chunks.push(text.slice(start, end));
      start = end;
    }
  }
  return chunks;
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
