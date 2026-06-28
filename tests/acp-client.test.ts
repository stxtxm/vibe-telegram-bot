import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

vi.stubEnv("VIBE_PATH", "mock-vibe-acp");
vi.stubEnv("VIBE_CWD", "/tmp");
vi.stubEnv("MISTRAL_API_KEY", "test-key");

const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return { ...actual, readFileSync: vi.fn(() => "") };
});

vi.mock("../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { AcpClient } from "../src/acp/client.js";

function makeMockProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = {
    stdin, stdout, stderr, pid: 12345, killed: false,
    kill: vi.fn(),
    on: vi.fn((_event: string, _handler: (...args: unknown[]) => void) => proc),
  } as unknown as ChildProcess;
  mockSpawn.mockReturnValue(proc);
  return { proc, stdin, stdout, stderr };
}

describe("AcpClient", () => {
  let client: AcpClient;
  let stdin: PassThrough;
  let stdout: PassThrough;
  let proc: ChildProcess;

  beforeEach(async () => {
    vi.clearAllMocks();
    const m = makeMockProcess();
    proc = m.proc;
    stdin = m.stdin;
    stdout = m.stdout;
    client = new AcpClient();

    // Start client with real timers - the 1500ms delay is acceptable
    const startPromise = client.start();
    // Delay 1500ms to let startup complete
    await new Promise((r) => setTimeout(r, 1600));
    await startPromise;
  });

  afterEach(() => {
    client.stop();
  });

  function receivedJson(): Record<string, unknown>[] {
    const written = stdin.read() as Buffer | null;
    if (!written) return [];
    return written
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  function pushServerMessage(msg: Record<string, unknown>): void {
    stdout.write(JSON.stringify(msg) + "\n");
  }

  describe("start/stop", () => {
    it("should spawn vibe-acp process", () => {
      expect(mockSpawn).toHaveBeenCalledWith(
        "mock-vibe-acp", [],
        expect.objectContaining({ cwd: "/tmp", stdio: ["pipe", "pipe", "pipe"] }),
      );
    });

    it("should kill process on stop", () => {
      client.stop();
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });

  describe("request/response", () => {
    it("should send JSON-RPC request and resolve with result", async () => {
      const promise = client.newSession("/test");

      const msgs = receivedJson();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({
        jsonrpc: "2.0",
        method: "session/new",
        params: { cwd: "/test", mcpServers: [] },
      });
      expect(msgs[0].id).toBeGreaterThan(0);

      const reqId = msgs[0].id as number;
      pushServerMessage({ jsonrpc: "2.0", id: reqId, result: { sessionId: "ses-1" } });

      await expect(promise).resolves.toEqual({ sessionId: "ses-1" });
    });

    it("should reject on error response", async () => {
      const promise = client.newSession("/test");
      const msgs = receivedJson();
      const reqId = msgs[0].id as number;
      pushServerMessage({
        jsonrpc: "2.0",
        id: reqId,
        error: { code: -32601, message: "Method not found" },
      });

      await expect(promise).rejects.toThrow("RPC -32601: Method not found");
    });

    it("should handle multiple concurrent requests", async () => {
      const p1 = client.newSession("/a");
      const p2 = client.newSession("/b");

      const msgs = receivedJson();
      expect(msgs).toHaveLength(2);
      const id1 = msgs[0].id as number;
      const id2 = msgs[1].id as number;

      pushServerMessage({ jsonrpc: "2.0", id: id1, result: { sessionId: "a" } });
      pushServerMessage({ jsonrpc: "2.0", id: id2, result: { sessionId: "b" } });

      await expect(p1).resolves.toEqual({ sessionId: "a" });
      await expect(p2).resolves.toEqual({ sessionId: "b" });
    });
  });

  describe("timeout", () => {
    it("should reject on timeout", async () => {
      vi.useFakeTimers();
      try {
        const promise = client.newSession("/test");
        // Advance past the 30min timeout
        await vi.advanceTimersByTimeAsync(1_810_000);
        await expect(promise).rejects.toThrow("timeout");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("ACP methods - wire format", () => {
    it("session/new - should send cwd and mcpServers", async () => {
      const promise = client.newSession("/project");
      expect(receivedJson()[0]).toMatchObject({
        method: "session/new",
        params: { cwd: "/project", mcpServers: [] },
      });
      pushServerMessage({ jsonrpc: "2.0", id: 1, result: { sessionId: "s1" } });
      await expect(promise).resolves.toEqual({ sessionId: "s1" });
    });

    it("session/set_model - should send sessionId and modelId", async () => {
      const promise = client.setModel("s1", "codestral-latest");
      expect(receivedJson()[0]).toMatchObject({
        method: "session/set_model",
        params: { sessionId: "s1", modelId: "codestral-latest" },
      });
      pushServerMessage({ jsonrpc: "2.0", id: 1, result: {} });
      await expect(promise).resolves.toEqual({});
    });

    it("session/set_mode - should send sessionId and modeId", async () => {
      const promise = client.setMode("s1", "architect");
      expect(receivedJson()[0]).toMatchObject({
        method: "session/set_mode",
        params: { sessionId: "s1", modeId: "architect" },
      });
      pushServerMessage({ jsonrpc: "2.0", id: 1, result: {} });
      await expect(promise).resolves.toEqual({});
    });

    it("session/set_config_option - should send sessionId, configId, value", async () => {
      const promise = client.setConfigOption("s1", "thinking", "high");
      expect(receivedJson()[0]).toMatchObject({
        method: "session/set_config_option",
        params: { sessionId: "s1", configId: "thinking", value: "high" },
      });
      pushServerMessage({ jsonrpc: "2.0", id: 1, result: { configOptions: [] } });
      await expect(promise).resolves.toEqual({ configOptions: [] });
    });

    it("session/prompt - should send sessionId and prompt array", async () => {
      const promise = client.sendPrompt("s1", "Hello");
      expect(receivedJson()[0]).toMatchObject({
        method: "session/prompt",
        params: {
          sessionId: "s1",
          prompt: [{ type: "text", text: "Hello" }],
        },
      });
      pushServerMessage({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
      await expect(promise).resolves.toEqual({ stopReason: "end_turn" });
    });

    it("session/close - should send sessionId", async () => {
      const promise = client.closeSession("s1");
      expect(receivedJson()[0]).toMatchObject({
        method: "session/close",
        params: { sessionId: "s1" },
      });
      pushServerMessage({ jsonrpc: "2.0", id: 1, result: {} });
      await expect(promise).resolves.toEqual({});
    });

    it("session/list - should send cursor and cwd", async () => {
      const promise = client.listSessions("cursor1", "/project");
      expect(receivedJson()[0]).toMatchObject({
        method: "session/list",
        params: { cursor: "cursor1", cwd: "/project" },
      });
      pushServerMessage({ jsonrpc: "2.0", id: 1, result: { sessions: [{ sessionId: "s1" }] } });
      await expect(promise).resolves.toEqual({ sessions: [{ sessionId: "s1" }] });
    });

    it("session/list - should work without arguments", async () => {
      const promise = client.listSessions();
      expect(receivedJson()[0]).toMatchObject({
        method: "session/list",
        params: {},
      });
      pushServerMessage({ jsonrpc: "2.0", id: 1, result: { sessions: [] } });
      await expect(promise).resolves.toEqual({ sessions: [] });
    });

    it("session/load - should send sessionId, cwd, and mcpServers", async () => {
      const promise = client.loadSession("s1", "/project");
      expect(receivedJson()[0]).toMatchObject({
        method: "session/load",
        params: { sessionId: "s1", cwd: "/project", mcpServers: [] },
      });
      pushServerMessage({
        jsonrpc: "2.0", id: 1,
        result: { models: { currentModelId: "mistral-large" }, modes: { currentModeId: "plan" } },
      });
      await expect(promise).resolves.toEqual({
        models: { currentModelId: "mistral-large" },
        modes: { currentModeId: "plan" },
      });
    });

    it("_session/set_title - should send underscore-prefixed method with direct params", async () => {
      const promise = client.setTitle("s1", "My Session");
      expect(receivedJson()[0]).toMatchObject({
        method: "_session/set_title",
        params: { sessionId: "s1", title: "My Session" },
      });
      pushServerMessage({ jsonrpc: "2.0", id: 1, result: {} });
      await expect(promise).resolves.toEqual({});
    });

    it("cancelPrompt - should send notification (no id)", () => {
      client.cancelPrompt("s1");
      const msg = receivedJson()[0];
      expect(msg).toMatchObject({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: "s1" },
      });
      expect(msg.id).toBeUndefined();
    });

    it("respondPermission - should write raw JSON-RPC response", () => {
      client.respondPermission(42, "allow_once");
      expect(receivedJson()[0]).toMatchObject({
        jsonrpc: "2.0",
        id: 42,
        result: { outcome: { outcome: "selected", optionId: "allow_once" } },
      });
    });
  });

  describe("notification handling", () => {
    it("should dispatch incoming server-to-client requests to onMessage", async () => {
      const handler = vi.fn();
      client.onMessage(handler);

      pushServerMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "session/request_permission",
        params: { sessionId: "s1", options: [{ optionId: "allow", name: "Allow" }], toolCall: {} },
      });

      // Let microtask process
      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledTimes(1);
      const msg = handler.mock.calls[0][0];
      expect(msg.method).toBe("session/request_permission");
      expect(msg.id).toBe(1);
    });

    it("should dispatch notifications to onMessage", async () => {
      const handler = vi.fn();
      client.onMessage(handler);

      pushServerMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "Hello" } } },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].method).toBe("session/update");
    });
  });
});
