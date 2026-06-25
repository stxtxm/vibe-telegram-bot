import { logger } from "../utils/logger.js";
import { config } from "../config.js";
import type { AcpClient } from "./client.js";
import type { ACPModel, ACPMode, ACPConfigOption, ACPSessionInfo } from "./protocol.js";

export class SessionManager {
  private client: AcpClient;
  private sessions = new Map<string, SessionState>();
  private currentId: string | null = null;

  constructor(client: AcpClient) {
    this.client = client;
  }

  get currentSessionId(): string | null {
    return this.currentId;
  }

  set currentSessionId(id: string | null) {
    this.currentId = id;
  }

  get current(): SessionState | undefined {
    return this.currentId ? this.sessions.get(this.currentId) : undefined;
  }

  async createSession(cwd: string): Promise<string> {
    const resp: any = await this.client.newSession(cwd);
    if (!resp?.sessionId) throw new Error(`Invalid response: ${JSON.stringify(resp)}`);
    this.sessions.set(resp.sessionId, {
      id: resp.sessionId,
      cwd,
      models: resp.models,
      modes: resp.modes,
      configOptions: resp.configOptions,
    });
    this.currentId = resp.sessionId;
    logger.info(`[Session] created ${resp.sessionId}`);
    return resp.sessionId;
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    const resp: any = await this.client.setModel(sessionId, modelId);
    if (resp === null) throw new Error(`Server refused model change to "${modelId}"`);
    const s = this.sessions.get(sessionId);
    if (s) {
      if (resp?.models) {
        s.models = resp.models;
      } else if (s.models) {
        // Response doesn't include models — optimistically update local state
        s.models.currentModelId = modelId;
      }
    }
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const resp: any = await this.client.setMode(sessionId, modeId);
    if (resp === null) throw new Error(`Server refused mode change to "${modeId}"`);
    const s = this.sessions.get(sessionId);
    if (s) {
      if (resp?.modes) {
        s.modes = resp.modes;
      } else if (s.modes) {
        // Response doesn't include modes — optimistically update local state
        s.modes.currentModeId = modeId;
      }
    }
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    const resp: any = await this.client.setConfigOption(sessionId, configId, value);
    if (resp === null) throw new Error(`Server refused config change for "${configId}"`);
    const s = this.sessions.get(sessionId);
    if (s && resp?.configOptions) s.configOptions = resp.configOptions;
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.client.closeSession(sessionId);
    this.sessions.delete(sessionId);
    if (this.currentId === sessionId) this.currentId = null;
  }

  async listSessions(): Promise<{ sessions: ACPSessionInfo[] }> {
    const resp: any = await this.client.listSessions();
    const sessions = resp?.sessions ?? [];
    
    // Sync remote sessions to local map
    for (const s of sessions) {
      if (!this.sessions.has(s.sessionId)) {
        this.sessions.set(s.sessionId, {
          id: s.sessionId,
          cwd: s.cwd || config.vibe.projectDir,
          title: s.title,
        });
      }
    }
    
    return { sessions };
  }

  async setTitle(sessionId: string, title: string): Promise<void> {
    await this.client.setTitle(sessionId, title);
    const s = this.sessions.get(sessionId);
    if (s) s.title = title;
  }

  async sendPrompt(sessionId: string, text: string): Promise<void> {
    await this.client.sendPrompt(sessionId, text);
  }

  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }
}

export interface SessionState {
  id: string;
  cwd: string;
  title?: string;
  models?: { availableModels: ACPModel[]; currentModelId: string };
  modes?: { availableModes: ACPMode[]; currentModeId: string };
  configOptions?: ACPConfigOption[];
}
