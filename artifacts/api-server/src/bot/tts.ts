import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { VoiceOption } from "./voices.js";
import { DEFAULT_VOICE } from "./voices.js";

// One engine per voice — but we trash and recreate it on any error
// because a dropped WebSocket leaves the instance unusable.
const engines = new Map<string, MsEdgeTTS>();

async function freshEngine(voice: VoiceOption): Promise<MsEdgeTTS> {
  // Always delete first so we get a brand-new WebSocket connection
  engines.delete(voice.id);
  const engine = new MsEdgeTTS();
  await engine.setMetadata(voice.id, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  engines.set(voice.id, engine);
  return engine;
}

async function getEngine(voice: VoiceOption): Promise<MsEdgeTTS> {
  const existing = engines.get(voice.id);
  if (existing) return existing;
  return freshEngine(voice);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Convert text to an MP3 temp file.
 * Retries up to 3 times, recreating the WebSocket engine on each failure.
 * Caller must delete the file with cleanupFile() when done.
 */
export async function textToMp3File(
  text: string,
  voice: VoiceOption = DEFAULT_VOICE
): Promise<string> {
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const engine = attempt === 1 ? await getEngine(voice) : await freshEngine(voice);
    const filePath = join(tmpdir(), `wct-tts-${randomUUID()}.mp3`);

    try {
      await new Promise<void>((resolve, reject) => {
        const { audioStream } = engine.toStream(text);
        const chunks: Buffer[] = [];

        audioStream.on("data", (chunk: Buffer) => chunks.push(chunk));
        audioStream.on("end", async () => {
          try {
            const buf = Buffer.concat(chunks);
            if (buf.length === 0) {
              reject(new Error("Empty audio stream received"));
              return;
            }
            await writeFile(filePath, buf);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        audioStream.on("error", reject);
      });

      return filePath; // success
    } catch (err) {
      // Trash this engine so the next attempt gets a clean connection
      engines.delete(voice.id);
      // Clean up any partial file
      await unlink(filePath).catch(() => {});

      if (attempt === MAX_RETRIES) throw err;

      const delay = attempt * 1000; // 1 s, 2 s
      console.warn(`[tts] attempt ${attempt} failed (${(err as Error).message}), retrying in ${delay}ms…`);
      await sleep(delay);
    }
  }

  throw new Error("TTS failed after all retries");
}

export async function cleanupFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // ignore
  }
}

/**
 * Split long text into TTS-friendly chunks at sentence boundaries.
 * Shorter chunks (≤500 chars) are more reliable with the Edge WS API.
 */
export function splitIntoChunks(text: string, maxChars = 500): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
