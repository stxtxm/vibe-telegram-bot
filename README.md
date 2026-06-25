# Vibe Telegram Bot

A Telegram bot client for [Mistral Vibe](https://github.com/mistralai/mistral-vibe) using the ACP protocol.

## Features

### Session Management
- `/start` - Create a Vibe session
- `/new` - Create a new session
- `/sessions` - List and switch sessions
- `/close` - Close current session
- `/rename <title>` - Rename session
- `/status` - Show session info

### AI Configuration
- `/model` - Switch AI model
- `/mode` - Switch agent mode (plan, auto-approve, chat, etc.)
- `/thinking` - Set thinking budget

### File Navigation
- `/files` - Browse files
- `/cd <path>` - Change directory
- `/pwd` - Show current directory

### Todo Management
- `/todo` - Show todo list
- `/todo add <text>` - Add a todo
- `/todo done <id>` - Toggle todo
- `/todo rm <id>` - Remove a todo
- `/todo clear` - Clear done todos

### Utility
- `/abort` - Cancel current prompt
- `/help` - Show help
- Any text message - Send as prompt to Vibe

## Quick Start

### Prerequisites
- Node.js 20+
- Mistral Vibe CLI installed
- Telegram Bot Token from @BotFather
- Your Telegram User ID

### Installation

1. Install Vibe CLI:
```bash
curl -LsSf https://mistral.ai/vibe/install.sh | bash
vibe --setup
```

2. Setup bot:
```bash
cp .env.example .env
# Edit .env with your settings
npm install
```

3. Run:
```bash
npm run dev
```

## Configuration

See `.env.example` for required environment variables:
- `TELEGRAM_BOT_TOKEN` - Bot token from @BotFather
- `TELEGRAM_ALLOWED_USER_ID` - Your numeric Telegram user ID
- `VIBE_PROJECT_DIR` - Working directory for sessions
- `LOG_LEVEL` - debug | info | warn | error (default: info)

## Architecture

```
Telegram User -> Telegram Bot (grammy) <-> ACP Client <-> vibe-acp <-> Vibe
```

### Components
- **Bot** (`src/bot/index.ts`) - Command handlers, ACP integration
- **ACP Client** (`src/acp/client.ts`) - Manages vibe-acp process
- **Session Manager** (`src/acp/session.ts`) - Manages Vibe sessions
- **Todo Manager** (`src/todo.ts`) - Persistent todo list

## Project Structure

```
vibe-telegram-bot/
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── types.ts
│   ├── acp/
│   │   ├── client.ts
│   │   ├── protocol.ts
│   │   └── session.ts
│   ├── bot/
│   │   ├── index.ts
│   │   ├── files.ts
│   │   └── menus.ts
│   ├── todo.ts
│   └── utils/
│       ├── fs.ts
│       └── logger.ts
├── tests/
├── .env.example
├── package.json
└── README.md
```

## Development

```bash
npm run dev      # Development mode
npm run build    # Build only
npm start        # Start production
npm test         # Run tests
npm run lint     # Linting
npm run typecheck # Type checking
```

## License

MIT License
