import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import type { AcpClient } from "../src/acp/client.js";
import type { SessionManager } from "../src/acp/session.js";

type Handler = (ctx: Record<string, unknown>) => Promise<unknown>;

// Handlers registered by createBot, plus the mocks its reply paths go through.
const h = vi.hoisted(() => {
  const commands = new Map<string, (ctx: Record<string, unknown>) => Promise<unknown>>();
  const events = new Map<string, (ctx: Record<string, unknown>) => Promise<unknown>>();
  let callbackHandler: ((ctx: Record<string, unknown>) => Promise<unknown>) | null = null;

  const api = {
    setMyCommands: vi.fn(async () => true),
    sendMessage: vi.fn(async (_chatId: number, text: string) => ({ message_id: 500, text })),
    editMessageText: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    pinChatMessage: vi.fn(async () => true),
    sendChatAction: vi.fn(async () => true),
    getFile: vi.fn(async () => ({ file_path: "docs/report.txt" })),
    sendDocument: vi.fn(async () => ({ message_id: 501 })),
  };

  const streamer = {
    usage: null as { inputTokens: number; outputTokens: number; cost: number } | null,
    start: vi.fn(async () => 600),
    finalize: vi.fn(async () => undefined),
    abort: vi.fn(),
    setUsage: vi.fn(),
    addToolEntry: vi.fn(),
  };

  const keyboard = {
    updateCwd: vi.fn(),
    updateModel: vi.fn(),
    updateMode: vi.fn(),
    updateUsage: vi.fn(),
    refreshKeyboard: vi.fn(),
    flushKeyboard: vi.fn(),
  };

  return {
    commands,
    events,
    api,
    streamer,
    keyboard,
    callback: () => callbackHandler,
    setCallback: (fn: (ctx: Record<string, unknown>) => Promise<unknown>) => {
      callbackHandler = fn;
    },
    reset: () => {
      callbackHandler = null;
    },
  };
});

vi.mock("../src/config.js", () => ({
  config: {
    telegram: { token: "test-token", allowedUserId: 12345 },
    vibe: { projectDir: "/project" },
    server: { logLevel: "info" },
  },
}));

vi.mock("../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  setLogLevel: vi.fn(),
}));

vi.mock("grammy", () => {
  class Bot {
    api = h.api;
    command(name: string, fn: Handler) {
      h.commands.set(name, fn);
      return this;
    }
    on(event: string, fn: Handler) {
      h.events.set(event, fn);
      return this;
    }
    use() {
      return this;
    }
    catch() {
      return this;
    }
    callbackQuery(_pattern: unknown, fn: Handler) {
      h.setCallback(fn);
      return this;
    }
    start() {
      return Promise.resolve();
    }
    stop() {
      return Promise.resolve();
    }
  }
  class InlineKeyboard {
    text() {
      return this;
    }
    row() {
      return this;
    }
  }
  class Keyboard {
    text() {
      return this;
    }
    row() {
      return this;
    }
    resized() {
      return this;
    }
  }
  class InputFile {
    constructor(readonly path: string) {}
  }
  return { Bot, InlineKeyboard, Keyboard, InputFile };
});

vi.mock("../src/bot/stream.js", () => ({
  ResponseStreamer: vi.fn().mockImplementation(function () {
    return h.streamer;
  }),
}));

vi.mock("../src/bot/keyboard.js", () => ({
  KeyboardManager: vi.fn().mockImplementation(function () {
    return h.keyboard;
  }),
}));

import { createBot } from "../src/bot/index.js";

function makeAcp() {
  const resolvers: Array<(error?: Error) => void> = [];
  const prompts: Array<{ sessionId: string; text: string }> = [];
  const listeners: Array<(msg: unknown) => void> = [];
  return {
    resolvers,
    prompts,
    listeners,
    // Each prompt stays pending until the test resolves it, like a long Vibe run.
    sendPrompt: vi.fn((sessionId: string, text: string) => {
      prompts.push({ sessionId, text });
      return new Promise<unknown>((resolve, reject) => {
        resolvers.push((error) => (error ? reject(error) : resolve(undefined)));
      });
    }),
    cancelPrompt: vi.fn(),
    getRecentStderr: vi.fn(() => ""),
    stop: vi.fn(),
    start: vi.fn(async () => undefined),
    initialize: vi.fn(async () => undefined),
    respondPermission: vi.fn(async () => undefined),
    respondPermissionError: vi.fn(async () => undefined),
    onMessage: vi.fn((listener: (msg: unknown) => void) => {
      listeners.push(listener);
    }),
    contextChars: 0,
    contextMessages: 0,
  };
}

function makeSessionManager() {
  const session = {
    id: "session-1",
    cwd: "/project",
    title: "Test session",
    models: { currentModelId: "mistral-large", availableModels: [] },
    modes: { currentModeId: "code", availableModes: [] },
    configOptions: [],
  };
  return {
    currentSessionId: "session-1",
    current: session,
    getSession: vi.fn(() => session),
    createSession: vi.fn(async () => "session-1"),
    loadSession: vi.fn(async () => "session-1"),
    setTitle: vi.fn(async () => undefined),
  };
}

let acp: ReturnType<typeof makeAcp>;
let sm: ReturnType<typeof makeSessionManager>;
let uploadedFile: string | null = null;

beforeEach(async () => {
  h.commands.clear();
  h.events.clear();
  h.reset();
  vi.clearAllMocks();
  h.streamer.usage = null;
  uploadedFile = null;
  acp = makeAcp();
  sm = makeSessionManager();
  await createBot(acp as unknown as AcpClient, sm as unknown as SessionManager);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (uploadedFile) {
    await fs.rm(uploadedFile, { force: true });
    uploadedFile = null;
  }
});

function makeCtx(text: string, messageId = 7) {
  const replies: string[] = [];
  const reply = vi.fn(async (value: string) => {
    replies.push(value);
    return { message_id: 900 + replies.length };
  });
  return {
    ctx: { message: { text, message_id: messageId }, chat: { id: 12345 }, reply } as Record<string, unknown>,
    replies,
  };
}

function makeDocumentCtx(fileName = "report.txt") {
  const replies: string[] = [];
  const reply = vi.fn(async (value: string) => {
    replies.push(value);
    return { message_id: 950 };
  });
  return {
    ctx: {
      message: {
        message_id: 9,
        document: { file_id: "file-1", file_name: fileName, file_size: 12 },
      },
      chat: { id: 12345 },
      reply,
    } as Record<string, unknown>,
    replies,
  };
}

const textHandler = () => h.events.get("message:text") as Handler;
const documentHandler = () => h.events.get("message:document") as Handler;
const command = (name: string) => h.commands.get(name) as Handler;

const settle = (ms = 40) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function extractUpload(text: string): string | null {
  const match = text.match(/\[File uploaded to (.+?)\]/);
  return match ? match[1] : null;
}

async function statusText(): Promise<string> {
  const status = makeCtx("/status");
  await command("status")(status.ctx);
  return status.replies[0];
}

describe("câblage FIFO de createBot", () => {
  it("met en file les messages reçus pendant un prompt et les exécute dans l'ordre", async () => {
    await textHandler()(makeCtx("premier").ctx);

    const second = makeCtx("deuxieme");
    await textHandler()(second.ctx);
    const third = makeCtx("troisieme");
    await textHandler()(third.ctx);

    expect(acp.prompts).toHaveLength(1);
    expect(acp.prompts[0].text).toBe("premier");
    expect(second.replies[0]).toContain("1 dans la file");
    expect(third.replies[0]).toContain("2 dans la file");
    expect(await statusText()).toContain("File d'attente : 2");

    acp.resolvers.shift()?.();
    await vi.waitFor(() => expect(acp.prompts).toHaveLength(2), { timeout: 3000 });
    expect(acp.prompts[1].text).toBe("deuxieme");

    acp.resolvers.shift()?.();
    await vi.waitFor(() => expect(acp.prompts).toHaveLength(3), { timeout: 3000 });
    expect(acp.prompts[2].text).toBe("troisieme");

    acp.resolvers.shift()?.();
    await vi.waitFor(() => expect(h.streamer.finalize).toHaveBeenCalledTimes(3), { timeout: 3000 });
    await settle();

    const idle = await statusText();
    expect(idle).not.toContain("Busy");
    expect(idle).not.toContain("File d'attente");
  });

  it("/abort annule le prompt courant et vide la file", async () => {
    await textHandler()(makeCtx("long").ctx);
    await textHandler()(makeCtx("suivant 1").ctx);
    await textHandler()(makeCtx("suivant 2").ctx);

    const abort = makeCtx("/abort");
    await command("abort")(abort.ctx);

    expect(acp.cancelPrompt).toHaveBeenCalledWith("session-1");
    expect(h.streamer.abort).toHaveBeenCalledTimes(1);
    expect(abort.replies[0]).toContain("Prompt annulé");
    expect(abort.replies[0]).toContain("2 message(s) en attente supprimé(s)");

    acp.resolvers.shift()?.();
    await settle();

    // The cancelled prompt must not restart the two queued ones.
    expect(acp.prompts).toHaveLength(1);
    const idle = await statusText();
    expect(idle).not.toContain("Busy");
    expect(idle).not.toContain("File d'attente");
  });

  it("/abort rejette une permission en attente", async () => {
    await textHandler()(makeCtx("long").ctx);

    const listener = acp.listeners[0];
    if (!listener) throw new Error("onMessage handler not registered");
    listener({
      jsonrpc: "2.0",
      id: 77,
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { toolCallId: "tc-1", name: "bash", kind: "bash" },
        options: [
          { optionId: "allow_once", name: "Autoriser une fois" },
          { optionId: "deny", name: "Refuser" },
        ],
      },
    });
    await settle(10);

    expect(acp.respondPermissionError).not.toHaveBeenCalled();
    expect(await statusText()).toContain("permission en attente");

    const abort = makeCtx("/abort");
    await command("abort")(abort.ctx);

    expect(acp.respondPermissionError).toHaveBeenCalledWith(77);
    expect(acp.cancelPrompt).toHaveBeenCalledWith("session-1");
    const afterAbort = await statusText();
    expect(afterAbort).not.toContain("permission en attente");
    expect(afterAbort).not.toContain("Busy");

    acp.resolvers.shift()?.();
    await settle();
  });

  it("auto-rejette une permission après le timeout de 10 minutes", async () => {
    await textHandler()(makeCtx("long").ctx);

    const listener = acp.listeners[0];
    if (!listener) throw new Error("onMessage handler not registered");

    vi.useFakeTimers();
    try {
      listener({
        jsonrpc: "2.0",
        id: 78,
        method: "session/request_permission",
        params: {
          sessionId: "session-1",
          toolCall: { toolCallId: "tc-2", name: "write", kind: "write" },
          options: [{ optionId: "allow_once", name: "Autoriser une fois" }],
        },
      });
      await Promise.resolve();

      expect(acp.respondPermissionError).not.toHaveBeenCalled();
      expect(await statusText()).toContain("permission en attente");

      vi.advanceTimersByTime(600_000);

      expect(acp.respondPermissionError).toHaveBeenCalledWith(78);
      expect(h.api.sendMessage).toHaveBeenCalledWith(12345, expect.stringContaining("expirée"));
      // Le timeout ne fait que rejeter la permission : le prompt continue.
      expect(acp.cancelPrompt).not.toHaveBeenCalled();

      const afterTimeout = await statusText();
      expect(afterTimeout).not.toContain("permission en attente");
      expect(afterTimeout).toContain("Busy");
    } finally {
      vi.useRealTimers();
    }

    acp.resolvers.shift()?.();
    await settle();
  });

  it("accepte une permission via le bouton et refuse un id périmé", async () => {
    await textHandler()(makeCtx("long").ctx);

    const listener = acp.listeners[0];
    if (!listener) throw new Error("onMessage handler not registered");
    listener({
      jsonrpc: "2.0",
      id: 79,
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { toolCallId: "tc-3", name: "bash", kind: "bash" },
        options: [
          { optionId: "allow_once", name: "Autoriser une fois" },
          { optionId: "deny", name: "Refuser" },
        ],
      },
    });
    await settle(10);
    expect(await statusText()).toContain("permission en attente");

    const callback = h.callback();
    if (!callback) throw new Error("callback handler not registered");
    const acceptEdit = vi.fn(async () => true);
    const acceptAnswer = vi.fn(async () => true);
    await callback({
      callbackQuery: { data: "perm:79:allow_once" },
      from: { id: 12345 },
      answerCallbackQuery: acceptAnswer,
      editMessageText: acceptEdit,
    });

    expect(acp.respondPermission).toHaveBeenCalledWith(79, "allow_once");
    expect(acp.respondPermissionError).not.toHaveBeenCalled();
    expect(acceptAnswer).toHaveBeenCalled();
    expect(acceptEdit).toHaveBeenCalledWith(expect.stringContaining("✅"));
    expect(await statusText()).not.toContain("permission en attente");

    // Le même bouton, une fois la permission consommée, doit être refusé.
    const staleEdit = vi.fn(async () => true);
    const staleAnswer = vi.fn(async () => true);
    await callback({
      callbackQuery: { data: "perm:79:allow_once" },
      from: { id: 12345 },
      answerCallbackQuery: staleAnswer,
      editMessageText: staleEdit,
    });

    expect(acp.respondPermission).toHaveBeenCalledTimes(1);
    expect(staleAnswer).toHaveBeenCalledWith({ text: "⏳ Expiré, envoie un message" });
    expect(staleEdit).not.toHaveBeenCalled();

    acp.resolvers.shift()?.();
    await settle();
  });

  it("affiche une erreur si respondPermission échoue au clic", async () => {
    await textHandler()(makeCtx("long").ctx);

    const listener = acp.listeners[0];
    if (!listener) throw new Error("onMessage handler not registered");
    listener({
      jsonrpc: "2.0",
      id: 80,
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { toolCallId: "tc-4", name: "bash", kind: "bash" },
        options: [{ optionId: "allow_once", name: "Autoriser une fois" }],
      },
    });
    await settle(10);

    acp.respondPermission.mockRejectedValueOnce(new Error("rpc failed"));

    const callback = h.callback();
    if (!callback) throw new Error("callback handler not registered");
    const editMessageText = vi.fn(async () => true);
    const answerCallbackQuery = vi.fn(async () => true);
    await callback({
      callbackQuery: { data: "perm:80:allow_once" },
      from: { id: 12345 },
      answerCallbackQuery,
      editMessageText,
    });

    expect(answerCallbackQuery).toHaveBeenCalled();
    expect(editMessageText).toHaveBeenCalledWith("❌ Error: rpc failed");
    // L'état est purgé même si la réponse ACP a échoué.
    expect(await statusText()).not.toContain("permission en attente");

    acp.resolvers.shift()?.();
    await settle();
  });

  it("continue de vider la file quand un prompt échoue", async () => {
    await textHandler()(makeCtx("premier").ctx);
    const second = makeCtx("deuxieme");
    await textHandler()(second.ctx);
    expect(acp.prompts).toHaveLength(1);

    // Première tentative : erreur générique → réparation ACP puis seconde tentative.
    acp.resolvers.shift()?.(new Error("boom"));
    await vi.waitFor(() => expect(acp.prompts).toHaveLength(2), { timeout: 4000 });
    expect(acp.prompts[1].text).toBe("premier");
    expect(h.api.sendMessage.mock.calls.map(([, text]) => text).join("\n")).toContain(
      "🔄 Réparation automatique...",
    );

    // Seconde tentative : échec définitif, la file doit reprendre.
    acp.resolvers.shift()?.(new Error("boom définitif"));
    await vi.waitFor(() => expect(acp.prompts).toHaveLength(3), { timeout: 4000 });
    expect(acp.prompts[2].text).toBe("deuxieme");
    expect(h.api.sendMessage.mock.calls.map(([, text]) => text).join("\n")).toContain(
      "❌ boom définitif",
    );

    acp.resolvers.shift()?.();
    await settle();

    const idle = await statusText();
    expect(idle).not.toContain("Busy");
    expect(idle).not.toContain("File d'attente");
  });

  it("relance automatiquement après une erreur d'authentification", async () => {
    await textHandler()(makeCtx("premier").ctx);

    acp.resolvers.shift()?.(new Error("Unauthorized: invalid api key"));

    await vi.waitFor(() => expect(acp.prompts).toHaveLength(2), { timeout: 4000 });
    expect(acp.prompts[1].text).toBe("[retry after auth error]\n\npremier");
    expect(acp.stop).toHaveBeenCalledWith(true);
    expect(acp.start).toHaveBeenCalled();
    expect(acp.initialize).toHaveBeenCalled();
    expect(sm.loadSession).toHaveBeenCalledWith("session-1", "/project");

    const sent = h.api.sendMessage.mock.calls.map(([, text]) => text).join("\n");
    expect(sent).toContain("Erreur d'authentification");

    acp.resolvers.shift()?.();
    await vi.waitFor(() => expect(h.streamer.finalize).toHaveBeenCalled(), { timeout: 3000 });
    await settle();

    expect(await statusText()).not.toContain("Busy");
  });

  it("préfixe la relance d'une erreur API retryable", async () => {
    await textHandler()(makeCtx("premier").ctx);

    acp.resolvers.shift()?.(new Error("PoolTimeout"));

    await vi.waitFor(() => expect(acp.prompts).toHaveLength(2), { timeout: 4000 });
    expect(acp.prompts[1].text).toBe("[retry after timeout]\n\npremier");
    const sent = h.api.sendMessage.mock.calls.map(([, text]) => text).join("\n");
    expect(sent).toContain("Nouvelle tentative dans 1s");

    acp.resolvers.shift()?.();
    await vi.waitFor(() => expect(h.streamer.finalize).toHaveBeenCalled(), { timeout: 3000 });
    await settle();
  });

  it("/abort sans prompt en cours ne fait rien", async () => {
    const abort = makeCtx("/abort");
    await command("abort")(abort.ctx);

    expect(acp.cancelPrompt).not.toHaveBeenCalled();
    expect(abort.replies[0]).toContain("Aucun prompt en cours.");
  });

  it("le bouton Abort suit la même routine que /abort", async () => {
    await textHandler()(makeCtx("long").ctx);
    await textHandler()(makeCtx("suivant").ctx);

    const callback = h.callback();
    if (!callback) throw new Error("callback handler not registered");
    const editMessageText = vi.fn(async () => true);
    const answerCallbackQuery = vi.fn(async () => true);
    await callback({
      callbackQuery: { data: "abort:1" },
      from: { id: 12345 },
      answerCallbackQuery,
      editMessageText,
    });

    expect(acp.cancelPrompt).toHaveBeenCalledWith("session-1");
    expect(editMessageText).toHaveBeenCalledWith("⏹️ Annulé");
    expect(answerCallbackQuery).toHaveBeenCalled();

    acp.resolvers.shift()?.();
    await settle();

    expect(acp.prompts).toHaveLength(1);
    expect(await statusText()).not.toContain("File d'attente");
  });

  it("/retry relance le dernier prompt avec son upload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })),
    );
    const doc = makeDocumentCtx();
    await documentHandler()(doc.ctx);
    expect(doc.replies[0]).toContain("Fichier reçu");

    await textHandler()(makeCtx("analyse ce fichier").ctx);
    expect(acp.prompts).toHaveLength(1);
    expect(acp.prompts[0].text).toContain("[File uploaded to ");
    uploadedFile = extractUpload(acp.prompts[0].text);

    acp.resolvers.shift()?.();
    await vi.waitFor(() => expect(h.streamer.finalize).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await settle();

    const retry = makeCtx("/retry");
    await command("retry")(retry.ctx);

    expect(acp.prompts).toHaveLength(2);
    expect(acp.prompts[1].text).toBe(acp.prompts[0].text);

    acp.resolvers.shift()?.();
    await settle();
  });

  it("/retry pendant un prompt enfile la relance", async () => {
    await textHandler()(makeCtx("bonjour").ctx);

    const retry = makeCtx("/retry");
    await command("retry")(retry.ctx);

    expect(retry.replies[0]).toContain("Relance mise en file d'attente (#1)");
    expect(acp.prompts).toHaveLength(1);

    acp.resolvers.shift()?.();
    await vi.waitFor(() => expect(acp.prompts).toHaveLength(2), { timeout: 3000 });
    expect(acp.prompts[1].text).toBe("bonjour");

    acp.resolvers.shift()?.();
    await settle();
  });

  it("garde l'upload pour le message suivant, pas pour un prompt déjà en file", async () => {
    await textHandler()(makeCtx("premier").ctx);
    await textHandler()(makeCtx("deuxieme").ctx);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })),
    );
    await documentHandler()(makeDocumentCtx().ctx);

    acp.resolvers.shift()?.();
    await vi.waitFor(() => expect(acp.prompts).toHaveLength(2), { timeout: 3000 });
    expect(acp.prompts[1].text).toBe("deuxieme");

    await textHandler()(makeCtx("traite le fichier").ctx);
    acp.resolvers.shift()?.();
    await vi.waitFor(() => expect(acp.prompts).toHaveLength(3), { timeout: 3000 });
    expect(acp.prompts[2].text).toContain("[File uploaded to ");
    uploadedFile = extractUpload(acp.prompts[2].text);

    acp.resolvers.shift()?.();
    await settle();
  });
});
