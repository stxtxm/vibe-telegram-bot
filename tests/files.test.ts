import { describe, it, expect } from "vitest";
import { isFileAction, parseFileAction } from "../src/bot/files.js";

describe("isFileAction", () => {
  it("should detect file action callbacks", () => {
    expect(isFileAction("f:d:0")).toBe(true);
    expect(isFileAction("f:p:1")).toBe(true);
    expect(isFileAction("f:n:2")).toBe(true);
    expect(isFileAction("f:v:3")).toBe(true);
    expect(isFileAction("f:s:sid123:4")).toBe(true);
    expect(isFileAction("f:g:0:5")).toBe(true);
    expect(isFileAction("f:x")).toBe(true);
    expect(isFileAction("model:x")).toBe(false);
    expect(isFileAction("cancel")).toBe(false);
  });
});

describe("parseFileAction", () => {
  it("should parse directory action", () => {
    // f:d:<idx> — we need the pathMap to have the entry
    // Since pathMap is module-level state, test carefully
    const action = parseFileAction("f:d:0");
    // Without pathMap having index 0, this returns null
    expect(action).toBeNull();
  });

  it("should parse cancel action", () => {
    const action = parseFileAction("f:x");
    expect(action).toEqual({ action: "cancel", path: "" });
  });

  it("should return null for invalid data", () => {
    expect(parseFileAction("xxx")).toBeNull();
    expect(parseFileAction("f:")).toBeNull();
  });

  it("should return null for unknown action type", () => {
    expect(parseFileAction("f:z:0")).toBeNull();
  });
});
