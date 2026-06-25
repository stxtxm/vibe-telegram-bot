import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", () => ({
  config: { vibe: { projectDir: "/default/project" } },
}));

import { SessionManager } from "../src/acp/session.js";

function createMockClient() {
  return {
    newSession: vi.fn(),
    setModel: vi.fn(),
    setMode: vi.fn(),
    setConfigOption: vi.fn(),
    closeSession: vi.fn(),
    listSessions: vi.fn(),
    sendPrompt: vi.fn(),
    setTitle: vi.fn(),
  };
}

const SAMPLE_NEW_SESSION_RESPONSE = {
  sessionId: "ses-12345678",
  models: {
    availableModels: [
      { modelId: "codestral-latest", name: "Codestral" },
      { modelId: "mistral-large-latest", name: "Mistral Large" },
    ],
    currentModelId: "codestral-latest",
  },
  modes: {
    availableModes: [
      { id: "architect", name: "Architect" },
      { id: "agent", name: "Agent" },
    ],
    currentModeId: "architect",
  },
  configOptions: [
    { id: "thinking", name: "Thinking", type: "select", category: "general", currentValue: "off", options: [] },
  ],
};

describe("SessionManager", () => {
  let client: ReturnType<typeof createMockClient>;
  let sm: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    client = createMockClient();
    sm = new SessionManager(client as any);
  });

  describe("createSession", () => {
    it("should call client.newSession and store the session", async () => {
      client.newSession.mockResolvedValue(SAMPLE_NEW_SESSION_RESPONSE);

      const sid = await sm.createSession("/project");

      expect(client.newSession).toHaveBeenCalledWith("/project");
      expect(sid).toBe("ses-12345678");
      expect(sm.currentSessionId).toBe("ses-12345678");

      const s = sm.getSession("ses-12345678");
      expect(s).toBeDefined();
      expect(s!.id).toBe("ses-12345678");
      expect(s!.cwd).toBe("/project");
      expect(s!.models!.currentModelId).toBe("codestral-latest");
      expect(s!.modes!.currentModeId).toBe("architect");
    });

    it("should throw on invalid response", async () => {
      client.newSession.mockResolvedValue({});
      await expect(sm.createSession("/project")).rejects.toThrow("Invalid response");
    });
  });

  describe("setModel", () => {
    it("should update local state optimistically when response has no models", async () => {
      sm["sessions"].set("ses-1", {
        id: "ses-1", cwd: "/p",
        models: { availableModels: [{ modelId: "old", name: "Old" }], currentModelId: "old" },
        modes: { availableModes: [], currentModeId: "" },
      } as any);
      sm.currentSessionId = "ses-1";

      client.setModel.mockResolvedValue({}); // Empty response — no models field

      await sm.setModel("ses-1", "mistral-large-latest");

      expect(client.setModel).toHaveBeenCalledWith("ses-1", "mistral-large-latest");
      const s = sm.getSession("ses-1");
      expect(s!.models!.currentModelId).toBe("mistral-large-latest");
    });

    it("should use models from response when present", async () => {
      sm["sessions"].set("ses-1", {
        id: "ses-1", cwd: "/p",
        models: { availableModels: [], currentModelId: "old" },
      } as any);

      client.setModel.mockResolvedValue({
        models: { availableModels: [{ modelId: "new", name: "New" }], currentModelId: "new" },
      });

      await sm.setModel("ses-1", "new");

      const s = sm.getSession("ses-1");
      expect(s!.models!.availableModels).toHaveLength(1);
      expect(s!.models!.currentModelId).toBe("new");
    });

    it("should throw on null response (server refused)", async () => {
      sm["sessions"].set("ses-1", { id: "ses-1", cwd: "/p" } as any);
      client.setModel.mockResolvedValue(null);

      await expect(sm.setModel("ses-1", "unknown")).rejects.toThrow("refused");
    });

    it("should not crash if session not in local state", async () => {
      client.setModel.mockResolvedValue({});
      await sm.setModel("unknown-session", "x");
    });
  });

  describe("setMode", () => {
    it("should update local state optimistically when response has no modes", async () => {
      sm["sessions"].set("ses-1", {
        id: "ses-1", cwd: "/p",
        modes: { availableModes: [{ id: "old", name: "Old" }], currentModeId: "old" },
        models: { availableModels: [], currentModelId: "" },
      } as any);
      sm.currentSessionId = "ses-1";

      client.setMode.mockResolvedValue({}); // Empty response — no modes field

      await sm.setMode("ses-1", "agent");

      expect(client.setMode).toHaveBeenCalledWith("ses-1", "agent");
      const s = sm.getSession("ses-1");
      expect(s!.modes!.currentModeId).toBe("agent");
    });

    it("should use modes from response when present", async () => {
      sm["sessions"].set("ses-1", {
        id: "ses-1", cwd: "/p",
        modes: { availableModes: [], currentModeId: "old" },
      } as any);

      client.setMode.mockResolvedValue({
        modes: { availableModes: [{ id: "new", name: "New" }], currentModeId: "new" },
      });

      await sm.setMode("ses-1", "new");

      const s = sm.getSession("ses-1");
      expect(s!.modes!.availableModes).toHaveLength(1);
      expect(s!.modes!.currentModeId).toBe("new");
    });

    it("should throw on null response (server refused)", async () => {
      sm["sessions"].set("ses-1", { id: "ses-1", cwd: "/p" } as any);
      client.setMode.mockResolvedValue(null);

      await expect(sm.setMode("ses-1", "unknown")).rejects.toThrow("refused");
    });

    it("should not crash if session not in local state", async () => {
      client.setMode.mockResolvedValue({});
      await sm.setMode("unknown-session", "x");
    });

    it("should not crash if session has no modes property yet", async () => {
      sm["sessions"].set("ses-1", { id: "ses-1", cwd: "/p" } as any);
      client.setMode.mockResolvedValue({});
      await sm.setMode("ses-1", "agent");
      // Should not throw
    });
  });

  describe("setConfigOption", () => {
    it("should update from response configOptions", async () => {
      const initialOptions = [
        { id: "thinking", name: "Thinking", type: "select", category: "general", currentValue: "off", options: [] },
      ];
      sm["sessions"].set("ses-1", { id: "ses-1", cwd: "/p", configOptions: initialOptions } as any);
      client.setConfigOption.mockResolvedValue({
        configOptions: [
          { id: "thinking", name: "Thinking", type: "select", category: "general", currentValue: "high", options: [] },
        ],
      });

      await sm.setConfigOption("ses-1", "thinking", "high");

      expect(client.setConfigOption).toHaveBeenCalledWith("ses-1", "thinking", "high");
      const s = sm.getSession("ses-1");
      expect(s!.configOptions![0].currentValue).toBe("high");
    });

    it("should throw on null response (server refused)", async () => {
      sm["sessions"].set("ses-1", { id: "ses-1", cwd: "/p" } as any);
      client.setConfigOption.mockResolvedValue(null);

      await expect(sm.setConfigOption("ses-1", "bad_option", "x")).rejects.toThrow("refused");
    });
  });

  describe("closeSession", () => {
    it("should call client.closeSession and remove local state", async () => {
      sm["sessions"].set("ses-1", { id: "ses-1", cwd: "/p" } as any);
      sm.currentSessionId = "ses-1";
      client.closeSession.mockResolvedValue({});

      await sm.closeSession("ses-1");

      expect(client.closeSession).toHaveBeenCalledWith("ses-1");
      expect(sm.getSession("ses-1")).toBeUndefined();
      expect(sm.currentSessionId).toBeNull();
    });

    it("should not clear currentSessionId if closing different session", async () => {
      sm["sessions"].set("ses-1", { id: "ses-1" } as any);
      sm["sessions"].set("ses-2", { id: "ses-2" } as any);
      sm.currentSessionId = "ses-2";
      client.closeSession.mockResolvedValue({});

      await sm.closeSession("ses-1");

      expect(sm.currentSessionId).toBe("ses-2");
    });
  });

  describe("listSessions", () => {
    it("should return sessions from client and sync to local map", async () => {
      client.listSessions.mockResolvedValue({
        sessions: [
          { sessionId: "ses-1", cwd: "/a", title: "Session A" },
          { sessionId: "ses-2", cwd: "/b" },
        ],
      });

      const result = await sm.listSessions();

      expect(client.listSessions).toHaveBeenCalled();
      expect(result.sessions).toHaveLength(2);
      expect(sm.getSession("ses-1")).toBeDefined();
      expect(sm.getSession("ses-1")!.cwd).toBe("/a");
      expect(sm.getSession("ses-2")).toBeDefined();
    });

    it("should not overwrite existing local sessions", async () => {
      sm["sessions"].set("ses-1", { id: "ses-1", cwd: "/local" } as any);
      client.listSessions.mockResolvedValue({
        sessions: [{ sessionId: "ses-1", cwd: "/remote", title: "Remote" }],
      });

      await sm.listSessions();

      expect(sm.getSession("ses-1")!.cwd).toBe("/local");
    });
  });

  describe("setTitle", () => {
    it("should call client.setTitle and update local title", async () => {
      sm["sessions"].set("ses-1", { id: "ses-1", cwd: "/p" } as any);
      client.setTitle.mockResolvedValue({});

      await sm.setTitle("ses-1", "New Title");

      expect(client.setTitle).toHaveBeenCalledWith("ses-1", "New Title");
      const s = sm.getSession("ses-1");
      expect(s!.title).toBe("New Title");
    });
  });

  describe("sendPrompt", () => {
    it("should delegate to client.sendPrompt", async () => {
      client.sendPrompt.mockResolvedValue({});
      await sm.sendPrompt("ses-1", "Hello");
      expect(client.sendPrompt).toHaveBeenCalledWith("ses-1", "Hello");
    });
  });

  describe("current", () => {
    it("should return current session or undefined", () => {
      expect(sm.current).toBeUndefined();
      sm["sessions"].set("ses-1", { id: "ses-1", cwd: "/p" } as any);
      sm.currentSessionId = "ses-1";
      expect(sm.current).toBeDefined();
      expect(sm.current!.id).toBe("ses-1");
    });
  });
});
