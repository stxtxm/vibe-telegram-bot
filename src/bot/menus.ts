import { InlineKeyboard } from "grammy";
import type { ACPModel, ACPMode, ACPSessionInfo } from "../acp/protocol.js";

export { isFileAction } from "./files.js";

// === PREDICATES FOR CALLBACK ROUTING ===

export function isModelSelect(data: string): boolean { return data.startsWith("model:"); }
export function isModeSelect(data: string): boolean { return data.startsWith("mode:"); }
export function isThinkingSelect(data: string): boolean { return data.startsWith("think:"); }
export function isSessionSelect(data: string): boolean { return data.startsWith("ses:"); }
export function isSessionPage(data: string): boolean { return data.startsWith("sespage:"); }
export function isMenuCancel(data: string): boolean { return data === "cancel"; }
export function isQuestionSelect(data: string): boolean { return data.startsWith("question:"); }

// Game predicates
export function isBudHarvest(data: string): boolean { return data === 'bud-harvest'; }
export function isBudSell(data: string): boolean { return data === 'bud-sell' || data.startsWith('bud-sell:'); }
export function isBudSellAll(data: string): boolean { return data === 'bud-sell-all'; }
export function isBudUpgrade(data: string): boolean { return data.startsWith('bud-upgrade:'); }
export function isBudUpgradeList(data: string): boolean { return data === 'bud-upgrade-list'; }
export function isBudStrain(data: string): boolean { return data.startsWith('bud-strain:'); }
export function isBudStrainList(data: string): boolean { return data === 'bud-strain-list'; }
export function isBudBuyStrain(data: string): boolean { return data.startsWith('bud-buystrain:'); }
export function isBudCraft(data: string): boolean { return data.startsWith('bud-craft:'); }
export function isBudCraftList(data: string): boolean { return data === 'bud-craft-list'; }
export function isBudSellProduct(data: string): boolean { return data.startsWith('bud-sellproduct:'); }
export function isBudProgress(data: string): boolean { return data === 'bud-progress'; }
export function isBudMain(data: string): boolean { return data === 'bud-main'; }

export function parseModelData(data: string): string { return data.slice(6); }
export function parseModeData(data: string): string { return data.slice(5); }
export function parseThinkingData(data: string): string { return data.slice(6); }
export function parseSessionSelect(data: string): string { return data.slice(4); }
export function parseSessionPage(data: string): number { return parseInt(data.slice(8), 10); }
export function parseQuestionData(data: string): { qid: string; option: string } {
  const rest = data.slice(9);
  const sep = rest.lastIndexOf(":");
  return { qid: rest.slice(0, sep), option: rest.slice(sep + 1) };
}

export const QUESTION_CUSTOM = "custom";
export const QUESTION_SKIP = "skip";

const OPTION_LABEL_MAX = 45;

export function buildQuestionMenu(qid: string, questionText: string, options: string[]): { text: string; keyboard: InlineKeyboard } {
  const kb = new InlineKeyboard();
  for (let i = 0; i < options.length; i++) {
    const label = options[i].length > OPTION_LABEL_MAX
      ? options[i].slice(0, OPTION_LABEL_MAX - 1) + "…"
      : options[i];
    kb.text(label, `question:${qid}:${i}`).row();
  }
  kb.text("✏️ Réponse libre", `question:${qid}:${QUESTION_CUSTOM}`).row();
  kb.text("⏭️ Décide toi-même", `question:${qid}:${QUESTION_SKIP}`).row();
  const fallback = questionText.trim() ? questionText : "(sans texte — choisis une option)";
  return {
    text: `❓ **${escapeMenuText(fallback)}**\n\n_Choisis une option, ou écris ta réponse en message._`,
    keyboard: kb,
  };
}

// === MODEL MENU ===

export function buildModelMenu(models: ACPModel[], currentId: string): { text: string; keyboard: InlineKeyboard } {
  const kb = new InlineKeyboard();
  for (const m of models) {
    const label = m.modelId === currentId ? `✅ ${m.name}` : m.name;
    kb.text(label, `model:${m.modelId}`).row();
  }
  kb.text("❌ Cancel", "cancel");
  return {
    text: "🤖 **Select model:**",
    keyboard: kb,
  };
}

// === MODE MENU ===

export function buildModeMenu(modes: ACPMode[], currentId: string): { text: string; keyboard: InlineKeyboard } {
  const kb = new InlineKeyboard();
  for (const m of modes) {
    const label = m.id === currentId ? `✅ ${m.name}` : m.name;
    kb.text(label, `mode:${m.id}`).row();
  }
  kb.text("❌ Cancel", "cancel");
  return {
    text: "🎯 **Select mode:**",
    keyboard: kb,
  };
}

// === THINKING MENU ===

const THINKING_LEVELS = ["off", "low", "medium", "high", "max"];

export function buildThinkingMenu(currentValue: string): { text: string; keyboard: InlineKeyboard } {
  const kb = new InlineKeyboard();
  for (const level of THINKING_LEVELS) {
    const label = level === currentValue ? `✅ ${level}` : level;
    kb.text(label, `think:${level}`).row();
  }
  kb.text("❌ Cancel", "cancel");
  return {
    text: "💭 **Thinking budget:**",
    keyboard: kb,
  };
}

// === SESSION LIST MENU ===

const PAGE_SIZE = 8;

export function buildSessionList(sessions: ACPSessionInfo[], page: number): { text: string; keyboard: InlineKeyboard } {
  const kb = new InlineKeyboard();
  const start = page * PAGE_SIZE;
  const pageItems = sessions.slice(start, start + PAGE_SIZE);

  if (pageItems.length === 0) {
    kb.text("(no sessions)", "cancel").row();
  }

  for (const s of pageItems) {
    const title = s.title || s.sessionId.slice(0, 8);
    const date = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : "";
    kb.text(`${title} ${date}`, `ses:${s.sessionId}`).row();
  }

  const navRow: string[] = [];
  if (page > 0) navRow.push("⬅️ Prev");
  if (start + PAGE_SIZE < sessions.length) navRow.push("Next ➡️");
  if (navRow.length > 0) {
    if (navRow.length === 2) {
      kb.text(navRow[0], `sespage:${page - 1}`).text(navRow[1], `sespage:${page + 1}`).row();
    } else {
      kb.text(navRow[0], navRow[0].includes("Prev") ? `sespage:${page - 1}` : `sespage:${page + 1}`).row();
    }
  }

  kb.text("❌ Cancel", "cancel");
  return {
    text: `📁 **Sessions** (page ${page + 1}/${Math.ceil(sessions.length / PAGE_SIZE) || 1}):`,
    keyboard: kb,
  };
}

function escapeMenuText(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

// Game parse functions
export function parseBudUpgrade(data: string): string { return data.slice(13); }
export function parseBudStrain(data: string): string { return data.slice(11); }
export function parseBudBuyStrain(data: string): string { return data.slice(15); }
export function parseBudCraft(data: string): { productId: string; amount: number } {
  const parts = data.slice(10).split(':');
  return { productId: parts[0], amount: parseInt(parts[1] || '1', 10) };
}
export function parseBudSellProduct(data: string): { productId: string; amount: number } {
  const parts = data.slice(16).split(':');
  return { productId: parts[0], amount: parseInt(parts[1] || '1', 10) };
}
export function parseBudSell(data: string): number {
  return data === 'bud-sell' ? 1 : parseInt(data.slice(10), 10);
}
