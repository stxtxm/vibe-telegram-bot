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
      await this.bot.api.sendMessage(this.chatId, "⌨️ clavier", {
        reply_markup: kb,
        disable_notification: true,
      });
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
    // Clean command-only keyboard like opencode - no emoji display values that get sent as prompts
    kb.text("/model").text("/mode").row();
    kb.text("/thinking").text("/plan").row();
    kb.text("/sessions").text("/files").row();
    kb.text("/help").text("/status").row();
    return kb.resized().persistent();
  }

  getKeyboard(): Keyboard {
    return this.buildKeyboard();
  }
}
