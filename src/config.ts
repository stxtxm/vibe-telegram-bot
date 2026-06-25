import dotenv from "dotenv";
import type { Config } from "./types.js";

dotenv.config();

function getEnvVar(key: string, required: boolean = true): string {
  const value = process.env[key];
  if (required && !value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value || "";
}

export const config: Config = {
  telegram: {
    token: getEnvVar("TELEGRAM_BOT_TOKEN"),
    allowedUserId: parseInt(getEnvVar("TELEGRAM_ALLOWED_USER_ID"), 10),
  },
  vibe: {
    projectDir: getEnvVar("VIBE_PROJECT_DIR"),
  },
  server: {
    logLevel: getEnvVar("LOG_LEVEL", false) || "info",
  },
};
