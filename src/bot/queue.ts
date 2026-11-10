export interface QueuedPrompt {
  text: string;
  messageId: number;
  chatId: number;
  upload?: string | null;
}

/** FIFO queue for prompts received while another prompt is already running. */
export class PromptQueue {
  private items: QueuedPrompt[] = [];

  /** Adds a prompt and returns its 1-based position in the queue. */
  enqueue(prompt: QueuedPrompt): number {
    this.items.push(prompt);
    return this.items.length;
  }

  dequeue(): QueuedPrompt | undefined {
    return this.items.shift();
  }

  /** Drops every queued prompt and returns how many were removed. */
  clear(): number {
    const count = this.items.length;
    this.items = [];
    return count;
  }

  get size(): number {
    return this.items.length;
  }

  list(): readonly QueuedPrompt[] {
    return [...this.items];
  }
}
