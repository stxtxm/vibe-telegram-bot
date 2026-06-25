import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import type { JsonRpcResponse, JsonRpcNotification } from "./protocol.js";

type MessageHandler = (msg: JsonRpcResponse | JsonRpcNotification) => void;
type DisconnectHandler = () => void;

const REQUEST_TIMEOUT = 600_000; // 10 minutes

function loadMistralKey(): string | undefined {
  try {
    const file = readFileSync(join(homedir(), ".vibe", ".env"), "utf-8");
    const m = file.match(/MISTRAL_API_KEY=['"]?([^'"\n]+)/);
    return m?.[1];
  } catch { return undefined; }
}

export class AcpClient {
  private proc: ChildProcess | null = null;
  private rl: ReadlineInterface | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private msgHandler: MessageHandler | null = null;
  private disconnectHandler: DisconnectHandler | null = null;

  onMessage(h: MessageHandler) { this.msgHandler = h; }
  onDisconnect(h: DisconnectHandler) { this.disconnectHandler = h; }

  async start(): Promise<void> {
    logger.info("[ACP] Starting vibe-acp...");
    const bin = process.env.VIBE_PATH || ".venv/bin/vibe-acp";
    const cwd = process.env.VIBE_CWD || process.cwd();
    const env: Record<string, string | undefined> = { ...process.env };
    if (!env.MISTRAL_API_KEY) {
      const key = loadMistralKey();
      if (key) env.MISTRAL_API_KEY = key;
    }

    this.proc = spawn(bin, [], { cwd, stdio: ["pipe", "pipe", "pipe"], env });

    this.proc.on("error", (err) => {
      logger.error("[ACP] spawn error:", err.message);
      this.disconnectHandler?.();
    });
    this.proc.on("exit", (code) => {
      logger.warn(`[ACP] exited code ${code}`);
      this.rejectAllPending(new Error(`ACP process exited with code ${code}`));
      if (code !== 0) this.disconnectHandler?.();
    });

    this.rl = createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    this.rl.on("line", (line) => this.onLine(line));

    this.proc.stderr!.on("data", (d: Buffer) => {
      const t = d.toString().trim();
      if (t) logger.debug(`[ACP stderr] ${t}`);
    });

    await new Promise((r) => setTimeout(r, 1500));
    logger.info("[ACP] vibe-acp ready");
  }

  private onLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    try {
      const msg = JSON.parse(line);
      const id = msg.id;
      const method = msg.method;
      logger.debug(`[ACP <<<] ${JSON.stringify({ id, method, hasResult: "result" in msg, hasError: "error" in msg })}`);

      // Server-to-client request (permission, fs, terminal)
      if (id != null && method) {
        this.msgHandler?.(msg);
        return;
      }

      // Response to our request
      if (id != null) {
        const cb = this.pending.get(id);
        if (cb) {
          this.pending.delete(id);
          if (msg.error) {
            cb.reject(new Error(`RPC ${msg.error.code}: ${msg.error.message}`));
          } else {
            cb.resolve(msg.result);
          }
        }
        return;
      }

      // Notification
      this.msgHandler?.(msg);
    } catch (e) {
      logger.warn("[ACP] parse error:", line.slice(0, 200));
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, cb] of this.pending) {
      cb.reject(err);
    }
    this.pending.clear();
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");

      setTimeout(() => {
        const cb = this.pending.get(id);
        if (cb) {
          this.pending.delete(id);
          cb.reject(new Error(`ACP request timeout: ${method}`));
        }
      }, REQUEST_TIMEOUT);
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  isConnected(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  // === ACP methods ===

  async initialize(): Promise<unknown> {
    logger.info("[ACP] initialize");
    const r = await this.request("initialize", {
      protocolVersion: 1, clientCapabilities: {},
      clientInfo: { name: "vibe-telegram-bot", version: "0.1.0" },
    });
    logger.info("[ACP] initialized");
    return r;
  }

  async newSession(cwd: string): Promise<unknown> {
    logger.info(`[ACP] newSession ${cwd}`);
    return this.request("session/new", { cwd, mcpServers: [] });
  }

  async setModel(sessionId: string, modelId: string): Promise<unknown> {
    logger.info(`[ACP] setModel ${sessionId.slice(0, 8)}... -> ${modelId}`);
    return this.request("session/set_model", { sessionId, modelId });
  }

  async setMode(sessionId: string, modeId: string): Promise<unknown> {
    logger.info(`[ACP] setMode ${sessionId.slice(0, 8)}... -> ${modeId}`);
    return this.request("session/set_mode", { sessionId, modeId });
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown> {
    logger.debug(`[ACP] setConfig ${configId}=${value}`);
    return this.request("session/set_config_option", { sessionId, configId, value });
  }

  async sendPrompt(sessionId: string, text: string): Promise<unknown> {
    logger.info(`[ACP] sendPrompt ${sessionId.slice(0, 8)}...`);
    return this.request("session/prompt", {
      sessionId, prompt: [{ type: "text", text }],
    });
  }

  async respondPermission(id: number, optionId: string): Promise<void> {
    logger.debug(`[ACP] respondPermission ${id} -> ${optionId}`);
    this.proc?.stdin?.write(JSON.stringify({
      jsonrpc: "2.0", id,
      result: { outcome: { outcome: "selected", optionId } },
    }) + "\n");
  }

  respondPermissionError(id: number): void {
    logger.debug(`[ACP] respondPermissionError ${id}`);
    this.proc?.stdin?.write(JSON.stringify({
      jsonrpc: "2.0", id,
      error: { code: -32000, message: "Permission timeout" },
    }) + "\n");
  }

  async closeSession(sessionId: string): Promise<unknown> {
    logger.info(`[ACP] closeSession ${sessionId.slice(0, 8)}...`);
    return this.request("session/close", { sessionId });
  }

  async listSessions(cursor?: string, cwd?: string): Promise<unknown> {
    logger.debug("[ACP] listSessions");
    return this.request("session/list", { cursor, cwd } as Record<string, unknown>);
  }

  cancelPrompt(sessionId: string): void {
    logger.info(`[ACP] cancelPrompt ${sessionId.slice(0, 8)}...`);
    this.sendNotification("session/cancel", { sessionId });
  }

  async setTitle(sessionId: string, title: string): Promise<unknown> {
    logger.info(`[ACP] setTitle ${sessionId.slice(0, 8)}... -> ${title}`);
    return this.request("_session/set_title", { sessionId, title });
  }

  stop(): void {
    logger.info("[ACP] stop");
    this.rejectAllPending(new Error("ACP client stopped"));
    this.proc?.kill("SIGTERM");
    setTimeout(() => { if (this.proc && !this.proc.killed) this.proc?.kill("SIGKILL"); }, 3000);
    this.rl?.close();
    this.proc = null;
    this.rl = null;
  }
}
