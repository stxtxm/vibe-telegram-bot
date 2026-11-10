# Vibe Telegram Bot

Telegram bot client for [Mistral Vibe](https://github.com/mistralai/mistral-vibe) via the ACP protocol.

## Prerequisites

- **Node.js 20+**
- **Mistral Vibe CLI** installed and configured

## Install Vibe CLI

```bash
curl -LsSf https://mistral.ai/vibe/install.sh | bash
# or
uv tool install mistral-vibe
```

Then run `vibe --setup` to configure your API key.

## Setup

```bash
cp .env.example .env
# Edit .env with your bot token and user ID
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USER_ID` | Yes | Your numeric Telegram user ID |
| `VIBE_PROJECT_DIR` | Yes | Working directory for Vibe sessions |
| `LOG_LEVEL` | No | debug, info, warn, error (default: info) |

## Run

```bash
npm install
npm run dev
```

## How it works

1. The bot spawns `vibe-acp` as a child process
2. Communicates via JSON-RPC 2.0 over stdin/stdout (ACP protocol)
3. Creates Vibe sessions and sends prompts programmatically
4. Streams updates back to Telegram

## Commands

- `/start` - Create a Vibe session
- `/model`, `/mode`, `/thinking` - Configure the agent
- `/plan` - Switch to plan mode
- `/sessions`, `/close`, `/rename <title>` - Manage sessions
- `/status` - Show current session
- `/files`, `/cd <path>`, `/pwd` - Browse the project
- `/todo` - Manage the todo list
- `/abort`, `/compact` - Control the current prompt
- `/reauth`, `/setkey <key>` - Manage the Mistral API key
- `/help` - Show help
- Any text message = prompt to Vibe
