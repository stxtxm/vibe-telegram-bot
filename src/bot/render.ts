import type { RenderResult, MessageEntity } from "./render/types.js";

/**
 * Convert plain text with basic Markdown formatting into
 * Telegram MessageEntity[] format (NO HTML parse_mode).
 *
 * Supports: **bold**, *italic*, `code`, ```pre```, ~~strike~~,
 * [links](url), > blockquote, # headings, - lists
 */
export function renderToEntities(input: string): RenderResult {
  if (!input) return { text: "", entities: [] };

  // First pass: extract code blocks (```...```)
  const blocks: Block[] = [];
  let idx = 0;
  const codeBlockRe = /```(\w*)\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRe.exec(input)) !== null) {
    if (match.index > idx) {
      blocks.push({ type: "markdown", text: input.slice(idx, match.index) });
    }
    const lang = match[1] || "";
    const code = match[2];
    blocks.push({ type: "code", text: code, language: lang });
    idx = match.index + match[0].length;
  }
  if (idx < input.length) {
    blocks.push({ type: "markdown", text: input.slice(idx) });
  }

  // Second pass: process each block
  const result: RenderResult = { text: "", entities: [] };

  for (const block of blocks) {
    if (block.type === "code") {
      appendPre(result, block.text, block.language);
    } else {
      processMarkdownBlock(result, block.text);
    }
  }

  return result;
}

// --- Internal types ---

interface Block {
  type: "markdown" | "code";
  text: string;
  language?: string;
}

// --- Block processing ---

function processMarkdownBlock(result: RenderResult, text: string): void {
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (trimmed.startsWith("> ")) {
      // Blockquote — strip prefix
      if (result.text.length > 0 && !result.text.endsWith("\n")) {
        result.text += "\n";
      }
      const content = trimmed.slice(2) + (i < lines.length - 1 ? "\n" : "");
      processInline(result, content);
      continue;
    }

    if (/^#{1,3}\s/.test(trimmed)) {
      if (result.text.length > 0 && !result.text.endsWith("\n")) {
        result.text += "\n";
      }
      const level = trimmed.match(/^#+/)![0].length;
      const content = trimmed.slice(level + 1) + (i < lines.length - 1 ? "\n" : "");
      processInline(result, content);
      // Headings get bold
      const offset = result.text.length - content.length - (i < lines.length - 1 ? 1 : 0);
      result.entities.push({ type: "bold", offset, length: content.length - (i < lines.length - 1 ? 1 : 0) });
      continue;
    }

    if (/^[-*]\s/.test(trimmed)) {
      if (result.text.length > 0 && !result.text.endsWith("\n")) {
        result.text += "\n";
      }
      const content = trimmed.slice(2) + (i < lines.length - 1 ? "\n" : "");
      result.text += "• " + content;
      continue;
    }

    // Regular text
    if (result.text.length > 0 && result.text[result.text.length - 1] !== "\n" && raw.length > 0) {
      result.text += "\n";
    }
    processInline(result, raw + (i < lines.length - 1 && lines[i + 1].length > 0 ? "" : ""));
  }
}

// --- Inline processing ---

function processInline(result: RenderResult, text: string): void {
  if (!text) return;

  // Inline tokens: **bold**, *italic*, `code`, ~~strike~~, [text](url)
  const stack: InlineToken[] = [];
  const buffer: string[] = [];
  const entities: MessageEntity[] = [];
  let pos = 0;

  const inlineRe = /(\*\*|__|\*|_|`|~~|\[)/g;
  let match: RegExpExecArray | null;

  while ((match = inlineRe.exec(text)) !== null) {
    const delim = match[0];
    const start = match.index;

    // Push any text before this delimiter
    if (start > pos) {
      buffer.push(text.slice(pos, start));
    }

    if (delim === "`") {
      // Inline code: find closing `
      const end = text.indexOf("`", start + 1);
      if (end === -1) {
        buffer.push(text.slice(start));
        pos = text.length;
        break;
      }
      buffer.push(text.slice(start + 1, end));
      entities.push({
        type: "code",
        offset: buffer.join("").length - (end - start - 1),
        length: end - start - 1,
      });
      pos = end + 1;
      inlineRe.lastIndex = pos;
      continue;
    }

    if (delim === "[") {
      // Link: [text](url)
      const closeBracket = text.indexOf("]", start + 1);
      if (closeBracket === -1 || text[closeBracket + 1] !== "(") {
        buffer.push("[");
        pos = start + 1;
        inlineRe.lastIndex = pos;
        continue;
      }
      const closeParen = text.indexOf(")", closeBracket + 1);
      if (closeParen === -1) {
        buffer.push("[");
        pos = start + 1;
        inlineRe.lastIndex = pos;
        continue;
      }
      const linkText = text.slice(start + 1, closeBracket);
      const url = text.slice(closeBracket + 2, closeParen);
      buffer.push(linkText);
      entities.push({
        type: "text_link",
        offset: buffer.join("").length - linkText.length,
        length: linkText.length,
        url,
      });
      pos = closeParen + 1;
      inlineRe.lastIndex = pos;
      continue;
    }

    // Bold (**text** or __text__) or italic (*text* or _text_)
    if (delim === "**" || delim === "__") {
      const endDelim = delim === "**" ? "**" : "__";
      const end = text.indexOf(endDelim, start + 2);
      if (end === -1) {
        buffer.push(delim);
        pos = start + delim.length;
        inlineRe.lastIndex = pos;
        continue;
      }
      const inner = text.slice(start + 2, end);
      buffer.push(inner);
      entities.push({
        type: "bold",
        offset: buffer.join("").length - inner.length,
        length: inner.length,
      });
      pos = end + 2;
      inlineRe.lastIndex = pos;
      continue;
    }

    if (delim === "*" || delim === "_") {
      // Single delimiter — italic, but check it's not a bold delimiter mistake
      // Skip if next char is also *
      if (text[start + 1] === "*") {
        buffer.push("*");
        pos = start + 1;
        inlineRe.lastIndex = pos;
        continue;
      }
      const end = text.indexOf(delim, start + 1);
      if (end === -1) {
        buffer.push(delim);
        pos = start + 1;
        inlineRe.lastIndex = pos;
        continue;
      }
      const inner = text.slice(start + 1, end);
      buffer.push(inner);
      entities.push({
        type: "italic",
        offset: buffer.join("").length - inner.length,
        length: inner.length,
      });
      pos = end + 1;
      inlineRe.lastIndex = pos;
      continue;
    }

    if (delim === "~~") {
      const end = text.indexOf("~~", start + 2);
      if (end === -1) {
        buffer.push("~~");
        pos = start + 2;
        inlineRe.lastIndex = pos;
        continue;
      }
      const inner = text.slice(start + 2, end);
      buffer.push(inner);
      entities.push({
        type: "strikethrough",
        offset: buffer.join("").length - inner.length,
        length: inner.length,
      });
      pos = end + 2;
      inlineRe.lastIndex = pos;
      continue;
    }

    // Unknown delimiter
    buffer.push(delim);
    pos = start + delim.length;
    inlineRe.lastIndex = pos;
  }

  // Remaining text
  if (pos < text.length) {
    buffer.push(text.slice(pos));
  }

  result.text += buffer.join("");
  for (const e of entities) {
    result.entities.push({
      type: e.type,
      offset: result.text.length - buffer.join("").length + e.offset,
      length: e.length,
      url: e.url,
      language: e.language,
    });
  }
}

// --- Pre blocks ---

function appendPre(result: RenderResult, text: string, language?: string): void {
  if (result.text.length > 0 && !result.text.endsWith("\n")) {
    result.text += "\n";
  }
  const offset = result.text.length;
  const lines = text.split("\n");
  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  const content = lines.join("\n");
  result.text += content + "\n";
  result.entities.push({ type: "pre", offset, length: content.length, language: language || undefined });
}

// --- Helpers ---

interface InlineToken {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
}

/**
 * Strip all Markdown formatting and return plain text.
 */
export function stripMarkdown(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|```/g, ""))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/^> /gm, "")
    .replace(/^#{1,3}\s/gm, "")
    .replace(/^[-*]\s/gm, "• ");
}
