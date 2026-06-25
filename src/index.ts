import { config } from "./config.js";
import { setLogLevel, logger } from "./utils/logger.js";
import { AcpClient } from "./acp/client.js";
import { SessionManager } from "./acp/session.js";
import { TodoManager } from "./todo.js";
import { createBot } from "./bot/index.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  setLogLevel(config.server.logLevel);

  logger.info("Starting Vibe Telegram Bot...");
  logger.info(`Allowed User ID: ${config.telegram.allowedUserId}`);
  logger.info(`Project directory: ${config.vibe.projectDir}`);

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

  const bot = await createBot(acpClient, sessionManager, todoManager);

  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    shuttingDown = true;

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

  await bot.start({
    onStart: (botInfo) => {
      logger.info(`Bot @${botInfo.username} started!`);
      logger.info("Send /start in Telegram to begin.");
    },
  });
}

void main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
