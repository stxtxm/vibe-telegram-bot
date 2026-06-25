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
  let seenToolCalls = new Set<string>();

  // Permission state
  let pendingPermission: { id: number; sessionId: string } | null = null;
  let permissionTimeout: ReturnType<typeof setTimeout> | null = null;

  // === AUTH MIDDLEWARE ===
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.telegram.allowedUserId) {
      logger.warn(`[Auth] Rejected ${ctx.from?.id}`);
      return;
    }
    await next();
  });

  // === COMMANDS ===
  bot.api.setMyCommands([
    { command: "start", description: "Create a Vibe session" },
    { command: "new", description: "Create a new session" },
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
  bot.command("new", newHandler(sessionManager));
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
    (v) => { seenToolCalls = v; }
  ));
  bot.command("rename", renameHandler(acpClient, sessionManager));
  bot.command("status", statusHandler(sessionManager));
  bot.command("todo", todoHandler(todoManager));
  bot.command("help", helpHandler);

  // === TEXT MESSAGE HANDLER (prompts) ===
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const sid = sessionManager.currentSessionId;
    if (!sid) { await ctx.reply("No session. Use /start."); return; }
    if (busy) { await ctx.reply("⏳ Busy, wait..."); return; }

    busy = true;
    progressText = "";
    seenToolCalls = new Set();

    const statusMsg = await ctx.reply("⏳ Thinking...");
    progressChatId = statusMsg.chat.id;
    progressMessageId = statusMsg.message_id;

    try {
      await acpClient.sendPrompt(sid, text);

      // Prompt finished – send accumulated text and usage
      const chatId = ctx.chat.id;
      if (progressText) {
        for (const chunk of splitMessage(progressText)) {
          try { await ctx.reply(chunk, { parse_mode: "Markdown" }); }
          catch { await ctx.reply(chunk); }
        }
      }

      // Auto-create todos from response
      if (todoManager && progressText) {
        const todoLines = extractTodos(progressText);
        for (const todoText of todoLines) {
          await todoManager.add(todoText);
        }
        if (todoLines.length > 0) {
          await ctx.reply(`📋 ${todoLines.length} todo(s) ajoutée(s) automatiquement. /todo pour voir.`);
        }
      }

      await ctx.reply("✅ Terminé");
      busy = false;
      setTimeout(() => { busy = false; }, PROMPT_TIMEOUT);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Session not found")) {
        await ctx.reply("⚠️ Session introuvable. Création d'une nouvelle session...");
        try {
          await sessionManager.createSession(config.vibe.projectDir);
          busy = false;
          return;
        } catch (createErr) {
          await ctx.reply(`❌ Impossible de créer une session: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
        }
      } else {
        await ctx.reply(`❌ ${msg}`);
      }
      busy = false;
    }

    progressChatId = null;
    progressMessageId = null;
    progressText = "";
  });

  // === CALLBACK QUERY HANDLER ===
  bot.on("callback_query:data", async (ctx) => {
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
          await ctx.answerCallbackQuery({ text: "⏳ Permission expirée" }).catch(() => {});
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
    }, seenToolCalls).catch((err) => {
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
  editMessage: (menu: { text: string; keyboard: InlineKeyboard }) => Promise<unknown>,
  answerCallback: (text: string) => Promise<unknown>,
  sendMessage: (text: string) => Promise<unknown>,
) {
  const { action: act, path, sessionId: sid, page = 0 } = action;
  const effectiveSid = sid || sm.currentSessionId;

  if (!effectiveSid && act !== 'cancel' && act !== 'back') {
    await answerCallback("No active session");
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
        if (!effectiveSid) {
          await answerCallback("No active session");
          return;
        }
        const session = sm.getSession(effectiveSid);
        if (!session) {
          await answerCallback("Session not found");
          return;
        }
        const stats = await fs.stat(path);
        if (!stats.isDirectory()) {
          await answerCallback("Not a directory");
          return;
        }
        session.cwd = path;
        await answerCallback(`✅ Session directory set to ${path}`);
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
      const initialCwd = config.vibe.projectDir;
      await sm.createSession(initialCwd);
      const s = sm.current;
      if (!s) throw new Error("No session created");

      const m = s.models?.currentModelId || "?";
      const mode = s.modes?.currentModeId || "?";
      await ctx.reply(
        `✅ **Session created!**\n📍 Directory: \`${s.cwd}\`\n🤖 Model: \`${m}\`\n🎯 Mode: \`${mode}\``,
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

function newHandler(sm: SessionManager) {
  return async (ctx: Context) => {
    try {
      const currentSession = sm.current;
      const nextCwd = currentSession?.cwd || config.vibe.projectDir;
      await sm.createSession(nextCwd);
      const newSession = sm.current;
      if (!newSession) throw new Error("Failed to create session");

      await ctx.reply(
        `✅ **New session created!**\n📍 Directory: \`${newSession.cwd}\`\nUse /files to browse`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      await ctx.reply("❌ " + (err instanceof Error ? err.message : String(err)));
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
  setSeenToolCalls: (v: Set<string>) => void
) {
  return async (ctx: Context) => {
    const sid = sm.currentSessionId;
    if (!sid) { await ctx.reply("No active session."); return; }
    
    // Toujours annuler la tâche côté ACP, peu importe l'état local
    acp.cancelPrompt(sid);
    
    // Réinitialiser TOUT l'état de progression
    setBusy(false);
    setProgressChatId(null);
    setProgressMessageId(null);
    setProgressText("");
    setSeenToolCalls(new Set());
    
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

function statusHandler(sm: SessionManager) {
  return async (ctx: Context) => {
    const s = sm.current;
    if (!s) { await ctx.reply("No session. Use /start."); return; }
    const model = s.models?.currentModelId || "?";
    const mode = s.modes?.currentModeId || "?";
    const thinking = s.configOptions?.find((o) => o.id === "thinking")?.currentValue || "?";
    const title = s.title || s.id.slice(0, 8);
    const directory = s.cwd || config.vibe.projectDir;
    await ctx.reply(
      `🤖 **Session**\n` +
      `Title: \`${title}\`\n` +
      `📍 Directory: \`${directory}\`\n` +
      `🤖 Model: \`${model}\`\n` +
      `🎯 Mode: \`${mode}\`\n` +
      `💭 Thinking: \`${thinking}\``,
      { parse_mode: "Markdown" },
    );
  };
}

const helpHandler = async (ctx: Context) => {
  await ctx.reply(
    "🤖 **Vibe Bot**\n\n" +
    "**Session Management**\n" +
    "/start - Create a Vibe session\n" +
    "/new - Create a new session\n" +
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
  seenToolCalls: Set<string>,
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
      const toolName = toolCall?.name as string || toolCall?.toolCallId as string || "unknown";
      const input = toolCall?.input as Record<string, unknown> | undefined;
      const inputStr = input ? "\n`" + JSON.stringify(input).slice(0, 500) + "`" : "";
      const kb = new InlineKeyboard();
      for (const o of options) {
        kb.text(o.name, `perm:${m.id}:${o.optionId}`);
      }
      // Register permission BEFORE sending — ensures it's tracked even if Telegram API fails
      setPendingPermission({ id: m.id as number, sessionId: params.sessionId as string });
      await bot.api.sendMessage(chatId,
        `🔒 **${toolName}**${inputStr}`,
        { parse_mode: "Markdown", reply_markup: kb },
      ).catch((err) => {
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
        appendProgress(text);
        flushProgress();
      } else {
        logger.debug("[ACP msg_chunk]", JSON.stringify(update));
      }
      return;
    }

    if (sessionUpdate === "tool_call") {
      const toolCallId = update.toolCallId as string;
      if (!toolCallId || seenToolCalls.has(toolCallId)) return;
      seenToolCalls.add(toolCallId);
      const toolName = (update._meta as Record<string, unknown> | undefined)?.tool_name as string || update.title as string;
      const kind = update.kind as string || "";
      const emoji = TOOL_EMOJI[toolName] || "🔧";
      const kindLabel = kind && kind !== toolName ? ` (${kind})` : "";
      await bot.api.sendMessage(chatId, `${emoji} \`${toolName}\`${kindLabel}`, { parse_mode: "Markdown" });
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
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
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
