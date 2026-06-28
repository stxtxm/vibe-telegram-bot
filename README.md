# Vibe Telegram Bot

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Telegram](https://img.shields.io/badge/Telegram-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)](https://telegram.org/)
[![Mistral Vibe](https://img.shields.io/badge/Mistral_Vibe-9B7BFF?style=for-the-badge&logo=mistralai&logoColor=white)](https://github.com/mistralai/mistral-vibe)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Un client Telegram pour contrôler [Mistral Vibe](https://github.com/mistralai/mistral-vibe) via le protocole ACP.**

Ce bot vous permet d'interagir avec Mistral Vibe directement depuis Telegram. Il offre une interface complète pour gérer vos sessions, configurer l'IA, naviguer dans les fichiers, gérer vos todos, et exécuter des commandes Vibe sans quitter votre client Telegram.

> ⚡ **Idéal pour** : Développeurs, chercheurs, et toute personne utilisant Vibe au quotidien qui souhaite une interface mobile et accessible partout.

Le bot utilise le protocole **ACP (Agent Communication Protocol)** pour communiquer avec le processus Vibe en temps réel, offrant une expérience fluide et réactive.

## ✨ Features

- **Session management** : Créez, listez, fermez et renommez des sessions Vibe
- **Configuration IA** : Changez le modèle, le mode d'agent et le budget de réflexion à la volée
- **Navigation fichiers** : Parcourez le système de fichiers de votre projet
- **Todos persistants** : Gérez vos tâches avec une liste stockée sur disque
- **Cancel + Retry** : Envoyez un nouveau message pendant que le bot réfléchit — il annule et repart
- **Session recovery** : Les sessions sont rechargées depuis le disque après un redémarrage du bot
- **Typing indicator** : Le bot affiche "typing..." pendant qu'il traite votre message
- **Markdown fallback** : Les messages sont envoyés en Markdown avec fallback automatique si le formatage casse
- **Permissions** : Les demandes d'autorisation d'outils (bash, read, write, etc.) sont relayées et ont un timeout de 10 min

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Create a new Vibe session |
| `/sessions` | List and switch between sessions |
| `/status` | Show current session info |
| `/rename <title>` | Rename current session |
| `/model` | Switch AI model |
| `/mode` | Switch agent mode (plan, auto-approve, chat, etc.) |
| `/thinking` | Set thinking budget |
| `/files` | Browse project files |
| `/cd <path>` | Change directory |
| `/pwd` | Show current directory |
| `/todo` | Show todo list |
| `/todo add <text>` | Add a todo |
| `/todo done <id>` | Toggle todo completion |
| `/todo rm <id>` | Remove a todo |
| `/todo clear` | Clear completed todos |
| `/abort` | Cancel current prompt |
| `/help` | Show help message |

Any text message is sent as a prompt to Vibe. If the bot is already processing a prompt, sending a new message cancels the current one and starts fresh.

## 📥 Installation

### ⚙️ Prérequis système

Avant de commencer, assurez-vous que votre système répond aux exigences suivantes :

| Composant | Version requise | Vérification |
|-----------|----------------|--------------|
| **Système d'exploitation** | Linux, macOS, Windows (WSL2) | - |
| **Node.js** | 20.x ou supérieur | `node --version` |
| **npm** | 10.x ou supérieur | `npm --version` |
| **git** | Dernière version | `git --version` |
| **Mistral Vibe CLI** | Dernière version | `vibe --version` |
| **curl** | Pour l'installation | `curl --version` |

### 📋 Préparation des identifiants Telegram

#### Obtenir votre Telegram User ID

Votre User ID est nécessaire pour autoriser votre accès au bot.

1. Ouvrez Telegram (mobile ou desktop)
2. Recherchez **@userinfobot**
3. Envoyez-lui un message (n'importe quel texte, par exemple `hi`)
4. Le bot répondra avec vos informations, dont votre **ID utilisateur** (un nombre comme `123456789`)
5. Notez ce nombre, il sera utilisé dans la configuration

> 💡 **Astuce** : Vous pouvez aussi obtenir votre ID via un bot que vous contrôlez en utilisant l'API Telegram, ou via des sites web comme [telegramid.net](https://telegramid.net/)

#### Obtenir un token de bot Telegram

1. Ouvrez Telegram et recherchez **@BotFather** (le bot officiel de Telegram)
2. Envoyez la commande `/newbot`
3. @BotFather vous demandera de choisir un nom pour votre bot (ex: `Mon Vibe Bot`)
4. Ensuite, choisissez un nom d'utilisateur pour votre bot **se terminant par `bot`** (ex: `MonVibeBot` ou `MonVibe_Bot`)
5. @BotFather vous fournira un **token d'accès** (format : `123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)
6. **Copiez et conservez ce token en sécurité** - il permet de contrôler votre bot

> ⚠️ **Important** : Ne partagez jamais votre token de bot ! Toute personne en possession de ce token peut contrôler votre bot.

### 🚀 Installation pas à pas

#### Étape 1 : Installer Mistral Vibe CLI

Le bot nécessite que [Mistral Vibe](https://github.com/mistralai/mistral-vibe) soit installé sur votre système.

```bash
# Télécharger et installer Vibe CLI
curl -LsSf https://mistral.ai/vibe/install.sh | bash

# Initialiser Vibe avec vos préférences (requis avant la première utilisation)
vibe --setup

# Vérifier que Vibe est correctement installé
vibe --version

# Tester une commande simple pour confirmer que tout fonctionne
vibe --help
```

> ⚠️ **Problème courant** : Si la commande `vibe` n'est pas trouvée, assurez-vous que :
> - Le script d'installation s'est exécuté sans erreur
> - Le répertoire d'installation de Vibe est dans votre `PATH`
> - Vous avez redémarré votre terminal ou sourcé votre fichier de profile (`~/.bashrc`, `~/.zshrc`, etc.)

#### Étape 2 : Cloner et configurer le bot

```bash
# Cloner ce dépôt git
git clone https://github.com/votre-utilisateur/vibe-telegram-bot.git

# Se déplacer dans le répertoire du projet
cd vibe-telegram-bot

# Copier le fichier d'exemple de configuration
cp .env.example .env

# Installer les dépendances npm
npm install
```

#### Étape 3 : Configurer les variables d'environnement

Éditez le fichier `.env` à la racine du projet avec vos informations :

```env
# Token du bot Telegram (obtenu via @BotFather) - REQUIS
TELEGRAM_BOT_TOKEN=votre_token_ici

# Votre User ID Telegram (obtenu via @userinfobot) - REQUIS
TELEGRAM_ALLOWED_USER_ID=votre_id_utilisateur

# Répertoire de travail pour les sessions Vibe - REQUIS
# C'est ici que seront stockés les fichiers et données des sessions
VIBE_PROJECT_DIR=/home/votre_utilisateur/vibe-sessions

# Niveau de logging (debug, info, warn, error) - OPTIONNEL
# Par défaut : info
LOG_LEVEL=debug
```

> 💡 **Conseils de configuration** :
> - Pour autoriser plusieurs utilisateurs à accéder au bot, séparer les IDs par des virgules : `TELEGRAM_ALLOWED_USER_ID=123456789,987654321`
> - Assurez-vous que le répertoire `VIBE_PROJECT_DIR` existe et que le bot a les permissions d'écriture
> - Utilisez `LOG_LEVEL=debug` pour obtenir des logs détaillés lors du développement

#### Étape 4 : Démarrer le bot

Vous avez deux options pour démarrer le bot :

```bash
# Mode développement - avec compilation TypeScript et rechargement
npm run dev

# Mode production - nécessite une compilation préalable
npm run build
npm start
```

> 💡 **Astuce** : Pour un déploiement en production, nous recommandons d'utiliser un process manager comme [PM2](https://pm2.io/) :
> ```bash
> npm install -g pm2
> pm2 start dist/index.js --name vibe-telegram-bot
> pm2 save
> pm2 startup
> ```

#### Étape 5 : Tester le bot

1. Dans votre client Telegram, recherchez votre bot par son nom (ex: `@MonVibeBot`)
2. Lancez une conversation avec le bot
3. Envoyez la commande `/start` pour créer une nouvelle session Vibe
4. Testez d'autres commandes :
   - `/help` - Affiche l'aide complète
   - `/model` - Voir et changer le modèle d'IA
   - `/mode` - Changer le mode d'agent
   - `/sessions` - Lister vos sessions
   - `/todo` - Gérer vos tâches
5. Envoyez un message texte normal - il sera traité comme un prompt Vibe

### ❌ Dépannage

| Problème | Solution |
|---------|----------|
| **Le bot ne répond pas** | Vérifiez que le process Node.js est en cours d'exécution (`ps aux \| grep node`) |
| **Erreur de token invalide** | Vérifiez que `TELEGRAM_BOT_TOKEN` est correct dans `.env` |
| **Accès refusé** | Vérifiez que `TELEGRAM_ALLOWED_USER_ID` contient votre ID |
| **Commande `vibe` introuvable** | Assurez-vous que Vibe est installé et dans votre PATH |
| **Erreur de permission sur le répertoire** | Vérifiez que `VIBE_PROJECT_DIR` existe et est accessible en écriture |
| **Erreur de connexion ACP** | Vérifiez que Vibe est en cours d'exécution et accessible depuis le bot |

Pour obtenir des logs détaillés, démarrez le bot avec `LOG_LEVEL=debug` dans votre `.env`.

## ⚙️ Configuration

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
- **Bot** (`src/bot/index.ts`) - Command handlers, ACP integration, typing indicator, message splitting, Markdown fallback
- **ACP Client** (`src/acp/client.ts`) - Manages vibe-acp child process, JSON-RPC 2.0 communication, 30-min request timeout, session/load for recovery
- **Session Manager** (`src/acp/session.ts`) - In-memory session state, create/load/close/setModel/setMode/setConfigOption
- **Todo Manager** (`src/todo.ts`) - Persistent todo list stored on disk
- **Files** (`src/bot/files.ts`) - File system navigation with inline keyboard menus

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
