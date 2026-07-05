import { Keyboard, type Bot, type Context } from "grammy";
import { logger } from "../utils/logger.js";

const UPDATE_DEBOUNCE_MS = 2_000;

export interface KeyboardState {
  currentModel: string;
  currentMode: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  sessionCwd: string;
}

export class KeyboardManager {
  private bot: Bot<Context>;
  private chatId: number;
  private state: KeyboardState;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(bot: Bot<Context>, chatId: number) {
    this.bot = bot;
    this.chatId = chatId;
    this.state = {
      currentModel: "?",
      currentMode: "?",
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      sessionCwd: "?",
    };
  }

  updateModel(model: string): void {
    this.state.currentModel = model;
  }

  updateMode(mode: string): void {
    this.state.currentMode = mode;
  }

  updateUsage(inputTokens: number, outputTokens: number, cost: number): void {
    this.state.inputTokens = inputTokens;
    this.state.outputTokens = outputTokens;
    this.state.cost = cost;
  }

  updateCwd(cwd: string): void {
    this.state.sessionCwd = cwd;
  }

  refreshKeyboard(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.sendKeyboardUpdate().catch(() => {});
    }, UPDATE_DEBOUNCE_MS);
  }

  flushKeyboard(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.sendKeyboardUpdate().catch(() => {});
  }

  private async sendKeyboardUpdate(): Promise<void> {
    const kb = this.buildKeyboard();
    try {
      const msg = await this.bot.api.sendMessage(this.chatId, "⌨️", {
        reply_markup: kb,
        disable_notification: true,
      });
      await this.bot.api.deleteMessage(this.chatId, msg.message_id).catch(() => {});
    } catch (err) {
      logger.warn("[Keyboard] Failed to send update:", err);
    }
  }

  private formatTokenCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return String(n);
  }

  private truncatePath(path: string, maxLen = 20): string {
    if (path.length <= maxLen) return path;
    const parts = path.split("/");
    if (parts.length <= 2) return ".." + path.slice(-(maxLen - 2));
    return parts[0] + "/…/" + parts[parts.length - 1];
  }

  buildKeyboard(): Keyboard {
    const kb = new Keyboard();
    const tokIn = this.formatTokenCount(this.state.inputTokens);
    const tokOut = this.formatTokenCount(this.state.outputTokens);
    const cost = this.state.cost > 0 ? `$${this.state.cost.toFixed(4)}` : "—";
    const cwd = this.truncatePath(this.state.sessionCwd);

    kb.text(`🎯 ${this.state.currentModel}`).text(`📍 ${cwd}`).row();
    kb.text(`📊 ${tokIn}→${tokOut}`).text(`💰 ${cost}`).row();
    kb.text("/sessions").text("/model").text("/mode").row();
    kb.text("/thinking").text("/files").text("/help").row();
    return kb.resized();
  }

  getKeyboard(): Keyboard {
    return this.buildKeyboard();
  }
}
