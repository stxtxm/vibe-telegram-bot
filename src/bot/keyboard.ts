import { Keyboard, type Bot, type Context } from "grammy";

const UPDATE_DEBOUNCE_MS = 2_000;

// Single source of truth for the persistent reply keyboard labels.
// Keep in sync with the mapping in src/bot/index.ts (mapReplyKeyboardText).
export const REPLY_KEYBOARD_LABELS = {
  model: "🎯 Modèle",
  mode: "⚙️ Mode",
  thinking: "💭 Thinking",
  files: "📁 Fichiers",
} as const;

export type ReplyKeyboardAction = keyof typeof REPLY_KEYBOARD_LABELS;

/** Map raw message text to a reply-keyboard action (trim-tolerant, exact match). */
export function mapReplyKeyboardText(text: string): ReplyKeyboardAction | null {
  const t = text.trim();
  for (const [action, label] of Object.entries(REPLY_KEYBOARD_LABELS)) {
    if (t === label) return action as ReplyKeyboardAction;
  }
  return null;
}

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
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      // Optimization: do not spam standalone "⌨️ clavier" messages.
      // Attach getKeyboard() to relevant replies/status updates instead.
    }, UPDATE_DEBOUNCE_MS);
  }

  flushKeyboard(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // Kept for compatibility; intentionally no-op to avoid chat clutter/rate limits.
  private async sendKeyboardUpdate(): Promise<void> {
    return;
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
    // Compact 2x2 emoji keyboard — labels resolved via REPLY_KEYBOARD_LABELS,
    // mapped back to commands in src/bot/index.ts (never sent as prompts).
    kb.text(REPLY_KEYBOARD_LABELS.model).text(REPLY_KEYBOARD_LABELS.mode).row();
    kb.text(REPLY_KEYBOARD_LABELS.thinking).text(REPLY_KEYBOARD_LABELS.files).row();
    return kb.resized().persistent();
  }

  getKeyboard(): Keyboard {
    return this.buildKeyboard();
  }
}
