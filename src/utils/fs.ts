import { promises as fs } from 'node:fs';
import { dirname, basename, join } from 'node:path';

export interface FileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size?: number;
  updatedAt?: Date;
}

export async function listDirectory(path: string): Promise<FileInfo[]> {
  try {
    const entries = await fs.readdir(path, { withFileTypes: true });
    const items: FileInfo[] = [];

    for (const entry of entries) {
      const fullPath = join(path, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        items.push({
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          size: stat.size,
          updatedAt: stat.mtime,
        });
      } catch {
        items.push({
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        });
      }
    }

    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    return items;
  } catch (err) {
    throw new Error(`Failed to read directory: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}
