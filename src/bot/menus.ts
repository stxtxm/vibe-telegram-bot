import { InlineKeyboard } from "grammy";
import type { ACPModel, ACPMode, ACPConfigOption, ACPSessionInfo } from "../acp/protocol.js";

export { isFileAction } from "./files.js";

// === PREDICATES FOR CALLBACK ROUTING ===

export function isModelSelect(data: string): boolean { return data.startsWith("model:"); }
export function isModeSelect(data: string): boolean { return data.startsWith("mode:"); }
export function isThinkingSelect(data: string): boolean { return data.startsWith("think:"); }
export function isSessionSelect(data: string): boolean { return data.startsWith("ses:"); }
export function isSessionPage(data: string): boolean { return data.startsWith("sespage:"); }
export function isMenuCancel(data: string): boolean { return data === "cancel"; }

export function parseModelData(data: string): string { return data.slice(6); }
export function parseModeData(data: string): string { return data.slice(5); }
export function parseThinkingData(data: string): string { return data.slice(6); }
export function parseSessionSelect(data: string): string { return data.slice(4); }
export function parseSessionPage(data: string): number { return parseInt(data.slice(8), 10); }

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
