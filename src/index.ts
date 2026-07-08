import fs from "node:fs";
import { Bot } from "grammy";
import { config } from "./config.js";
import { setLogLevel, logger } from "./utils/logger.js";
import { AcpClient } from "./acp/client.js";
import { SessionManager } from "./acp/session.js";
import { TodoManager } from "./todo.js";
import { createBot } from "./bot/index.js";
import {
  loadApiKey,
  validateApiKey,
  startSignIn,
  pollAndExchange,
  saveApiKey,
} from "./acp/auth.js";

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

async function ensureValidApiKey(
  onKeyRenewed?: () => void,
): Promise<boolean> {
  const key = loadApiKey();
  if (key) {
    const result = await validateApiKey(key);
    if (result === true) {
      logger.info("[Auth] API key is valid");
      return true;
    }
    if (result === null) {
      logger.warn("[Auth] API key validation skipped (network), proceeding");
      return true;
    }
    logger.warn("[Auth] API key is invalid (rejected by server)");
  }

  logger.warn("[Auth] API key missing or invalid, starting sign-in flow...");

  let signInUrl: string;
  try {
    const attempt = await startSignIn();
    signInUrl = attempt.signInUrl;
  } catch (err) {
    logger.error("[Auth] Failed to start sign-in process:", err);
    return false;
  }

  const authBot = new Bot(config.telegram.token);
  await authBot.api.sendMessage(
    config.telegram.allowedUserId,
    `🔑 Clé API Mistral invalide.\nClique ici pour te reconnecter (valide 10 min) :\n${signInUrl}\n\n⚠️ Tu peux aussi coller une clé API existante ici directement.`,
    { link_preview_options: { is_disabled: true } },
  );

  // Start background polling — don't block startup
  pollAndExchange()
    .then((newKey) => {
      saveApiKey(newKey);
      process.env.MISTRAL_API_KEY = newKey;
      logger.info("[Auth] API key renewed successfully");
      return authBot.api.sendMessage(
        config.telegram.allowedUserId,
        "✅ Clé API renouvelée avec succès ! Redémarrage du service...",
      );
    })
    .then(() => {
      if (onKeyRenewed) onKeyRenewed();
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[Auth] Poll failed: ${msg}`);
      return authBot.api.sendMessage(
        config.telegram.allowedUserId,
        `❌ Renouvellement de clé API impossible : ${msg}\n\n⚠️ Tu peux aussi obtenir une clé manuellement sur https://console.mistral.ai et l'envoyer ici.`,
      );
    });

  return false;
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

      // Reload current session on the new ACP server
      const sid = sessionManager.currentSessionId;
      if (sid) {
        const cwd = sessionManager.current?.cwd || config.vibe.projectDir;
        try {
          await sessionManager.loadSession(sid, cwd);
          logger.info(`[Session] Reloaded after reconnect: ${sid.slice(0, 8)}...`);
        } catch {
          logger.warn(`[Session] Reload failed after reconnect, creating new`);
          await sessionManager.createSession(cwd);
        }
      }
    } catch (err) {
      logger.error("[ACP] Reconnection failed:", err);
    }
  });

  const keyValid = await ensureValidApiKey(async () => {
    // Key was renewed in background — restart ACP to pick it up
    if (!shuttingDown) {
      logger.info("[Auth] Restarting ACP with new API key...");
      acpClient.stop(true);
      await new Promise((r) => setTimeout(r, 1000));
      try {
        await acpClient.start();
        await acpClient.initialize();
        logger.info("[Auth] ACP restarted with new API key");
      } catch (err) {
        logger.error("[Auth] Failed to restart ACP:", err);
      }
    }
  });

  await acpClient.start();

  try {
    await acpClient.initialize();
  } catch (err) {
    logger.warn(`[ACP] Initialization: ${err}`);
    // Continue anyway — prompts will fail with bad key but bot is up for other commands
  }

  // Restore last active session from persisted file
  const saved = await sessionManager.loadLastSession();
  let sessionOk = false;
  if (saved?.sessionId && saved.sessionId.length > 5) {
    try {
      await sessionManager.loadSession(saved.sessionId, saved.cwd);
      logger.info(`[Session] Restored saved session ${saved.sessionId.slice(0, 8)}...`);
      sessionOk = true;
    } catch {
      logger.warn(`[Session] Saved session ${saved.sessionId.slice(0, 8)}... not found on server, creating new`);
    }
  }
  if (!sessionOk) {
    // Try to restore the most recent remote session
    try {
      const { sessions } = await sessionManager.listSessions();
      const last = sessions[sessions.length - 1];
      if (last) {
        const dir = last.cwd || config.vibe.projectDir;
        try {
          await sessionManager.loadSession(last.sessionId, dir);
          logger.info(`[Session] Restored most recent remote session ${last.sessionId.slice(0, 8)}... at ${dir}`);
          sessionOk = true;
        } catch {
          logger.warn(`[Session] Remote session ${last.sessionId.slice(0, 8)}... not loadable, creating new`);
        }
      }
    } catch {
      logger.warn("[Session] listSessions failed, creating fresh session");
    }
  }
  if (!sessionOk) {
    try {
      await sessionManager.createSession(config.vibe.projectDir);
      logger.info("[Session] Created fresh session");
    } catch (err2) {
      logger.error("[Session] Failed to create session:", err2);
    }
  }
  // Sync remote sessions for /sessions listing (best-effort)
  sessionManager.syncRemoteSessions().catch(() => {});

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
