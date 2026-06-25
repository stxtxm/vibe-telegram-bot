# Agent Notes - Vibe Telegram Bot

## Project Overview

This is a **Telegram bot** that interfaces with [Mistral Vibe](https://github.com/mistralai/mistral-vibe) using the **ACP (Agent Client Protocol)**. It allows users to interact with Vibe sessions through Telegram, sending prompts, managing files, configuring AI settings, and handling tool permissions.

## For AI Agents Working on This Project

### Understanding the Architecture

```
Telegram User
    ↓ (Telegram API)
Vibe Telegram Bot (Node.js + TypeScript + grammy)
    ↓ (JSON-RPC 2.0 over stdin/stdout)
vibe-acp (Vibe's ACP server - child process)
    ↓
Mistral Vibe CLI
```

### Key Concepts

1. **ACP Protocol**: JSON-RPC 2.0 communication between the bot and vibe-acp
2. **Sessions**: Each conversation is a Vibe session with its own context
3. **Tool Calls**: Vibe can request permission to use tools (bash, read, write, etc.)
4. **State Management**: Sessions, todos, and file navigation state are managed locally

### Important Files

| File | Purpose | Key Classes/Functions |
|------|---------|---------------------|
| `src/index.ts` | Entry point | `main()`, process management |
| `src/config.ts` | Configuration | `config` object, env var loading |
| `src/bot/index.ts` | Bot logic | `createBot()`, command handlers |
| `src/bot/files.ts` | File navigation | `buildFileMenu()`, directory handling |
| `src/bot/menus.ts` | UI menus | Inline keyboard builders |
| `src/acp/client.ts` | ACP client | `AcpClient` class, JSON-RPC |
| `src/acp/session.ts` | Session management | `SessionManager` class |
| `src/acp/protocol.ts` | Protocol types | TypeScript interfaces |
| `src/todo.ts` | Todo management | `TodoManager` class |

### Command Flow

```
User sends /start
    ↓
Bot receives command
    ↓
SessionManager.createSession(cwd)
    ↓
ACP Client sends session/new request to vibe-acp
    ↓
vibe-acp creates session and returns sessionId
    ↓
SessionManager stores session state
    ↓
Bot responds to user with confirmation
```

### Adding New Features

#### New Bot Command

1. Add to command list in `src/bot/index.ts`:
   ```typescript
   bot.api.setMyCommands([
     // ... existing commands
     { command: "newcommand", description: "Description" },
   ]);
   ```

2. Create handler function:
   ```typescript
   function newCommandHandler(sm: SessionManager) {
     return async (ctx: Context) => {
       // Your logic here
       await ctx.reply("Response");
     };
   }
   ```

3. Register handler:
   ```typescript
   bot.command("newcommand", newCommandHandler(sessionManager));
   ```

4. Add to help text in `helpHandler` function

#### New ACP Method

1. Add method to `AcpClient` class in `src/acp/client.ts`:
   ```typescript
   async newMethod(sessionId: string, param: string): Promise<unknown> {
     return this.request("new/method", { sessionId, param });
   }
   ```

2. Add corresponding method to `SessionManager` if needed

#### New Menu Type

1. Add predicate functions in `src/bot/menus.ts`:
   ```typescript
   export function isNewMenu(data: string): boolean {
     return data.startsWith("new:");
   }
   ```

2. Add menu builder:
   ```typescript
   export function buildNewMenu(items: any[]): { text: string; keyboard: InlineKeyboard } {
     const kb = new InlineKeyboard();
     // Build your menu
     return { text: "Menu title", keyboard: kb };
   }
   ```

3. Handle in callback router in `src/bot/index.ts`

### Testing

Tests use Vitest. To run:
```bash
npm test
npm run test:watch
```

Test files mirror the source structure:
- `tests/acp-client.test.ts` - ACP client tests
- `tests/bot.test.ts` - Bot command tests
- `tests/files.test.ts` - File navigation tests
- `tests/menus.test.ts` - Menu building tests
- `tests/session-manager.test.ts` - Session management tests
- `tests/todo-manager.test.ts` - Todo management tests

### Environment Setup

For development, you need:

```bash
# Clone the repo
git clone <repo-url>
cd vibe-telegram-bot

# Install dependencies
npm install

# Create env file
cp .env.example .env
# Edit .env with your Telegram bot token and user ID

# Install Vibe CLI (if not already installed)
curl -LsSf https://mistral.ai/vibe/install.sh | bash
vibe --setup
```

### Coding Guidelines

1. **TypeScript**: Use strict typing everywhere
2. **Error Handling**: Always handle errors and provide user feedback
3. **Logging**: Use the `logger` module for debugging
4. **Async/Await**: Prefer async/await over callbacks
5. **Rate Limiting**: Be mindful of Telegram API rate limits
6. **State Management**: Keep state in appropriate managers (SessionManager, TodoManager)

### Common Patterns

#### Command Handler Pattern

```typescript
function someHandler(sm: SessionManager) {
  return async (ctx: Context) => {
    const sid = sm.currentSessionId;
    if (!sid) {
      await ctx.reply("No session. Use /start.");
      return;
    }
    // Your logic here
    try {
      // Do something
      await ctx.reply("✅ Success");
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
```

#### ACP Request Pattern

```typescript
async sendNewRequest(sessionId: string, data: any): Promise<ResultType> {
  logger.info(`[ACP] newRequest ${sessionId.slice(0, 8)}...`);
  const result = await this.request("new/method", { sessionId, data });
  return result as ResultType;
}
```

#### Callback Query Pattern

```typescript
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  logger.info(`[Callback] data="${data}" user=${ctx.from?.id}`);
  
  if (data.startsWith("prefix:")) {
    await ctx.answerCallbackQuery().catch(() => {});
    // Handle callback
    await ctx.editMessageText("Updated message");
    return;
  }
  
  await ctx.answerCallbackQuery({ text: "Unknown action" });
});
```

### Important Considerations

1. **Single User**: The bot is designed for a single user (specified by `TELEGRAM_ALLOWED_USER_ID`)
2. **Session State**: Session state is stored in memory (not persisted across restarts)
3. **Todo Persistence**: Todos are stored in `data/todos.json`
4. **Permission Handling**: Tool permissions have a 10-minute timeout
5. **Progress Updates**: Progress messages are rate-limited (1 second minimum between updates)
6. **Message Splitting**: Long messages are automatically split to fit Telegram's 4096 character limit

### Debugging Tips

1. **Enable debug logging**:
   ```bash
   LOG_LEVEL=debug npm run dev
   ```

2. **Check ACP communication**:
   - Look for `[ACP <<<]` and `[ACP >>>]` in logs
   - Verify `vibe-acp` is running and responsive

3. **Test manually**:
   ```bash
   # Start vibe-acp manually
   vibe-acp
   # In another terminal, send JSON-RPC requests
   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | socat - UNIX-CONNECT:/tmp/vibe-acp.sock
   ```

### Known Limitations

1. **No Multi-User Support**: Only one user ID is allowed
2. **No Session Persistence**: Sessions are lost on bot restart
3. **No Conversation History**: Only current prompt responses are shown
4. **Basic Rate Limiting**: Only basic protection against Telegram rate limits

### Future Enhancements

Potential improvements:
- Multi-user support with user-specific sessions
- Session persistence (save to database)
- Conversation history
- Better error recovery
- More sophisticated rate limiting
- Custom skills and tools
- Web interface for configuration

### Getting Help

1. Check existing code for similar patterns
2. Look at test files to understand expected behavior
3. Review the Vibe ACP protocol documentation
4. Ask in the project's issue tracker

### Useful Commands for Development

```bash
# Type check without emitting
npm run typecheck

# Lint
npm run lint

# Build
npm run build

# Run
npm start

# Development (build + start, watches)
npm run dev

# Test
npm test
npm run test:watch

# Clean
rm -rf dist node_modules
```

---

**Last Updated**: 2026-06-25
**Project Version**: 0.1.0
