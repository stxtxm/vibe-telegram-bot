export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface ACPModel {
  modelId: string;
  name: string;
}

export interface ACPMode {
  id: string;
  name: string;
  description?: string;
}

export interface ACPConfigOption {
  id: string;
  name: string;
  type: "select" | "boolean";
  category: string;
  currentValue: string;
  options?: { value: string; name: string; description?: string }[];
}

export interface ACPNewSessionResult {
  sessionId: string;
  models: { availableModels: ACPModel[]; currentModelId: string };
  modes: { availableModes: ACPMode[]; currentModeId: string };
  configOptions: ACPConfigOption[];
}

export interface ACPSessionInfo {
  sessionId: string;
  cwd?: string;
  title?: string;
  updatedAt?: string;
}

export interface ACPListSessionsResult {
  sessions: ACPSessionInfo[];
  nextCursor?: string;
}
