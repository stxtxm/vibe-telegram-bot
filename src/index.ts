import fs from "node:fs";
import { config } from "./config.js";
import { setLogLevel, logger } from "./utils/logger.js";
import { AcpClient } from "./acp/client.js";
import { SessionManager } from "./acp/session.js";
import { TodoManager } from "./todo.js";
import { createBot } from "./bot/index.js";

const LOCK_FILE = "/tmp/vibe-telegram-bot.pid";
const SHUTDOWN_TIMEOUT_MS = 10_000;

function checkLock(): void {
  try {
    const existing = fs.readFileSync(LOCK_FILE, "utf-8").trim();
    const pid = parseInt(existing, 10);
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        logger.error(`[Lock] Another instance already running (PID ${pid}). Exiting.`);
        process.exit(1);
      } catch {
        // Stale lock — PID is dead, we can proceed
      }
    }
  } catch {
    // No lock file — proceed
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid), "utf-8");
}

function removeLock(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // Ignore if file doesn't exist
  }
}

async function main(): Promise<void> {
  checkLock();
  setLogLevel(config.server.logLevel);

  logger.info("Starting Vibe Telegram Bot...");
  logger.info(`Allowed User ID: ${config.telegram.allowedUserId}`);
  logger.info(`Project directory: ${config.vibe.projectDir}`);

  // Attend 3s pour éviter de concurrencer les autres bots Telegram au démarrage
  await new Promise((r) => setTimeout(r, 3000));

  const acpClient = new AcpClient();
  const sessionManager = new SessionManager(acpClient);
  const todoManager = new TodoManager();
  await todoManager.load();

  let shuttingDown = false;

  acpClient.onDisconnect(async () => {
    logger.error("[ACP] Disconnected from vibe-acp");
    if (shuttingDown) return;

    logger.info("[ACP] Attempting restart in 3 seconds...");
    await new Promise((r) => setTimeout(r, 3000));
    if (shuttingDown) return;

    try {
      await acpClient.start();
      await acpClient.initialize();
      logger.info("[ACP] Reconnected successfully");
    } catch (err) {
      logger.error("[ACP] Reconnection failed:", err);
    }
  });

  await acpClient.start();

  try {
    await acpClient.initialize();
  } catch (err) {
    logger.error("[ACP] Failed to initialize:", err);
    acpClient.stop();
    process.exit(1);
  }

  // Restore previous session and persisted cwd
  await sessionManager.loadRemoteSessions();
  const lastCwd = await sessionManager.loadLastCwd();
  const existingSid = sessionManager.currentSessionId;
  if (existingSid && lastCwd) {
    // Load the session into memory (ACP server just started, sessions are on disk only)
    try {
      await sessionManager.loadSession(existingSid, lastCwd);
      logger.info(`[Session] Loaded session ${existingSid.slice(0, 8)}...`);
    } catch {
      logger.warn(`[Session] Could not load session ${existingSid.slice(0, 8)}..., creating new`);
      const fallbackCwd = sessionManager.current?.cwd || config.vibe.projectDir || lastCwd;
      try {
        const newSid = await sessionManager.createSession(fallbackCwd);
        logger.info(`[Session] Created fallback session ${newSid.slice(0, 8)}...`);
      } catch (err) {
        logger.warn("[Session] Failed to create fallback session:", err);
      }
    }
  } else if (!existingSid && lastCwd) {
    // No remote sessions but we have a persisted cwd — auto-create a session
    try {
      await sessionManager.createSession(lastCwd);
      logger.info(`[Session] Auto-created session at ${lastCwd}`);
    } catch (err) {
      logger.warn("[Session] Failed to auto-create session:", err);
    }
  }

  const bot = await createBot(acpClient, sessionManager, todoManager);

  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    shuttingDown = true;
    removeLock();

    setTimeout(() => {
      logger.warn(`Shutdown timeout (${SHUTDOWN_TIMEOUT_MS}ms), forcing exit.`);
      process.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      bot.stop();
    } catch (err) {
      logger.warn("Failed to stop bot:", err);
    }

    acpClient.stop();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", removeLock);

  await bot.start({
    onStart: (botInfo) => {
      logger.info(`Bot @${botInfo.username} started!`);
      logger.info("Send /start in Telegram to begin.");
    },
  });
}

void main().catch((err) => {
  logger.error("Fatal error:", err);
  removeLock();
  process.exit(1);
});
