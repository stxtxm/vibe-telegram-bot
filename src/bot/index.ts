import { Bot, type Context, InlineKeyboard, InputFile, Keyboard } from "grammy";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { promises as fs } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import type { AcpClient } from "../acp/client.js";
import { SessionManager, type SessionState } from "../acp/session.js";
import { TodoManager } from "../todo.js";
import {
  loadApiKey,
  validateApiKey,
  startSignIn,
  pollAndExchange,
  saveApiKey,
} from "../acp/auth.js";

const MAX_PROMPT_RETRIES = 1;

// Patterns for API errors that should be retried
const RETRYABLE_ERRORS = [
  "PoolTimeout",
  "API error",
  "Network error",
  "Connection error",
  "incomplete chunked read",
  "peer closed connection",
  "chunked",
  "RPC -32603",
];

const TOOL_EMOJI: Record<string, string> = {
  read: "📖", write: "✍️", edit: "✏️", bash: "💻",
  grep: "🔍", search: "🔍", glob: "📁", file: "📄",
  task: "🤖", question: "❓", webfetch: "🌐", skill: "🎓",
  todoread: "📋", todowrite: "📝", apply_patch: "🩹",
};
import {
  buildModelMenu, buildModeMenu, buildThinkingMenu, buildSessionList, buildQuestionMenu,
  isModelSelect, isModeSelect, isThinkingSelect, isSessionSelect, isSessionPage, isMenuCancel, isFileAction, isQuestionSelect,
  parseModelData, parseModeData, parseThinkingData, parseSessionSelect, parseSessionPage, parseQuestionData,
} from "./menus.js";
import { KeyboardManager } from "./keyboard.js";
import { ResponseStreamer } from "./stream.js";
import {
  parseFileAction,
  buildFileMenu,
  changeDirectory,
  getFileContent,
  type FileAction,
} from "./files.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function restartAcp(acpClient: AcpClient, sessionManager: SessionManager): Promise<boolean> {
  acpClient.stop(true);
  await sleep(1000);
  await acpClient.start();
  // initialize is idempotent (skip if already done by disconnectHandler)
  try {
    await acpClient.initialize();
  } catch {
    // ACP crashed — wait for disconnectHandler auto-restart (max 12s)
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      await sleep(500);
      if (acpClient.isConnected()) break;
    }
    if (!acpClient.isConnected()) return false;
    // disconnectHandler may have already called initialize — skip if so
    try {
      await acpClient.initialize();
    } catch {
      return false;
    }
  }
  // Reload session on the new ACP server
  const sid = sessionManager.currentSessionId;
  if (sid) {
    const cwd = sessionManager.current?.cwd || config.vibe.projectDir;
    try {
      await sessionManager.loadSession(sid, cwd);
    } catch {
      await sessionManager.createSession(cwd);
    }
  }
  return true;
}

export async function createBot(acpClient: AcpClient, sessionManager: SessionManager, todoManager?: TodoManager): Promise<Bot<Context>> {
  const bot = new Bot(config.telegram.token);

  let busy = false;
  let progressChatId: number | null = null;
  let progressMessageId: number | null = null;
  let progressText = "";
  let toolCallMap = new Map<string, { name: string; kind: string; input?: Record<string, unknown> }>();
  let promptGeneration = 0;

  // Streaming state (Phase 1a/1b/2) — managed by ResponseStreamer
  const responseStreamer = new ResponseStreamer(bot, config.telegram.allowedUserId);
  let promptStartTime = 0;

  // Original user message ID (for replying to)
  let originalUserMessageId: number | null = null;

  // Pinned status message (Phase 3a)
  let pinnedMessageId: number | null = null;

  // Tool call tracking for pinned message (mutable references for handleAcpNotification)
  const changedFiles = new Set<string>();
  const toolCountWrapper = { n: 0 };

  // Active question state
  let activeQuestion: { sessionId: string; questionIndex: number; options: string[]; messageId: number | null } | null = null;

  // Pending file upload state
  let pendingUpload: string | null = null;

  // Context metrics (from ACP stderr)
  let contextChars = 0;
  let contextMessages = 0;

  // Flag to suppress streaming notifications during auto-compact
  let isCompacting = false;

  // Permission state
  let pendingPermission: { id: number; sessionId: string } | null = null;
  let permissionTimeout: ReturnType<typeof setTimeout> | null = null;

  function startTypingInterval(chatId: number): () => void {
    const interval = setInterval(() => {
      bot.api.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);
    bot.api.sendChatAction(chatId, "typing").catch(() => {});
    return () => clearInterval(interval);
  }

  async function replyWithHtml(chatId: number, text: string, extra?: Record<string, unknown>): Promise<{ message_id: number }> {
    try {
      return await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", ...extra } as never);
    } catch {
      return await bot.api.sendMessage(chatId, text, extra as never);
    }
  }

  async function editWithHtml(chatId: number, messageId: number, text: string, extra?: Record<string, unknown>): Promise<void> {
    try {
      await bot.api.editMessageText(chatId, messageId, text, { parse_mode: "HTML", ...extra } as never);
    } catch {
      try { await bot.api.editMessageText(chatId, messageId, text, extra as never); } catch { /* ignore */ }
    }
  }

  async function updatePinnedMessage(): Promise<void> {
    const chatId = config.telegram.allowedUserId;
    const sid = sessionManager.currentSessionId;
    if (!sid) return;
    const session = sessionManager.getSession(sid);
    if (!session) return;
    keyboardManager.updateCwd(session.cwd || config.vibe.projectDir);
    keyboardManager.updateModel(session.models?.currentModelId || "?");
    keyboardManager.updateMode(session.modes?.currentModeId || "?");

    const model = session.models?.currentModelId || "?";
    const mode = session.modes?.currentModeId || "?";
    const cwd = session.cwd || "?";
    const title = session.title || sid.slice(0, 8);
    const busyIcon = busy ? "🔴" : "🟢";
    const thinking = session.configOptions?.find((o) => o.id === "thinking")?.currentValue || "?";
    const usage = responseStreamer.usage;

    const lines: string[] = [
      `📌 **Session** — ${escapeMarkdown(title)}`,
      `🎯 Model: \`${escapeMarkdown(model)}\`  ⚙️ Mode: \`${escapeMarkdown(mode)}\`  💭 \`${thinking}\``,
      `📍 \`${escapeMarkdown(cwd)}\``,
    ];

    if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
      lines.push(`📊 ${usage.inputTokens}→${usage.outputTokens} tok${usage.cost > 0 ? `  💰 $${usage.cost.toFixed(4)}` : ""}`);
    }

    // Context metrics from ACP stderr
    contextChars = acpClient.contextChars;
    contextMessages = acpClient.contextMessages;
    if (contextChars > 0) {
      let ctxLine = `📐 ${(contextChars / 1000).toFixed(0)}K chars`;
      if (contextMessages > 0) ctxLine += ` · ${contextMessages} msg`;
      lines.push(ctxLine);
    }

    if (toolCountWrapper.n > 0) {
      let info = `🛠️ ${toolCountWrapper.n} tool${toolCountWrapper.n !== 1 ? "s" : ""}`;
      if (changedFiles.size > 0) {
        info += `  📄 ${changedFiles.size} file${changedFiles.size !== 1 ? "s" : ""}`;
      }
      lines.push(info);
    }

    lines.push(`${busyIcon} ${busy ? "Busy…" : "Idle"}`);

    const text = lines.join("\n");

    if (pinnedMessageId !== null) {
      try {
        await bot.api.editMessageText(chatId, pinnedMessageId, text, { parse_mode: "Markdown" });
        return;
      } catch {
        // Message was likely unpinned — re-send
        pinnedMessageId = null;
      }
    }

    try {
      const msg = await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown", disable_notification: true });
      pinnedMessageId = msg.message_id;
    } catch (e) {
      logger.warn("[Pinned] Failed to create pinned message:", e);
    }
  }

  // Persistent reply keyboard (Phase 3c)
  const keyboardManager = new KeyboardManager(bot, config.telegram.allowedUserId);
  function getKeyboard(): Keyboard {
    return keyboardManager.getKeyboard();
  }

  // === AUTH MIDDLEWARE ===
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery) {
      logger.info(`[Middleware] callbackQuery data="${ctx.callbackQuery.data}"`);
    }
    if (ctx.from?.id !== config.telegram.allowedUserId) {
      logger.warn(`[Auth] Rejected ${ctx.from?.id}`);
      return;
    }
    await next();
  });

  // === COMMANDS ===
  bot.api.setMyCommands([
    { command: "start", description: "Create a Vibe session" },
    { command: "model", description: "Switch AI model" },
    { command: "mode", description: "Switch agent mode" },
    { command: "thinking", description: "Set thinking budget" },
    { command: "sessions", description: "List and switch sessions" },
    { command: "files", description: "Browse files in current directory" },
    { command: "cd", description: "Change working directory" },
    { command: "pwd", description: "Show current working directory" },
    { command: "close", description: "Close current session" },
    { command: "abort", description: "Abort the current prompt" },
    { command: "rename", description: "Rename session" },
    { command: "status", description: "Show session info" },
    { command: "compact", description: "Compress conversation context" },
    { command: "todo", description: "Manage todo list" },
    { command: "help", description: "Show help" },
    { command: "reauth", description: "Reconnect Mistral API key" },
    { command: "setkey", description: "Set Mistral API key manually" },
  ]);

  bot.command("start", wrap(startHandler(sessionManager)));
  bot.command("model", modelHandler(sessionManager));
  bot.command("mode", modeHandler(sessionManager));
  bot.command("thinking", thinkingHandler(sessionManager));
  bot.command("sessions", sessionsHandler(sessionManager));
  bot.command("files", filesHandler(sessionManager));
  bot.command("cd", wrap(cdHandler(sessionManager)));
  bot.command("pwd", pwdHandler(sessionManager));
  bot.command("close", closeHandler(acpClient, sessionManager));
  bot.command("abort", abortHandler(
    acpClient, sessionManager, 
    () => busy, 
    (v) => { busy = v; },
    (v) => { progressChatId = v; },
    (v) => { progressMessageId = v; },
    (v) => { progressText = v; },
    (v) => { toolCallMap = v; },
    () => permissionTimeout,
    (v) => { permissionTimeout = v; },
    () => { pendingPermission = null; },
  ));
  bot.command("rename", wrap(renameHandler(acpClient, sessionManager)));
  bot.command("status", statusHandler(sessionManager, () => pendingPermission, () => busy));
  bot.command("compact", wrap(compactHandler(acpClient, sessionManager)));
  bot.command("todo", todoHandler(todoManager));
  bot.command("help", helpHandler);
  bot.command("reauth", reauthHandler(acpClient, sessionManager));
  bot.command("setkey", setkeyHandler(acpClient, sessionManager));

  // Wraps a handler to update the pinned message after completion
  function wrap(handler: (ctx: Context) => Promise<void>): (ctx: Context) => Promise<void> {
    return async (ctx: Context) => {
      await handler(ctx);
      await updatePinnedMessage();
    };
  }

  // === TEXT MESSAGE HANDLER (prompts + API key injection) ===
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    // If message looks like a Mistral API key (~32 alphanumeric chars), save and restart
    if (/^[A-Za-z0-9_-]{20,50}$/.test(text.trim())) {
      const key = text.trim();
      try {
        const valid = await validateApiKey(key);
        if (valid === false) {
          await ctx.reply("❌ Clé API invalide. Vérifie la clé et réessaie.");
          return;
        }
        await ctx.reply("✅ Clé API valide ! Enregistrement et redémarrage...");
        saveApiKey(key);
        process.env.MISTRAL_API_KEY = key;
        logger.info("[Auth] API key updated via chat message");

        const restartOk = await restartAcp(acpClient, sessionManager);
        if (restartOk) {
          await ctx.reply("✅ Service redémarré avec la nouvelle clé !");
        } else {
          logger.warn("[Auth] ACP restart failed after key paste");
          await ctx.reply("⚠️ Redémarrage impossible. Le service va réessayer automatiquement.");
        }
        return;
      } catch {
        await ctx.reply("⚠️ Vérification réseau impossible. On utilise la clé quand même.");
        saveApiKey(key);
        process.env.MISTRAL_API_KEY = key;
        logger.info("[Auth] API key saved via chat message (validation skipped due to network)");

        const restartOk = await restartAcp(acpClient, sessionManager);
        if (restartOk) {
          await ctx.reply("✅ Service redémarré avec la nouvelle clé !");
        } else {
          logger.warn("[Auth] ACP restart failed after key paste (catch)");
          await ctx.reply("⚠️ Redémarrage impossible. Le service va réessayer automatiquement.");
        }
        return;
      }
    }

    const sid = sessionManager.currentSessionId;
    if (!sid) { await ctx.reply("No session. Use /start."); return; }

    // Cancel any running prompt and start fresh
    if (busy) {
      // Send accumulated progress before canceling
      if (progressText) {
        ctx.reply(`📝 **Accumulé avant annulation:**\n\n${progressText.slice(0, 2000)}`).catch(() => {});
      }
      if (pendingPermission) {
        logger.info(`[Permission] Auto-rejected id=${pendingPermission.id} (new prompt)`);
        if (permissionTimeout) { clearTimeout(permissionTimeout); permissionTimeout = null; }
        acpClient.respondPermissionError(pendingPermission.id);
        pendingPermission = null;
      }
      acpClient.cancelPrompt(sid);
    }

    const generation = ++promptGeneration;
    busy = true;
    progressText = "";
    toolCallMap = new Map();
    changedFiles.clear();
    toolCountWrapper.n = 0;
    promptStartTime = Date.now();
    updatePinnedMessage();

    // Start response streamer (creates the progress message with abort button)
    progressMessageId = await responseStreamer.start(generation, ctx.message.message_id);
    progressChatId = ctx.chat.id;
    const stopTyping = startTypingInterval(ctx.chat.id);

    runPrompt(acpClient, ctx, sid, generation, stopTyping).catch((err) => {
      logger.error("[Prompt] Background error:", err);
    });
  });

  // === FILE UPLOAD HANDLER ===
  bot.on("message:document", async (ctx) => {
    const sid = sessionManager.currentSessionId;
    if (!sid) { await ctx.reply("No session. Use /start."); return; }

    const file = ctx.message.document;
    const fileName = file.file_name || `document_${Date.now()}`;
    const fileSize = file.file_size || 0;

    // Max 20MB
    if (fileSize > 20 * 1024 * 1024) {
      await ctx.reply("❌ Fichier trop volumineux (max 20MB)");
      return;
    }

    try {
      const fileInfo = await bot.api.getFile(file.file_id);
      if (!fileInfo.file_path) {
        await ctx.reply("❌ Impossible de récupérer le fichier");
        return;
      }

      const url = `https://api.telegram.org/file/bot${config.telegram.token}/${fileInfo.file_path}`;
      const ext = fileName.includes(".") ? "" : ".bin";
      const destPath = join(process.cwd(), "data", "uploads", `${Date.now()}_${fileName}${ext}`);
      await fs.mkdir(dirname(destPath), { recursive: true });

      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(destPath, buffer);

      pendingUpload = destPath;
      await ctx.reply(
        `📄 Fichier reçu : \`${escapeMarkdown(fileName)}\` (${formatFileSizeStatic(fileSize)})\n📍 Sauvegardé dans le projet.\n📝 Envoie maintenant un message pour dire à Vibe quoi en faire.`,
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      logger.error("[Upload] Failed:", err);
      await ctx.reply(`❌ Erreur lors du téléchargement: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  async function runPrompt(acpClient: AcpClient, ctx: Context, sid: string, generation: number, stopTyping?: () => void, retry = 0) {
    const text = ctx.message?.text;
    if (!text) return;
    // Clean up input text — trim whitespace, collapse excessive newlines
    const cleanText = text.trim().replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '');
    let effectiveText = cleanText;
    if (pendingUpload) {
      const relPath = pendingUpload.startsWith(config.vibe.projectDir)
        ? pendingUpload.slice(config.vibe.projectDir.length + 1)
        : pendingUpload;
      effectiveText = `[File uploaded to ${relPath}]\n\n${cleanText}`;
      pendingUpload = null;
    }
    let recovered = false;
    try {
      // Auto-compact if context exceeds threshold
      const AUTO_COMPACT_THRESHOLD = 50_000;
      if (acpClient.contextChars > AUTO_COMPACT_THRESHOLD) {
        logger.info(`[Compact] Auto-compact triggered: ${acpClient.contextChars} chars > ${AUTO_COMPACT_THRESHOLD}`);
        isCompacting = true;
        await acpClient.sendPrompt(sid,
          "Compact/compress the conversation history above into a short concise summary, " +
          "preserving all decisions, code changes, and important context. Output only the summary."
        );
        isCompacting = false;
        await new Promise(r => setTimeout(r, 1500));
      }
      const result = await acpClient.sendPrompt(sid, effectiveText) as Record<string, unknown> | undefined;

      // Stale — a newer prompt has superseded this one
      if (generation < promptGeneration) {
        logger.debug(`[Prompt] Stale generation ${generation} < ${promptGeneration}, ignoring result`);
        return;
      }

      // Finalize stream with footer
      const toolSummary = buildToolSummary(toolCallMap);
      const duration = Date.now() - promptStartTime;
      const durationStr = duration > 60_000
        ? `${Math.floor(duration / 60_000)}m ${Math.floor((duration % 60_000) / 1000)}s`
        : `${Math.floor(duration / 1000)}s`;

      await responseStreamer.finalize(toolSummary, durationStr);

      // Phase 3b: upload written files as documents
      if (progressChatId) {
        const writtenFiles = new Set<string>();
        for (const [, v] of toolCallMap) {
          if ((v.kind === "write" || v.name === "write_file" || v.name === "write") && v.input?.filePath) {
            writtenFiles.add(v.input.filePath as string);
          }
        }
        for (const fp of writtenFiles) {
          try {
            const inputFile = new InputFile(fp);
            await bot.api.sendDocument(progressChatId, inputFile, {
              caption: `📄 \`${escapeMarkdown(fp)}\``,
              parse_mode: "Markdown",
            }).catch(() => {});
          } catch {
            logger.debug("[Upload] Failed to upload file:", fp);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Stale — a newer prompt has superseded this one
      if (generation < promptGeneration) {
        logger.debug(`[Prompt] Stale generation ${generation} < ${promptGeneration}, ignoring`);
        return;
      }

      // Send accumulated progress before error message
      if (progressText) {
        for (const chunk of splitMessage(progressText.slice(0, 4000))) {
          await replyWithFallback(ctx, `📝 **Progression avant erreur:**\n\n${chunk}`);
        }
      }

      // Update status message to show error
      if (progressChatId && progressMessageId) {
        bot.api.editMessageText(progressChatId, progressMessageId, "❌ **Erreur**").catch(() => {});
      }

      const stderr = acpClient.getRecentStderr?.() || "";
      if (stderr) logger.warn("[Bot] ACP stderr during error:\n" + stderr.slice(-1000));

      // Check auth FIRST — not retryable, immediate user-facing message
      const isAuthError = msg.toLowerCase().includes("invalid key") || msg.toLowerCase().includes("invalid api") || msg.toLowerCase().includes("authorization") || msg.toLowerCase().includes("401") || msg.toLowerCase().includes("unauthorized") || msg.toLowerCase().includes("forbidden");
      if (isAuthError) {
        logger.error("[Bot] Auth error:", msg);
        await ctx.reply(
          "❌ Erreur d'authentification.\n\n" +
          "Crée une nouvelle clé : https://console.mistral.ai\n" +
          "Puis `/setkey <ta_clé>`",
          { parse_mode: "Markdown" },
        );
        return;
      }

      // API error — retry with backoff (PoolTimeout, network errors, etc.)
      const isRetryable = retry < MAX_PROMPT_RETRIES && RETRYABLE_ERRORS.some(e => msg.includes(e) || stderr.includes(e));
      if (isRetryable) {
        responseStreamer.abort();
        progressText = "";
        toolCallMap = new Map();
        changedFiles.clear();
        await responseStreamer.start(generation, ctx.message.message_id);
        const backoff = 1000 * (1 + retry);
        await ctx.reply(`🔄 **Erreur API** (PoolTimeout). Nouvelle tentative dans ${backoff / 1000}s... (tentative ${retry + 1}/${MAX_PROMPT_RETRIES})`);
        await new Promise(r => setTimeout(r, backoff));
        recovered = true;
        effectiveText = `[retry after timeout]\n\n${effectiveText}`;
        await runPrompt(acpClient, ctx, sid, generation, stopTyping, retry + 1);
        return;
      }

      // Session not found — try to reload from disk, then create new if that fails
      if (msg.includes("Session not found")) {
        const lastCwd = sessionManager.current?.cwd || config.vibe.projectDir;
        try {
          await sessionManager.loadSession(sid, lastCwd);
          // The loadSession may replay old agent_message_chunk notifications into
          // the streamer — kill the stale stream and start fresh for the retry
          responseStreamer.abort();
          progressText = "";
          toolCallMap = new Map();
          changedFiles.clear();
          await responseStreamer.start(generation, ctx.message.message_id);
          await ctx.reply(`🔄 Session rechargée. Je relance...`);
          recovered = true;
          await runPrompt(acpClient, ctx, sid, generation, stopTyping, retry + 1);
          return;
        } catch (loadErr) {
          logger.warn(`[Bot] Session ${sid.slice(0, 8)}... load failed, creating new:`, loadErr);
        }
        try {
          const newSid = await sessionManager.createSession(lastCwd);
          responseStreamer.abort();
          progressText = "";
          toolCallMap = new Map();
          changedFiles.clear();
          await responseStreamer.start(generation, ctx.message.message_id);
          await ctx.reply(`🔄 Nouvelle session créée. Je relance...`);
          recovered = true;
          await runPrompt(acpClient, ctx, newSid, generation, stopTyping, retry + 1);
          return;
        } catch (createErr) {
          logger.error("[Bot] Session recovery failed:", createErr);
          await ctx.reply("❌ Session expirée et impossible d'en créer une nouvelle");
        }
      } else {
        logger.error("[Bot] Prompt error:", msg);
        await ctx.reply(`❌ ${msg}`);
      }
    } finally {
      stopTyping?.();
      if (!recovered && generation >= promptGeneration) {
        busy = false;
        progressChatId = null;
        progressMessageId = null;
        keyboardManager.flushKeyboard();
      }
      updatePinnedMessage();
    }
  }

  const PERMISSION_FEEDBACK: Record<string, string> = {
    "allow_once": "✅ Autorisé une fois",
    "allow_always": "🔁 Toujours autorisé",
    "once": "✅ Autorisé une fois",
    "always": "🔁 Toujours autorisé",
    "deny": "❌ Refusé",
    "reject": "❌ Refusé",
    "cancel": "❌ Refusé",
    "allow": "✅ Autorisé",
  };

  let alwaysAllowedSet = new Set<string>();

  // === CALLBACK QUERY HANDLER ===
  // Handle ALL callback queries with regex catcher
  bot.callbackQuery(/.*/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const data = ctx.callbackQuery.data;
    logger.info(`[Callback] data="${data}" user=${ctx.from?.id}`);
    const sid = sessionManager.currentSessionId;

    // Abort prompt
    if (data.startsWith("abort:")) {
      const gen = parseInt(data.split(":")[1], 10);
      if (busy && gen > 0 && gen <= promptGeneration) {
        if (sid) acpClient.cancelPrompt(sid);
        if (pendingPermission) {
          if (permissionTimeout) { clearTimeout(permissionTimeout); permissionTimeout = null; }
          acpClient.respondPermissionError(pendingPermission.id);
          pendingPermission = null;
        }
        // Abort the streamer (sets progress to cancelled)
        responseStreamer.abort();
        if (progressText) {
          await ctx.reply(`📝 **Accumulé avant annulation:**\n\n${progressText.slice(0, 2000)}`);
        }
        await ctx.editMessageText("⏹️ Annulé").catch(() => {});
        busy = false;
        updatePinnedMessage();
      } else {
        await ctx.editMessageText("✅ Déjà terminé").catch(() => {});
      }
      return;
    }

    // Permission response
    if (data.startsWith("perm:")) {
      const parts = data.split(":");
      if (parts.length === 3) {
        const [_, idStr, optionId] = parts;
        const permId = parseInt(idStr, 10);
        if (pendingPermission && permId === pendingPermission.id) {
          if (permissionTimeout) { clearTimeout(permissionTimeout); permissionTimeout = null; }
          await ctx.answerCallbackQuery().catch(() => {});
          try {
            logger.info(`[Permission] Responding id=${permId} option=${optionId}`);
            await acpClient.respondPermission(pendingPermission.id, optionId);
            const feedback = PERMISSION_FEEDBACK[optionId] || `✅ ${optionId}`;
            await ctx.editMessageText(feedback);
            if (optionId === "allow_always" || optionId === "always") {
              alwaysAllowedSet.add(`perm:${pendingPermission.sessionId}:${optionId}`);
              logger.info(`[Permission] Always allowed set, total=${alwaysAllowedSet.size}`);
            }
          } catch (err) {
            await ctx.editMessageText(`❌ ${err}`).catch(() => {});
          }
          pendingPermission = null;
        } else {
          logger.warn(`[Permission] Expired or mismatched: got id=${permId} expected=${pendingPermission?.id}`);
          await ctx.answerCallbackQuery({ text: "⏳ Expiré, envoie un message" }).catch(() => {});
        }
        return;
      }
      logger.warn(`[Permission] Malformed callback data: "${data}"`);
      await ctx.answerCallbackQuery({ text: "Action invalide" }).catch(() => {});
      return;
    }

    if (isMenuCancel(data)) {
      await ctx.deleteMessage();
      return;
    }

    if (isModelSelect(data)) {
      if (!sid) { await ctx.answerCallbackQuery({ text: "No session" }).catch(() => {}); return; }
      await ctx.answerCallbackQuery().catch(() => {});
      const modelId = parseModelData(data);
      try {
        await sessionManager.setModel(sid, modelId);
        await ctx.editMessageText(`✅ Model: \`${modelId}\``, { parse_mode: "Markdown" });
        keyboardManager.updateModel(modelId);
        keyboardManager.refreshKeyboard();
        updatePinnedMessage();
      } catch (err) {
        await ctx.editMessageText(`❌ ${err}`).catch(() => {});
      }
      return;
    }

    if (isModeSelect(data)) {
      if (!sid) { await ctx.answerCallbackQuery({ text: "No session" }).catch(() => {}); return; }
      await ctx.answerCallbackQuery().catch(() => {});
      const modeId = parseModeData(data);
      try {
        await sessionManager.setMode(sid, modeId);
        await ctx.editMessageText(`✅ Mode: \`${modeId}\``, { parse_mode: "Markdown" });
        keyboardManager.updateMode(modeId);
        keyboardManager.refreshKeyboard();
        updatePinnedMessage();
      } catch (err) {
        await ctx.editMessageText(`❌ ${err}`).catch(() => {});
      }
      return;
    }

    if (isThinkingSelect(data)) {
      if (!sid) { await ctx.answerCallbackQuery({ text: "No session" }).catch(() => {}); return; }
      await ctx.answerCallbackQuery().catch(() => {});
      const level = parseThinkingData(data);
      try {
        await sessionManager.setConfigOption(sid, "thinking", level);
        await ctx.editMessageText(`💭 Thinking: \`${level}\``, { parse_mode: "Markdown" });
        updatePinnedMessage();
      } catch (err) {
        await ctx.editMessageText(`❌ ${err}`).catch(() => {});
      }
      return;
    }

    if (isSessionPage(data)) {
      const page = parseSessionPage(data);
      await ctx.answerCallbackQuery().catch(() => {});
      try {
        const result = await sessionManager.listSessions();
        const menu = buildSessionList(result.sessions, page);
        await ctx.editMessageText(menu.text, {
          parse_mode: "Markdown",
          reply_markup: menu.keyboard,
        });
      } catch (err) {
        await ctx.editMessageText(`❌ ${err}`).catch(() => {});
      }
      return;
    }

    if (isSessionSelect(data)) {
      const selectSid = parseSessionSelect(data);
      await ctx.answerCallbackQuery().catch(() => {});
      const s = sessionManager.getSession(selectSid);
      try {
        if (s) {
          sessionManager.currentSessionId = selectSid;
          const title = s.title || selectSid.slice(0, 8);
          await ctx.editMessageText(`✅ Switched to session \`${title}\``, { parse_mode: "Markdown" });
          updatePinnedMessage();
        } else {
          await ctx.editMessageText("Session not found locally. Use /start to create a new one.");
        }
      } catch (err) {
        await ctx.editMessageText(`❌ ${err}`).catch(() => {});
      }
      return;
    }

    // File navigation callbacks
    if (isFileAction(data)) {
      const action = parseFileAction(data);
      if (!action) {
        await ctx.answerCallbackQuery({ text: "Invalid file action" }).catch(() => {});
        return;
      }

      await handleFileCallback(
        action,
        ctx,
        sessionManager,
        acpClient,
        (menu) => ctx.editMessageText(menu.text, {
          parse_mode: "Markdown",
          reply_markup: menu.keyboard,
        }),
        (msg) => ctx.answerCallbackQuery({ text: msg }).catch(() => {}),
        (msg) => ctx.reply(msg, { parse_mode: "Markdown" })
      );
      return;
    }

    // Question response
    if (isQuestionSelect(data)) {
      const { questionIndex, optionIndex } = parseQuestionData(data);
      if (!activeQuestion || activeQuestion.questionIndex !== questionIndex) {
        await ctx.answerCallbackQuery({ text: "⏳ Question expirée" }).catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery().catch(() => {});
      const answerText = activeQuestion.options[optionIndex];
      if (answerText && activeQuestion.sessionId) {
        logger.info(`[Question] Answering idx=${optionIndex} with "${answerText}"`);
        acpClient.sendPrompt(activeQuestion.sessionId, answerText).catch((err) => {
          logger.error("[Question] Failed to send answer:", err);
        });
      }
      await ctx.editMessageText(`✅ ${answerText}`).catch(() => {});
      activeQuestion = null;
      return;
    }

    await ctx.answerCallbackQuery({ text: "Unknown action" }).catch(() => {});
    logger.warn(`[Callback] Unhandled callback data="${data}"`);
  });

  // === ACP NOTIFICATIONS ===
  acpClient.onMessage((msg) => {
    handleAcpNotification(msg, bot, acpClient, () => progressChatId, () => progressMessageId, (id) => { progressMessageId = id; },     (t) => { progressText += t; }, () => { return progressText; }, () => {
      responseStreamer.setToolSummary(buildToolSummary(toolCallMap));
    }, (p) => {
      // Clear previous timeout
      if (permissionTimeout) { clearTimeout(permissionTimeout); permissionTimeout = null; }
      pendingPermission = p;
      // Auto-reject after 10 minutes if user doesn't respond
      if (p) {
        logger.info(`[Permission] Started timeout for id=${p.id}`);
        permissionTimeout = setTimeout(() => {
          if (pendingPermission && pendingPermission.id === p.id) {
            logger.warn(`[Permission] Timeout for id=${p.id}, auto-rejecting`);
            const chatId = config.telegram.allowedUserId;
            bot.api.sendMessage(chatId, `⏳ Permission #${p.id} expirée (délai dépassé)`).catch(() => {});
            acpClient.respondPermissionError(p.id);
            pendingPermission = null;
          }
          permissionTimeout = null;
        }, 600_000); // 10 minutes
      }
    }, toolCallMap, changedFiles, toolCountWrapper, (sessionId: string, questionText: string, options: string[]) => {
      // Interactive question — show inline menu
      const menu = buildQuestionMenu(Date.now(), questionText, options);
      const chatId = config.telegram.allowedUserId;
      bot.api.sendMessage(chatId, menu.text, { parse_mode: "Markdown", reply_markup: menu.keyboard }).catch(() => {});
      activeQuestion = { sessionId, questionIndex: Date.now(), options, messageId: null };
    }, (text) => {
      if (isCompacting) return;
      responseStreamer.contextChars = acpClient.contextChars;
      responseStreamer.appendResponse(text);
    }, (text) => {
      if (isCompacting) return;
      responseStreamer.contextChars = acpClient.contextChars;
      responseStreamer.appendThinking(text);
    }, (usage) => {
      responseStreamer.setUsage(usage);
      keyboardManager.updateUsage(usage.inputTokens, usage.outputTokens, usage.cost);
      keyboardManager.refreshKeyboard();
    }, (summary) => {
      responseStreamer.setToolSummary(summary);
    }, (icon, label) => {
      responseStreamer.addToolEntry(icon, label);
    }).catch((err) => {
      logger.error("[Bot] notification error:", err);
    });
  });

  // === GLOBAL ERROR HANDLER ===
  bot.catch((err) => {
    logger.error("[Bot] Unhandled error:", err.error ?? err);
  });

  // Create startup pinned message (fire-and-forget)
  updatePinnedMessage();

  return bot;
}

// === FILE NAVIGATION HANDLERS ===

function filesHandler(sm: SessionManager) {
  return async (ctx: Context) => {
    const sid = sm.currentSessionId;
    if (!sid) {
      await ctx.reply("No active session. Use /start.");
      return;
    }

    const session = sm.getSession(sid);
    if (!session) {
      await ctx.reply("Session not found. Use /start.");
      return;
    }

    const currentPath = session.cwd || config.vibe.projectDir;
    try {
      const menu = await buildFileMenu(currentPath, 0, sid);
      await ctx.reply(menu.text, {
        parse_mode: "Markdown",
        reply_markup: menu.keyboard,
      });
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

function cdHandler(sm: SessionManager) {
  return async (ctx: Context) => {
    const sid = sm.currentSessionId;
    if (!sid) {
      await ctx.reply("No active session. Use /start.");
      return;
    }

    const text = ctx.message?.text?.trim() || '';
    const pathArg = text.replace('/cd', '').trim();

    // If no path provided, open file browser menu
    if (!pathArg) {
      const session = sm.getSession(sid);
      if (!session) {
        await ctx.reply("Session not found. Use /start.");
        return;
      }
      const currentPath = session.cwd || config.vibe.projectDir;
      try {
        const menu = await buildFileMenu(currentPath, 0, sid);
        await ctx.reply(menu.text, {
          parse_mode: "Markdown",
          reply_markup: menu.keyboard,
        });
      } catch (err) {
        await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // Otherwise, change directory as before
    try {
      const newPath = await changeDirectory(sm, sid, pathArg);
      await ctx.reply(`✅ Changed directory to \`${newPath}\``, { parse_mode: "Markdown" });
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`, { parse_mode: "Markdown" });
    }
  };
}

function pwdHandler(sm: SessionManager) {
  return async (ctx: Context) => {
    const sid = sm.currentSessionId;
    if (!sid) {
      await ctx.reply("No active session. Use /start.");
      return;
    }

    const session = sm.getSession(sid);
    if (!session) {
      await ctx.reply("Session not found.");
      return;
    }

    const currentPath = session.cwd || config.vibe.projectDir;
    await ctx.reply(`📍 Current directory:\n\`${currentPath}\``, { parse_mode: "Markdown" });
  };
}

async function handleFileCallback(
  action: FileAction,
  ctx: Context,
  sm: SessionManager,
  acpClient: AcpClient,
  editMessage: (menu: { text: string; keyboard: InlineKeyboard }) => Promise<unknown>,
  answerCallback: (text: string) => Promise<unknown>,
  sendMessage: (text: string) => Promise<unknown>,
) {
  const { action: act, path, sessionId: sid, page = 0 } = action;
  const effectiveSid = sid || sm.currentSessionId;

  // Answer immediately so Telegram doesn't show a spinner
  await ctx.answerCallbackQuery().catch(() => {});

  if (!effectiveSid && act !== 'cancel' && act !== 'back') {
    return;
  }

  try {
    switch (act) {
      case 'dir':
      case 'parent': {
        const menu = await buildFileMenu(path, 0, effectiveSid || undefined);
        await editMessage(menu);
        break;
      }

      case 'page': {
        const menu = await buildFileMenu(path, page, effectiveSid || undefined);
        await editMessage(menu);
        break;
      }

      case 'set_cwd': {
        if (!effectiveSid) { return; }
        const session = sm.getSession(effectiveSid);
        if (!session) { return; }
        const stats = await fs.stat(path);
        if (!stats.isDirectory()) { return; }
        await sm.updateCwd(effectiveSid, path);
        acpClient.setConfigOption(effectiveSid, 'cwd', path).catch(() => {});
        await ctx.deleteMessage().catch(() => {});
        await ctx.reply(`✅ Session directory changed to \`${path}\``, { parse_mode: "Markdown" });
        break;
      }

      case 'view': {
        const content = await getFileContent(path);
        const fileName = basename(path);
        const preview = content.length > 3000
          ? content.slice(0, 3000) + '\n\n... (file truncated)'
          : content;
        await sendMessage(`📄 **${fileName}**\n\`\`\`\n${preview}\n\`\`\``);
        await answerCallback(`Showing ${fileName}`);
        break;
      }

      case 'cancel':
      case 'back':
        await ctx.deleteMessage();
        break;

      default:
        await answerCallback(`Unknown action: ${act}`);
    }
  } catch (err) {
    await answerCallback(`❌ ${err instanceof Error ? err.message : String(err)}`);
  }
}

// === COMMAND HANDLER FACTORIES ===

function startHandler(sm: SessionManager) {
  return async (ctx: Context) => {
    try {
      const currentSession = sm.current;
      const nextCwd = currentSession?.cwd || config.vibe.projectDir;
      await sm.createSession(nextCwd);
      const s = sm.current;
      if (!s) throw new Error("No session created");
      await ctx.reply(
        `✅ **Session created!**\n📍 Directory: \`${s.cwd}\`\nUse /files to browse`,
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

function modelHandler(sm: SessionManager) {
  return async (ctx: Context) => {
    const s = sm.current;
    if (!s?.models) { await ctx.reply("No session. Use /start."); return; }
    const menu = buildModelMenu(s.models.availableModels, s.models.currentModelId);
    await ctx.reply(menu.text, { parse_mode: "Markdown", reply_markup: menu.keyboard });
  };
}

function modeHandler(sm: SessionManager) {
  return async (ctx: Context) => {
    const s = sm.current;
    if (!s?.modes) { await ctx.reply("No session. Use /start."); return; }
    const menu = buildModeMenu(s.modes.availableModes, s.modes.currentModeId);
    await ctx.reply(menu.text, { parse_mode: "Markdown", reply_markup: menu.keyboard });
  };
}

function thinkingHandler(sm: SessionManager) {
  return async (ctx: Context) => {
    const s = sm.current;
    if (!s) { await ctx.reply("No session. Use /start."); return; }
    const current = s.configOptions?.find((o) => o.id === "thinking")?.currentValue || "off";
    const menu = buildThinkingMenu(current);
    await ctx.reply(menu.text, { parse_mode: "Markdown", reply_markup: menu.keyboard });
  };
}

function sessionsHandler(sm: SessionManager) {
  return async (ctx: Context) => {
    try {
      const result = await sm.listSessions();
      const menu = buildSessionList(result.sessions, 0);
      await ctx.reply(menu.text, { parse_mode: "Markdown", reply_markup: menu.keyboard });
    } catch (err) {
      await ctx.reply("❌ " + (err instanceof Error ? err.message : String(err)));
    }
  };
}

function closeHandler(acp: AcpClient, sm: SessionManager) {
  return async (ctx: Context) => {
    const sid = sm.currentSessionId;
    if (!sid) { await ctx.reply("No session to close."); return; }
    try {
      await sm.closeSession(sid);
      await ctx.reply("✅ Session closed.");
    } catch (err) {
      await ctx.reply("❌ " + (err instanceof Error ? err.message : String(err)));
    }
  };
}

function compactHandler(acp: AcpClient, sm: SessionManager) {
  return async (ctx: Context) => {
    const sid = sm.currentSessionId;
    if (!sid) { await ctx.reply("No session. Use /start."); return; }
    await ctx.reply("🔄 **Compactage du contexte...** Envoi d'une demande de compression mémoire.", { parse_mode: "Markdown" });
    try {
      await acp.sendPrompt(sid, "Please compact/compress the conversation history to reduce context usage while preserving all important information.");
      await ctx.reply("✅ Demande de compactage envoyée. Le modèle va compresser le contexte.");
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

function abortHandler(
  acp: AcpClient, 
  sm: SessionManager, 
  getBusy: () => boolean, 
  setBusy: (v: boolean) => void,
  setProgressChatId: (v: number | null) => void,
  setProgressMessageId: (v: number | null) => void,
  setProgressText: (v: string) => void,
  setToolCallMap: (v: Map<string, { name: string; kind: string; input?: Record<string, unknown> }>) => void,
  getPermissionTimeout?: () => ReturnType<typeof setTimeout> | null,
  setPermissionTimeout?: (v: ReturnType<typeof setTimeout> | null) => void,
  clearPendingPermission?: () => void,
) {
  return async (ctx: Context) => {
    const sid = sm.currentSessionId;
    if (!sid) { await ctx.reply("No active session."); return; }
    if (!getBusy()) { await ctx.reply("No prompt is currently running."); return; }
    
    // Annuler la permission en attente si elle existe
    const pt = getPermissionTimeout?.();
    if (pt) { clearTimeout(pt); setPermissionTimeout?.(null); }
    clearPendingPermission?.();
    
    acp.cancelPrompt(sid);
    
    // Réinitialiser TOUT l'état de progression
    setBusy(false);
    setProgressChatId(null);
    setProgressMessageId(null);
    setProgressText("");
    setToolCallMap(new Map());
    
    await ctx.reply("⏹️ Prompt aborted.");
  };
}

function renameHandler(acp: AcpClient, sm: SessionManager) {
  return async (ctx: Context) => {
    const sid = sm.currentSessionId;
    if (!sid) { await ctx.reply("No session. Use /start."); return; }
    const text = ctx.message?.text?.trim();
    const title = text?.replace("/rename", "").trim();
    if (!title) { await ctx.reply("Usage: `/rename <title>`", { parse_mode: "Markdown" }); return; }
    try {
      await sm.setTitle(sid, title);
      await ctx.reply(`✅ Renamed to: \`${title}\``, { parse_mode: "Markdown" });
    } catch (err) {
      await ctx.reply("❌ " + (err instanceof Error ? err.message : String(err)));
    }
  };
}

function statusHandler(
  sm: SessionManager,
  getPendingPermission?: () => { id: number; sessionId: string } | null,
  getBusy?: () => boolean,
) {
  return async (ctx: Context) => {
    const s = sm.current;
    if (!s) { await ctx.reply("No session. Use /start."); return; }
    const model = s.models?.currentModelId || "?";
    const mode = s.modes?.currentModeId || "?";
    const thinking = s.configOptions?.find((o) => o.id === "thinking")?.currentValue || "?";
    const title = s.title || s.id.slice(0, 8);
    const directory = s.cwd || config.vibe.projectDir;
    let status = `🤖 **Session**\n` +
      `Title: \`${title}\`\n` +
      `📍 Directory: \`${directory}\`\n` +
      `🤖 Model: \`${model}\`\n` +
      `🎯 Mode: \`${mode}\`\n` +
      `💭 Thinking: \`${thinking}\``;
    if (getBusy?.()) {
      status += `\n\n⏳ **Busy**`;
      if (getPendingPermission?.()) {
        status += ` — permission en attente (envoie un message pour annuler)`;
      }
    }
    await ctx.reply(status, { parse_mode: "Markdown" });
  };
}

function reauthHandler(acpClient: AcpClient, sessionManager: SessionManager) {
  return async (ctx: Context) => {
    await ctx.reply("🔑 Lancement de l'authentification Mistral...");

    let signInUrl: string;
    try {
      const attempt = await startSignIn();
      signInUrl = attempt.signInUrl;
    } catch (err) {
      await ctx.reply(`❌ Impossible de démarrer l'authentification : ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    await ctx.reply(
      `🔑 Clique ici pour te reconnecter à Mistral (valide 10 min) :\n${signInUrl}\n\n⚠️ Tu peux aussi coller une clé API existante ici directement.`,
      { link_preview_options: { is_disabled: true } },
    );

    pollAndExchange()
      .then(async (newKey) => {
        saveApiKey(newKey);
        process.env.MISTRAL_API_KEY = newKey;
        logger.info("[Auth] API key renewed via /reauth");
        await ctx.reply("✅ Clé API renouvelée ! Redémarrage du service ACP...");
        logger.info("[Auth] Restarting ACP with new API key...");
        const restartOk = await restartAcp(acpClient, sessionManager);
        if (restartOk) {
          logger.info("[Auth] ACP restarted with new API key");
          await ctx.reply("✅ Service redémarré avec la nouvelle clé !");
        } else {
          logger.warn("[Auth] ACP restart failed after /reauth");
          await ctx.reply("⚠️ Redémarrage impossible. Le service va réessayer automatiquement.");
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[Auth] /reauth poll failed: ${msg}`);
        ctx.reply(
          `❌ Échec de l'authentification : ${msg}\n\n⚠️ Tu peux obtenir une clé sur https://console.mistral.ai et la coller ici.`,
        ).catch(() => {});
      });
  };
}

function setkeyHandler(acpClient: AcpClient, sessionManager: SessionManager) {
  return async (ctx: Context) => {
    const text = ctx.message?.text?.trim() || '';
    const key = text.replace('/setkey', '').trim();

    if (!key) {
      await ctx.reply("Usage: `/setkey <votre_clé_API>`\n\nTu peux obtenir une clé sur https://console.mistral.ai", { parse_mode: "Markdown" });
      return;
    }

    await ctx.reply("⏳ Validation de la clé...");
    try {
      const valid = await validateApiKey(key);
      if (valid === false) {
        await ctx.reply("❌ Clé API invalide. Vérifie la clé et réessaie.");
        return;
      }
      saveApiKey(key);
      process.env.MISTRAL_API_KEY = key;
      await ctx.reply("✅ Clé API enregistrée ! Redémarrage du service ACP...");
      logger.info("[Auth] API key updated via /setkey");

      const restartOk = await restartAcp(acpClient, sessionManager);
      if (restartOk) {
        await ctx.reply("✅ Service redémarré avec la nouvelle clé !");
      } else {
        logger.warn("[Auth] ACP restart failed after /setkey");
        await ctx.reply("⚠️ Redémarrage impossible. Le service va réessayer automatiquement.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[Auth] /setkey validation error: ${msg}`);
      await ctx.reply(`❌ Erreur : ${msg}`);
    }
  };
}

const helpHandler = async (ctx: Context) => {
  await ctx.reply(
    "🤖 **Vibe Bot**\n\n" +
    "**Session Management**\n" +
    "/start - Create a Vibe session\n" +
    "/sessions - List/switch sessions\n" +
    "/close - Close current session\n" +
    "/rename <title> - Rename session\n" +
    "/status - Show session info\n" +
    "/abort - Cancel current prompt\n\n" +
    "**AI Configuration**\n" +
    "/model - Switch AI model\n" +
    "/mode - Switch agent mode\n" +
    "/thinking - Set thinking budget\n\n" +
    "**File Navigation**\n" +
    "/files - Browse files in current directory\n" +
    "/cd <path> - Change working directory\n" +
    "/pwd - Show current working directory\n\n" +
    "**Todo**\n" +
    "/todo - Show todo list\n" +
    "/todo add <text> - Add a todo\n" +
    "/todo done <id> - Toggle todo done\n" +
    "/todo rm <id> - Remove a todo\n" +
    "/todo clear - Clear done todos\n\n" +
    "**Account**\n" +
    "/reauth - Reconnect Mistral API (if key expired)\n" +
    "/setkey <key> - Set Mistral API key manually\n\n" +
    "Type any message to send a prompt to Vibe.",
    { parse_mode: "Markdown" },
  );
};

function todoHandler(tm?: TodoManager) {
  return async (ctx: Context) => {
    if (!tm) { await ctx.reply("Todo manager not available"); return; }
    const text = ctx.message?.text?.trim() || "/todo";
    const parts = text.split(/\s+/);
    const sub = parts[1];

    if (sub === "add") {
      const todoText = parts.slice(2).join(" ");
      if (!todoText) { await ctx.reply("Usage: `/todo add <text>`", { parse_mode: "Markdown" }); return; }
      const item = await tm.add(todoText);
      await ctx.reply(`✅ Added #${item.id}: ${item.text}`);
    } else if (sub === "done") {
      const id = parseInt(parts[2], 10);
      if (isNaN(id)) { await ctx.reply("Usage: `/todo done <id>`", { parse_mode: "Markdown" }); return; }
      const ok = await tm.toggle(id);
      await ctx.reply(ok ? `✅ Toggled #${id}` : `❌ Todo #${id} not found`);
    } else if (sub === "rm") {
      const id = parseInt(parts[2], 10);
      if (isNaN(id)) { await ctx.reply("Usage: `/todo rm <id>`", { parse_mode: "Markdown" }); return; }
      const ok = await tm.remove(id);
      await ctx.reply(ok ? `✅ Removed #${id}` : `❌ Todo #${id} not found`);
    } else if (sub === "clear") {
      await tm.clearDone();
      await ctx.reply("✅ Done todos cleared");
    } else {
      await ctx.reply(tm.format(), { parse_mode: "Markdown" });
    }
  };
}

// === ACP NOTIFICATION HANDLER ===

async function handleAcpNotification(
  msg: unknown,
  bot: Bot<Context>,
  acpClient: AcpClient,
  getProgressChatId: () => number | null,
  getProgressMessageId: () => number | null,
  setProgressMessageId: (id: number) => void,
  appendProgress: (t: string) => void,
  getProgressText: () => string,
  flushProgress: () => void,
  setPendingPermission: (p: { id: number; sessionId: string } | null) => void,
  toolCallMap: Map<string, { name: string; kind: string; input?: Record<string, unknown> }>,
  changedFiles: Set<string>,
  toolCountWrapper: { n: number },
  onQuestion?: (sessionId: string, questionText: string, options: string[]) => void,
  onTextChunk?: (text: string) => void,
  onThinkingChunk?: (text: string) => void,
  onUsage?: (usage: { inputTokens: number; outputTokens: number; cost: number }) => void,
  onToolUpdate?: (summary: string) => void,
  onToolEntry?: (icon: string, label: string) => void,
): Promise<void> {
  const m = msg as Record<string, unknown>;
  const method = m.method as string | undefined;
  const params = m.params as Record<string, unknown> | undefined;
  const chatId = config.telegram.allowedUserId;

  // Permission request → show inline keyboard
  if (method === "session/request_permission" && params) {
    const toolCall = params.toolCall as Record<string, unknown> | undefined;
    const options = params.options as { optionId: string; name: string }[] | undefined;
    if (options) {
      // Look up stored tool call details by toolCallId
      const toolCallId = toolCall?.toolCallId as string || "";
      const stored = toolCallId ? toolCallMap.get(toolCallId) : undefined;
      const toolName = stored?.name || toolCall?.name as string || toolCallId || "unknown";
      const kindLabel = stored?.kind && stored?.kind !== toolName ? ` (${stored.kind})` : "";
      const inputStr = stored?.input ? formatToolInput(toolName, stored.input) : "";
      logger.info(`[Permission] id=${m.id} toolCallId=${toolCallId} toolName=${toolName} stored=${!!stored} inputStr=${!!inputStr}`);
      const kb = new InlineKeyboard();
      for (const o of options) {
        kb.text(o.name, `perm:${m.id}:${o.optionId}`);
      }
      // Register permission BEFORE sending — ensures it's tracked even if Telegram API fails
      setPendingPermission({ id: m.id as number, sessionId: params.sessionId as string });
      const permText = `🔒 **${toolName}**${kindLabel}${inputStr}`;
      try {
        await bot.api.sendMessage(chatId, permText, { parse_mode: "Markdown", reply_markup: kb });
        logger.info(`[Permission] Message sent for id=${m.id}`);
      } catch {
        try { await bot.api.sendMessage(chatId, permText, { reply_markup: kb }); }
        catch (e) { logger.error(`[Permission] Failed to send message for id=${m.id}:`, e); }
      }
    }
    return;
  }

  // Session update
  if (method === "session/update" && params) {
    const update = params.update as Record<string, unknown> | undefined;
    if (!update) return;
    const sessionUpdate = update.sessionUpdate as string;

    if (sessionUpdate === "session_info_update") return;
    if (sessionUpdate === "available_commands_update") return;

    if (sessionUpdate === "agent_thought_chunk") {
      const content = update.content as Record<string, unknown> | undefined;
      const text = content?.text as string | undefined;
      if (text && onThinkingChunk) {
        onThinkingChunk(text);
      }
      return;
    }

    if (sessionUpdate === "agent_message_chunk") {
      const content = update.content as Record<string, unknown> | undefined;
      const text = content?.text as string | undefined;
      if (text) {
        logger.debug(`[Progress] chunk ${text.length} chars`);
        appendProgress(text);
        if (onTextChunk) onTextChunk(text);
        flushProgress();
      } else {
        logger.debug("[ACP msg_chunk] no text", JSON.stringify(update).slice(0, 300));
      }
      return;
    }

    if (sessionUpdate === "tool_call") {
      const toolCallId = update.toolCallId as string;
      if (!toolCallId) return;
      const toolName = (update._meta as Record<string, unknown> | undefined)?.tool_name as string || update.title as string;
      const kind = update.kind as string || "";
      let input: Record<string, unknown> | undefined;
      const rawInput = update.rawInput;
      if (typeof rawInput === "string") {
        try { input = JSON.parse(rawInput); } catch { input = undefined; }
      } else if (rawInput && typeof rawInput === "object") {
        input = rawInput as Record<string, unknown>;
      }
      logger.debug(`[ToolCall] id=${toolCallId} name=${toolName} kind=${kind} input=${JSON.stringify(input)}`);
      const existing = toolCallMap.get(toolCallId);
      if (input) {
        // Interactive question — show inline keyboard with options
        if ((kind === "question" || toolName === "question") && Array.isArray(input.options) && input.options.length > 0 && onQuestion) {
          const questionText = (input.question || input.text || input.message || "") as string;
          const options = input.options as string[];
          onQuestion(params.sessionId as string, questionText, options);
          toolCallMap.set(toolCallId, { name: toolName, kind, input });
          return;
        }
        toolCallMap.set(toolCallId, { name: toolName, kind, input });
        toolCountWrapper.n++;
        // Track changed files for pinned message
        if ((kind === "write" || kind === "edit" || toolName === "write" || toolName === "write_file" || toolName === "edit") && input.filePath) {
          changedFiles.add(input.filePath as string);
        } else if ((kind === "write" || kind === "edit") && input.path) {
          changedFiles.add(input.path as string);
        }
      } else if (!existing) {
        toolCallMap.set(toolCallId, { name: toolName, kind, input: undefined });
        toolCountWrapper.n++;
      }
      // Notify tool entry for live streaming
      if (onToolEntry && input) {
        const icon = TOOL_EMOJI[kind] || TOOL_EMOJI[toolName] || "🛠️";
        const fp = (input?.filePath || input?.path || input?.file_path || "") as string;
        const cmd = (input?.command || input?.code || "") as string;
        const label = fp ? `${toolName} ${fp.slice(0, 200)}` : cmd ? `${toolName} ${cmd.slice(0, 200)}` : toolName;
        onToolEntry(icon, label);
      }
      flushProgress();
      if (onToolUpdate) {
        const summary = buildToolSummary(toolCallMap);
        onToolUpdate(summary);
      }
      return;
    }

    if (sessionUpdate === "usage_update") {
      // Usage stats arrive mid-stream, not final – don't finalize here
      const usage = update.usage as Record<string, unknown> | undefined;
      if (usage) {
        const cost = usage.totalCostDollars as number;
        const inp = usage.inputTokens as number;
        const out = usage.outputTokens as number;
        logger.info(`[Usage] in=${inp} out=${out} cost=$${(cost ?? 0).toFixed(4)}`);
        if (onUsage) onUsage({ inputTokens: inp, outputTokens: out, cost: cost ?? 0 });
      }
      return;
    }
  }
}

export function splitMessage(text: string, max = 4096): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    if (start + max >= text.length) {
      out.push(text.slice(start));
      break;
    }
    const end = start + max;
    const nl = text.lastIndexOf("\n", end);
    if (nl > start) {
      // Break after the newline
      out.push(text.slice(start, nl + 1));
      start = nl + 1;
    } else {
      // No newline found, hard break
      out.push(text.slice(start, end));
      start = end;
    }
  }
  return out;
}

function buildToolSummary(map: Map<string, { name: string; kind: string; input?: Record<string, unknown> }>): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const [, v] of map) {
    if (!v.input) continue;
    const key = `${v.kind}:${JSON.stringify(v.input)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(formatToolCallLine(v.name, v.kind, v.input));
    if (lines.length >= 5) break;
  }
  if (lines.length === 0) return "";
  let result = lines.join("\n");
  if (result.length > 1500) result = result.slice(0, 1500) + "...";
  return result;
}

function formatToolCallLine(toolName: string, kind: string, input?: Record<string, unknown>): string {
  const icon = TOOL_EMOJI[kind] || TOOL_EMOJI[toolName] || "🛠️";
  const fp = input?.filePath || input?.path || input?.file_path || "";
  if (kind === "read" || kind === "edit" || toolName === "read" || toolName === "edit") {
    const path = typeof fp === "string" ? fp : "";
    return `${icon} **${toolName}** \`${path}\``;
  }
  if (kind === "write" || toolName === "write" || toolName === "write_file") {
    const path = typeof fp === "string" ? fp : "";
    const lines = (input?.content && typeof input.content === "string") ? input.content.split("\n").length : 0;
    const lineInfo = lines > 0 ? ` (+${lines})` : "";
    return `${icon} **${toolName}** \`${path}\`${lineInfo}`;
  }
  if (kind === "bash" || toolName === "bash") {
    const cmd = (input?.command || input?.code || "") as string;
    const c = cmd.slice(0, 300);
    return `${icon} **${toolName}**\n\`\`\`bash\n$ ${c}\n\`\`\``;
  }
  if (kind === "grep" || kind === "search" || toolName === "grep") {
    const q = (input?.query || input?.pattern || "") as string;
    return `${icon} **${toolName}** \`${q}\``;
  }
  if (kind === "glob" || toolName === "glob") {
    const p = (input?.pattern || "") as string;
    return `${icon} **${toolName}** \`${p}\``;
  }
  if (kind === "question" || toolName === "question") {
    const q = (input?.question || input?.text || input?.message || "") as string;
    return `${icon} **${toolName}**\n${escapeMarkdown(q.slice(0, 500))}`;
  }
  // Fallback: show whatever detail we can find
  const detail = (input?.url || input?.name || input?.query || input?.command || input?.path || fp || input?.text || "") as string;
  if (detail) return `${icon} **${toolName}** \`${String(detail).slice(0, 300)}\``;
  return `${icon} **${toolName}**`;
}

async function replyWithFallback(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.reply(text, { parse_mode: "Markdown" });
  } catch {
    try { await ctx.reply(text); } catch (e) { logger.warn("[Bot] Failed to send text:", e); }
  }
}

function extractAgentText(result: Record<string, unknown> | undefined): string | undefined {
  if (!result) return undefined;
  // PromptResponse has stop_reason, usage – no text content
  // The actual response comes via agent_message_chunk events
  if (result.stopReason === "cancelled") return undefined;
  return undefined;
}

/** Extract todo items from agent response – lines starting with "- [ ]" or "TODO:" */
export function extractTodos(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    // Match: - [ ] something, * [ ] something, TODO: something, - **TODO:** something
    const m = trimmed.match(/^(?:[-*]\s+\[\s*\]\s*|TODO:\s*|-\s+\*\*TODO:\*\*\s*)(.+)/i);
    if (m) lines.push(m[1]);
  }
  return lines;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

function formatFileSizeStatic(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  const fp = input.filePath as string || input.path as string || input.file_path as string || "";
  if (toolName === "bash" || toolName === "execute") {
    const cmd = input.command as string || input.code as string || "";
    if (cmd) return `\n\`\`\`bash\n$ ${cmd.slice(0, 1000)}\n\`\`\``;
  }
  if (/^(read|write|write_file|edit)$/.test(toolName)) {
    if (fp) return `\n📄 \`${fp.slice(0, 300)}\``;
  }
  if (toolName === "search" || toolName === "grep") {
    const q = input.query as string || input.pattern as string || "";
    if (q) return `\n🔍 \`${q.slice(0, 300)}\``;
  }
  if (toolName === "glob") {
    const p = input.pattern as string || "";
    if (p) return `\n🔎 \`${p.slice(0, 300)}\``;
  }
  const fallback = JSON.stringify(input).slice(0, 500);
  return fallback ? `\n\`${fallback}\`` : "";
}
