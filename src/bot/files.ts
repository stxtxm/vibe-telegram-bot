import { promises as fs } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { InlineKeyboard } from 'grammy';
import { logger } from '../utils/logger.js';
import { listDirectory, formatFileSize, type FileInfo } from '../utils/fs.js';
import type { SessionManager } from '../acp/session.js';

const ITEMS_PER_PAGE = 10;

export interface FileAction {
  action: string;
  path: string;
  sessionId?: string;
  page?: number;
}

// Maps callback index -> path for file menu navigation
// Reset on each buildFileMenu call
let pathIndex = 0;
const pathMap = new Map<number, string>();

export function isFileAction(data: string): boolean {
  return data.startsWith('f:');
}

export function parseFileAction(data: string): FileAction | null {
  const parts = data.split(':');
  if (parts.length < 2) return null;

  const action = parts[1];

  if (action === 'd' || action === 'p') {
    const idx = parseInt(parts[2], 10);
    const path = pathMap.get(idx);
    if (!path) return null;
    return { action: action === 'd' ? 'dir' : 'parent', path };
  }

  if (action === 'n' || action === 'v') {
    const idx = parseInt(parts[2], 10);
    const path = pathMap.get(idx);
    if (!path) return null;
    return { action: action === 'n' ? 'view' : 'dir', path };
  }

  if (action === 's') {
    const sessionId = parts[2];
    const idx = parseInt(parts[3], 10);
    const path = pathMap.get(idx);
    if (!path) return null;
    return { action: 'set_cwd', path, sessionId };
  }

  if (action === 'g') {
    const page = parseInt(parts[2], 10);
    const idx = parseInt(parts[3], 10);
    const path = pathMap.get(idx);
    if (!path) return null;
    return { action: 'page', path, page };
  }

  if (action === 'x') {
    return { action: 'cancel', path: '' };
  }

  return null;
}

function storePath(p: string): number {
  const idx = pathIndex++;
  pathMap.set(idx, p);
  return idx;
}

export async function buildFileMenu(
  currentPath: string,
  page: number = 0,
  sessionId?: string
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  // Reset path map
  pathIndex = 0;
  pathMap.clear();

  const kb = new InlineKeyboard();
  const items = await listDirectory(currentPath);
  const start = page * ITEMS_PER_PAGE;
  const pageItems = items.slice(start, start + ITEMS_PER_PAGE);
  const totalPages = Math.ceil(items.length / ITEMS_PER_PAGE);

  // Parent directory button (unless at root)
  if (currentPath !== '/') {
    const parentPath = dirname(currentPath);
    kb.text('📁 ..', `f:p:${storePath(parentPath)}`).row();
  }

  // Directory items
  for (const item of pageItems) {
    const icon = item.isDirectory ? '📁' : '📄';
    const displayName = item.name.length > 25
      ? item.name.slice(0, 22) + '...'
      : item.name;
    const sizeInfo = item.isFile && item.size ? ` (${formatFileSize(item.size)})` : '';
    const label = `${icon} ${displayName}${sizeInfo}`;
    const action = item.isDirectory ? 'd' : 'n';
    kb.text(label, `f:${action}:${storePath(item.path)}`).row();
  }

  // Pagination
  if (totalPages > 1) {
    const navButtons: { text: string; callback: string }[] = [];
    if (page > 0) {
      navButtons.push({
        text: '⬅️ Prev',
        callback: `f:g:${page - 1}:${storePath(currentPath)}`
      });
    }
    if (start + ITEMS_PER_PAGE < items.length) {
      navButtons.push({
        text: 'Next ➡️',
        callback: `f:g:${page + 1}:${storePath(currentPath)}`
      });
    }

    if (navButtons.length === 1) {
      kb.text(navButtons[0].text, navButtons[0].callback).row();
    } else if (navButtons.length === 2) {
      kb.text(navButtons[0].text, navButtons[0].callback)
        .text(navButtons[1].text, navButtons[1].callback)
        .row();
    }
  }

  // Set as session dir
  if (sessionId) {
    kb.text('🗂️ Set as Session Dir', `f:s:${sessionId}:${storePath(currentPath)}`).row();
  }
  kb.text('❌ Close', 'f:x').row();

  const header = `📂 **Files** (${start + 1}-${start + pageItems.length} of ${items.length})`;
  const pathInfo = `Path: \`${currentPath}\``;

  return {
    text: `${header}\n${pathInfo}`,
    keyboard: kb,
  };
}

export async function getFileContent(filePath: string, maxLength: number = 3000): Promise<string> {
  const content = await fs.readFile(filePath, 'utf-8');
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + '\n\n... (file truncated)';
}

export async function changeDirectory(
  sessionManager: SessionManager,
  sessionId: string,
  newPath: string
): Promise<string> {
  const session = sessionManager.getSession(sessionId);
  if (!session) throw new Error("Session not found");

  let resolvedPath: string;
  if (newPath.startsWith('/')) {
    resolvedPath = newPath;
  } else {
    resolvedPath = join(session.cwd || '/', newPath);
  }

  const stats = await fs.stat(resolvedPath);
  if (!stats.isDirectory()) {
    throw new Error(`\`${resolvedPath}\` is not a directory`);
  }

  session.cwd = resolvedPath;
  await sessionManager.saveCwd(resolvedPath);
  return resolvedPath;
}
