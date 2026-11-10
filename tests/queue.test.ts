import { describe, it, expect } from "vitest";
import { PromptQueue } from "../src/bot/queue.js";

const job = (text: string) => ({ text, messageId: 1, chatId: 42 });

describe("PromptQueue", () => {
  it("returns the queue position on enqueue", () => {
    const q = new PromptQueue();
    expect(q.enqueue(job("a"))).toBe(1);
    expect(q.enqueue(job("b"))).toBe(2);
    expect(q.size).toBe(2);
  });

  it("dequeues prompts in FIFO order", () => {
    const q = new PromptQueue();
    q.enqueue(job("first"));
    q.enqueue(job("second"));
    expect(q.dequeue()?.text).toBe("first");
    expect(q.dequeue()?.text).toBe("second");
    expect(q.dequeue()).toBeUndefined();
  });

  it("clears the queue and reports how many prompts were dropped", () => {
    const q = new PromptQueue();
    q.enqueue(job("a"));
    q.enqueue(job("b"));
    expect(q.clear()).toBe(2);
    expect(q.size).toBe(0);
    expect(q.clear()).toBe(0);
  });

  it("keeps upload metadata attached to the queued prompt", () => {
    const q = new PromptQueue();
    q.enqueue({ ...job("with file"), upload: "/project/data/uploads/x.png" });
    expect(q.dequeue()?.upload).toBe("/project/data/uploads/x.png");
  });

  it("lists a snapshot without exposing internal state", () => {
    const q = new PromptQueue();
    q.enqueue(job("a"));
    const snapshot = q.list();
    expect(snapshot.map((p) => p.text)).toEqual(["a"]);
    q.dequeue();
    expect(snapshot).toHaveLength(1);
    expect(q.size).toBe(0);
  });
});
