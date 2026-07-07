import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { logger } from "../utils/logger.js";

const MISTRAL_API = "https://api.mistral.ai/v1";
const ENV_PATH = join(homedir(), ".vibe", ".env");
const STATE_FILE = "/tmp/vibe-auth-state.json";
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, "..", "..", "scripts");

export interface SignInAttempt {
  signInUrl: string;
}

export function loadApiKey(): string | null {
  try {
    const content = readFileSync(ENV_PATH, "utf-8");
    const m = content.match(/MISTRAL_API_KEY=['"]?([^'"\n]+)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function validateApiKey(key: string): Promise<boolean> {
  try {
    const res = await fetch(`${MISTRAL_API}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function startSignIn(): Promise<SignInAttempt> {
  logger.info("[Auth] Starting browser sign-in process...");

  const { stdout, stderr } = await runPythonScript("auth_start.py", [STATE_FILE]);
  const data = JSON.parse(stdout.trim());

  if (data.action === "error") {
    throw new Error(data.message);
  }

  if (data.action !== "sign_in_url") {
    throw new Error(`Unexpected response: ${data.action}`);
  }

  logger.info("[Auth] Sign-in process created");
  return { signInUrl: data.sign_in_url };
}

export async function pollAndExchange(onWaiting?: () => void): Promise<string> {
  logger.info("[Auth] Polling for sign-in completion...");

  const child = execFile("python3", [
    join(SCRIPTS_DIR, "auth_complete.py"),
    STATE_FILE,
  ]);

  let stdout = "";
  let stderr = "";
  let resolvedKey: string | null = null;

  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split("\n");
    stdout = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.action === "waiting" && onWaiting) {
          onWaiting();
        }
        if (data.action === "api_key") {
          logger.info("[Auth] Poll complete: API key obtained");
          resolvedKey = data.api_key;
        }
        if (data.action === "error") {
          logger.error(`[Auth] Poll error: ${data.message}`);
        }
      } catch {
        logger.warn(`[Auth] Failed to parse poll output: ${line}`);
      }
    }
  });

  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise<string>((resolve, reject) => {
    child.on("close", (code) => {
      // If the inline handler already captured the key, resolve immediately
      if (resolvedKey) {
        logger.info("[Auth] API key obtained successfully");
        resolve(resolvedKey);
        return;
      }

      // Otherwise try remaining buffered output
      if (stdout.trim()) {
        try {
          const data = JSON.parse(stdout.trim());
          if (data.action === "api_key") {
            logger.info("[Auth] API key obtained successfully");
            resolve(data.api_key);
            return;
          }
          if (data.action === "error") {
            reject(new Error(data.message));
            return;
          }
        } catch {
          // Not parseable, fall through
        }
      }

      reject(
        new Error(
          stderr.trim() || `Auth poll failed (exit code ${code})`
        )
      );
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to start auth poll: ${err.message}`));
    });
  });
}

export function saveApiKey(key: string): void {
  const content = `MISTRAL_API_KEY='${key}'\n`;
  writeFileSync(ENV_PATH, content, "utf-8");
  logger.info("[Auth] API key saved to ~/.vibe/.env");
}

function runPythonScript(script: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "python3",
      [join(SCRIPTS_DIR, script), ...args],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}
