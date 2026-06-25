import { promises as fs } from "node:fs";
import { join } from "node:path";
import { logger } from "./utils/logger.js";

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
  createdAt: string;
}

const DATA_DIR = join(process.cwd(), "data");
const DATA_FILE = join(DATA_DIR, "todos.json");

export class TodoManager {
  private todos: TodoItem[] = [];
  private nextId = 1;

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(DATA_FILE, "utf-8");
      const data = JSON.parse(raw);
      this.todos = data.todos || [];
      this.nextId = data.nextId || 1;
    } catch {
      this.todos = [];
      this.nextId = 1;
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify({ todos: this.todos, nextId: this.nextId }, null, 2));
  }

  async add(text: string): Promise<TodoItem> {
    const item: TodoItem = {
      id: this.nextId++,
      text,
      done: false,
      createdAt: new Date().toISOString(),
    };
    this.todos.push(item);
    await this.save();
    return item;
  }

  async toggle(id: number): Promise<boolean> {
    const item = this.todos.find((t) => t.id === id);
    if (!item) return false;
    item.done = !item.done;
    await this.save();
    return true;
  }

  async remove(id: number): Promise<boolean> {
    const idx = this.todos.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    this.todos.splice(idx, 1);
    await this.save();
    return true;
  }

  async clearDone(): Promise<void> {
    this.todos = this.todos.filter((t) => !t.done);
    await this.save();
  }

  list(): TodoItem[] {
    return [...this.todos];
  }

  format(): string {
    if (this.todos.length === 0) return "📋 *Todo* — Aucune tâche.";
    const pending = this.todos.filter((t) => !t.done);
    const done = this.todos.filter((t) => t.done);
    let out = "📋 *Todo*\n\n";
    if (pending.length > 0) {
      out += "*À faire :*\n";
      for (const t of pending) {
        out += `  · #${t.id} ${t.text}\n`;
      }
      out += "\n";
    }
    if (done.length > 0) {
      out += "*Terminé :*\n";
      for (const t of done) {
        out += `  · ✅ #${t.id} ${t.text}\n`;
      }
    }
    return out.trim();
  }
}
