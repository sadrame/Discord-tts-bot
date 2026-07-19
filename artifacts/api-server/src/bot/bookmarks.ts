/**
 * Persistent chapter bookmarks — one per guild.
 * Saved to disk so progress survives bot restarts.
 */
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

// process.cwd() is the working directory of the bot process — writable on
// Render, Railway, Fly.io, and local dev. Falls back to /tmp if that fails.
const DATA_DIR  = join(process.cwd(), "data");
const DATA_FILE = join(DATA_DIR, "bookmarks.json");

interface Bookmark {
  url: string;
  chunkIndex: number;
  totalChunks: number;
  title: string;
  savedAt: string;
}

type BookmarkStore = Record<string, Bookmark>;

async function load(): Promise<BookmarkStore> {
  try {
    const raw = await readFile(DATA_FILE, "utf-8");
    return JSON.parse(raw) as BookmarkStore;
  } catch {
    return {};
  }
}

async function persist(store: BookmarkStore): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    console.error("[bookmarks] Failed to save:", err);
  }
}

export async function saveBookmark(
  guildId: string,
  url: string,
  chunkIndex: number,
  totalChunks: number,
  title: string,
): Promise<void> {
  if (chunkIndex <= 0) return; // nothing worth saving
  const store = await load();
  store[guildId] = { url, chunkIndex, totalChunks, title, savedAt: new Date().toISOString() };
  await persist(store);
}

export async function getBookmark(guildId: string): Promise<Bookmark | null> {
  const store = await load();
  return store[guildId] ?? null;
}

export async function clearBookmark(guildId: string): Promise<void> {
  const store = await load();
  if (!(guildId in store)) return;
  delete store[guildId];
  await persist(store);
}
