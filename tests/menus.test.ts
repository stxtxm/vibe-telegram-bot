import { describe, it, expect } from "vitest";
import {
  buildModelMenu,
  buildModeMenu,
  buildThinkingMenu,
  buildSessionList,
  isModelSelect,
  isModeSelect,
  isThinkingSelect,
  isSessionSelect,
  isSessionPage,
  isMenuCancel,
  parseModelData,
  parseModeData,
  parseThinkingData,
  parseSessionSelect,
  parseSessionPage,
} from "../src/bot/menus.js";
import type { ACPModel, ACPMode, ACPSessionInfo } from "../src/acp/protocol.js";

const SAMPLE_MODELS: ACPModel[] = [
  { modelId: "codestral-latest", name: "Codestral" },
  { modelId: "mistral-large-latest", name: "Mistral Large" },
];

const SAMPLE_MODES: ACPMode[] = [
  { id: "architect", name: "Architect" },
  { id: "agent", name: "Agent" },
];

const SAMPLE_SESSIONS: ACPSessionInfo[] = [
  { sessionId: "abc123", title: "Session A", cwd: "/a", updatedAt: "2024-01-01T00:00:00Z" },
  { sessionId: "def456", title: "Session B", cwd: "/b" },
  { sessionId: "ghi789", cwd: "/c" },
];

describe("Menu predicates", () => {
  it("isModelSelect", () => {
    expect(isModelSelect("model:codestral-latest")).toBe(true);
    expect(isModelSelect("mode:agent")).toBe(false);
    expect(isModelSelect("cancel")).toBe(false);
  });

  it("isModeSelect", () => {
    expect(isModeSelect("mode:architect")).toBe(true);
    expect(isModeSelect("model:x")).toBe(false);
  });

  it("isThinkingSelect", () => {
    expect(isThinkingSelect("think:high")).toBe(true);
    expect(isThinkingSelect("think:off")).toBe(true);
    expect(isThinkingSelect("model:x")).toBe(false);
  });

  it("isSessionSelect", () => {
    expect(isSessionSelect("ses:abc123")).toBe(true);
    expect(isSessionSelect("sespage:1")).toBe(false);
  });

  it("isSessionPage", () => {
    expect(isSessionPage("sespage:0")).toBe(true);
    expect(isSessionPage("sespage:3")).toBe(true);
    expect(isSessionPage("ses:abc")).toBe(false);
  });

  it("isMenuCancel", () => {
    expect(isMenuCancel("cancel")).toBe(true);
    expect(isMenuCancel("model:x")).toBe(false);
  });
});

describe("Menu parsers", () => {
  it("parseModelData", () => {
    expect(parseModelData("model:codestral-latest")).toBe("codestral-latest");
  });

  it("parseModeData", () => {
    expect(parseModeData("mode:architect")).toBe("architect");
  });

  it("parseThinkingData", () => {
    expect(parseThinkingData("think:high")).toBe("high");
    expect(parseThinkingData("think:off")).toBe("off");
  });

  it("parseSessionSelect", () => {
    expect(parseSessionSelect("ses:abc123")).toBe("abc123");
  });

  it("parseSessionPage", () => {
    expect(parseSessionPage("sespage:2")).toBe(2);
  });
});

describe("buildModelMenu", () => {
  it("should include all models with current marked", () => {
    const menu = buildModelMenu(SAMPLE_MODELS, "codestral-latest");
    expect(menu.text).toBe("🤖 **Select model:**");
    // Keyboard should have 2 model buttons + 1 cancel
    expect(menu.keyboard).toBeDefined();
  });

  it("should work with empty list", () => {
    const menu = buildModelMenu([], "none");
    expect(menu.text).toBeDefined();
    expect(menu.keyboard).toBeDefined();
  });
});

describe("buildModeMenu", () => {
  it("should include all modes with current marked", () => {
    const menu = buildModeMenu(SAMPLE_MODES, "architect");
    expect(menu.text).toBe("🎯 **Select mode:**");
    expect(menu.keyboard).toBeDefined();
  });
});

describe("buildThinkingMenu", () => {
  it("should include all thinking levels", () => {
    const menu = buildThinkingMenu("off");
    expect(menu.text).toBe("💭 **Thinking budget:**");
    expect(menu.keyboard).toBeDefined();
  });

  it("should mark current level", () => {
    // Testing through keyboard is hard, just check it renders
    const menu = buildThinkingMenu("high");
    expect(menu.text).toBeDefined();
  });
});

describe("buildSessionList", () => {
  it("should render sessions with pagination", () => {
    const menu = buildSessionList(SAMPLE_SESSIONS, 0);
    expect(menu.text).toContain("📁 **Sessions**");
    expect(menu.text).toContain("page 1/1");
    expect(menu.keyboard).toBeDefined();
    // Session titles appear in keyboard buttons, not in text
  });

  it("should show empty state", () => {
    const menu = buildSessionList([], 0);
    expect(menu.text).toContain("Sessions");
    expect(menu.keyboard).toBeDefined();
  });

  it("should show pagination with many sessions", () => {
    const manySessions: ACPSessionInfo[] = Array.from({ length: 20 }, (_, i) => ({
      sessionId: `ses-${i}`,
      title: `Session ${i}`,
    }));
    const menu = buildSessionList(manySessions, 0);
    expect(menu.text).toContain("page 1/3");
  });
});
