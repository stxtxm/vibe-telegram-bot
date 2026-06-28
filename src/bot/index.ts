import { Bot, type Context, InlineKeyboard } from "grammy";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { promises as fs } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import type { AcpClient } from "../acp/client.js";
import { SessionManager, type SessionState } from "../acp/session.js";
import { TodoManager } from "../todo.js";

const PROMPT_TIMEOUT = 300_000; // 5 min
const PROGRESS_FLUSH_INTERVAL = 1_000; // min ms between progress edits (rate limiting)
const TOOL_EMOJI: Record<string, string> = {
  read: "📖", write: "✏️", edit: "🔧", bash: "💻",
  search: "🔍", glob: "🔎", file: "📄",
};
import {
  buildModelMenu, buildModeMenu, buildThinkingMenu, buildSessionList,
  isModelSelect, isModeSelect, isThinkingSelect, isSessionSelect, isSessionPage, isMenuCancel, isFileAction,
  parseModelData, parseModeData, parseThinkingData, parseSessionSelect, parseSessionPage,
} from "./menus.js";
import {
  parseFileAction,
  buildFileMenu,
  changeDirectory,
  getFileContent,
  type FileAction,
} from "./files.js";

export async function createBot(acpClient: AcpClient, sessionManager: SessionManager, todoManager?: TodoManager): Promise<Bot<Context>> {
  const bot = new Bot(config.telegram.token);

  let busy = false;
  let progressChatId: number | null = null;
  let progressMessageId: number | null = null;
  let progressText = "";
  let lastFlushTime = 0;
  let toolCallMap = new Map<string, { name: string; kind: string; input?: Record<string, unknown> }>();
  let promptGeneration = 0;

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
    { command: "todo", description: "Manage todo list" },
    { command: "help", description: "Show help" },
  ]);

  bot.command("start", startHandler(sessionManager));
  bot.command("model", modelHandler(sessionManager));
  bot.command("mode", modeHandler(sessionManager));
  bot.command("thinking", thinkingHandler(sessionManager));
  bot.command("sessions", sessionsHandler(sessionManager));
  bot.command("files", filesHandler(sessionManager));
  bot.command("cd", cdHandler(sessionManager));
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
  bot.command("rename", renameHandler(acpClient, sessionManager));
  bot.command("status", statusHandler(sessionManager, () => pendingPermission, () => busy));
  bot.command("todo", todoHandler(todoManager));
  bot.command("help", helpHandler);

  // === TEXT MESSAGE HANDLER (prompts) ===
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const sid = sessionManager.currentSessionId;
    if (!sid) { await ctx.reply("No session. Use /start."); return; }

    // Cancel any running prompt and start fresh
    if (busy) {
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

    const statusMsg = await ctx.reply("⏳ Thinking...");
    progressChatId = statusMsg.chat.id;
    progressMessageId = statusMsg.message_id;
    const stopTyping = startTypingInterval(statusMsg.chat.id);

    runPrompt(acpClient, ctx, sid, generation, stopTyping).catch((err) => {
      logger.error("[Prompt] Background error:", err);
    });
  });

  async function runPrompt(acpClient: AcpClient, ctx: Context, sid: string, generation: number, stopTyping?: () => void, retry = 0) {
    const text = ctx.message?.text;
    if (!text) return;
    let recovered = false;
    try {
      const result = await acpClient.sendPrompt(sid, text) as Record<string, unknown> | undefined;

      // Stale — a newer prompt has superseded this one
      if (generation < promptGeneration) {
        logger.debug(`[Prompt] Stale generation ${generation} < ${promptGeneration}, ignoring result`);
        return;
      }

      const toolSummary = buildToolSummary(toolCallMap);

      // Edit progress message to show done status (no truncated text)
      if (progressChatId && progressMessageId) {
        const doneLine = toolSummary ? `✅ **Done** — ${toolSummary}` : "✅ **Done**";
        try {
          await bot.api.editMessageText(progressChatId, progressMessageId, doneLine, { parse_mode: "Markdown" });
        } catch (e) {
          logger.warn("[Bot] Failed to edit final progress:", e);
        }
      }

      // Send ALL agent output as clean messages with Markdown fallback
      if (progressText) {
        for (const chunk of splitMessage(progressText)) {
          await replyWithFallback(ctx, chunk);
        }
      } else {
        const resultText = extractAgentText(result);
        if (resultText) {
          for (const chunk of splitMessage(resultText)) {
            await replyWithFallback(ctx, chunk);
          }
        } else if (!toolSummary) {
          await ctx.reply("✅ Done");
        }
      }
      if (toolSummary) {
        await replyWithFallback(ctx, toolSummary);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Stale — a newer prompt has superseded this one
      if (generation < promptGeneration) {
        logger.debug(`[Prompt] Stale generation ${generation} < ${promptGeneration}, ignoring`);
        return;
      }

      const stderr = acpClient.getRecentStderr?.() || "";
      if (stderr) logger.warn("[Bot] ACP stderr during error:\n" + stderr.slice(-1000));

      // Session not found — try to reload from disk, then create new if that fails
      if (msg.includes("Session not found") && retry < 1) {
        const lastCwd = sessionManager.current?.cwd || config.vibe.projectDir;
        try {
          await sessionManager.loadSession(sid, lastCwd);
          progressText = "";
          toolCallMap = new Map();
          await ctx.reply(`🔄 Session rechargée. Je relance...`);
          recovered = true;
          await runPrompt(acpClient, ctx, sid, generation, stopTyping, retry + 1);
          return;
        } catch (loadErr) {
          logger.warn(`[Bot] Session ${sid.slice(0, 8)}... load failed, creating new:`, loadErr);
        }
        try {
          const newSid = await sessionManager.createSession(lastCwd);
          progressText = "";
          toolCallMap = new Map();
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
      }
    }
  }

  // === CALLBACK QUERY HANDLER ===
  // Handle ALL callback queries with regex catcher
  bot.callbackQuery(/.*/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const data = ctx.callbackQuery.data;
    logger.info(`[Callback] data="${data}" user=${ctx.from?.id}`);
    const sid = sessionManager.currentSessionId;

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
            await ctx.editMessageText(`✅ ${optionId}`);
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

    await ctx.answerCallbackQuery({ text: "Unknown action" }).catch(() => {});
    logger.warn(`[Callback] Unhandled callback data="${data}"`);
  });

  // === ACP NOTIFICATIONS ===
  acpClient.onMessage((msg) => {
    handleAcpNotification(msg, bot, acpClient, () => progressChatId, () => progressMessageId, (id) => { progressMessageId = id; }, (t) => { progressText += t; }, () => { return progressText; }, () => {
      const now = Date.now();
      if (now - lastFlushTime < PROGRESS_FLUSH_INTERVAL) return;
      lastFlushTime = now;
      if (progressChatId && progressMessageId && progressText) {
        const text = progressText.length > 4000 ? progressText.slice(0, 4000) + "..." : progressText;
        bot.api.editMessageText(progressChatId, progressMessageId, `💬 ${text}`).catch(() => {});
      }
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
    }, toolCallMap).catch((err) => {
      logger.error("[Bot] notification error:", err);
    });
  });

  // === GLOBAL ERROR HANDLER ===
  bot.catch((err) => {
    logger.error("[Bot] Unhandled error:", err.error ?? err);
  });

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
      await bot.api.sendMessage(chatId,
        `🔒 **${toolName}**${kindLabel}${inputStr}`,
        { parse_mode: "Markdown", reply_markup: kb },
      ).then(() => {
        logger.info(`[Permission] Message sent for id=${m.id}`);
      }).catch((err) => {
        logger.error(`[Permission] Failed to send message for id=${m.id}:`, err);
      });
    }
    return;
  }

  // Session update
  if (method === "session/update" && params) {
    const update = params.update as Record<string, unknown> | undefined;
    if (!update) return;
    const sessionUpdate = update.sessionUpdate as string;

    if (sessionUpdate === "agent_thought_chunk") return;
    if (sessionUpdate === "session_info_update") return;
    if (sessionUpdate === "available_commands_update") return;

    if (sessionUpdate === "agent_message_chunk") {
      const content = update.content as Record<string, unknown> | undefined;
      const text = content?.text as string | undefined;
      if (text) {
        logger.debug(`[Progress] chunk ${text.length} chars`);
        appendProgress(text);
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
      // Store/update tool call details — vibe-acp sends two notifications:
      // first with rawInput=null (pending), second with real data (running)
      const existing = toolCallMap.get(toolCallId);
      if (input) {
        toolCallMap.set(toolCallId, { name: toolName, kind, input });
      } else if (!existing) {
        toolCallMap.set(toolCallId, { name: toolName, kind, input: undefined });
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
  const counts = new Map<string, number>();
  for (const [, v] of map) {
    const name = v.kind === "write" || v.kind === "edit" || v.kind === "read" ? "file" : v.kind;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return "";
  return Array.from(counts).map(([name, count]) => `${TOOL_EMOJI[name] || "🛠️"} ${name} ×${count}`).join("  ");
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

function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  const fp = input.filePath as string || input.path as string || input.file_path as string || "";
  if (toolName === "bash" || toolName === "execute") {
    const cmd = input.command as string || input.code as string || "";
    if (cmd) return `\n\`\`\`bash\n$ ${cmd.slice(0, 1000)}\n\`\`\``;
  }
  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    if (fp) return `\n📄 \`${escapeMarkdown(fp.slice(0, 300))}\``;
  }
  if (toolName === "search" || toolName === "grep") {
    const q = input.query as string || input.pattern as string || "";
    if (q) return `\n🔍 \`${escapeMarkdown(q.slice(0, 300))}\``;
  }
  if (toolName === "glob") {
    const p = input.pattern as string || "";
    if (p) return `\n🔎 \`${escapeMarkdown(p.slice(0, 300))}\``;
  }
  const fallback = JSON.stringify(input).slice(0, 500);
  return fallback ? `\n\`${escapeMarkdown(fallback)}\`` : "";
}
