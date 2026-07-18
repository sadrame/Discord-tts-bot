import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { VoiceOption } from "./voices.js";
import { DEFAULT_VOICE } from "./voices.js";

// One TTS engine instance per voice id (reused across chunks)
const engines = new Map<string, MsEdgeTTS>();

async function getEngine(voice: VoiceOption): Promise<MsEdgeTTS> {
  const existing = engines.get(voice.id);
  if (existing) return existing;

  const engine = new MsEdgeTTS();
  await engine.setMetadata(voice.id, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  engines.set(voice.id, engine);
  return engine;
}

/**
 * Convert text to an MP3 temp file using the given voice.
 * Caller is responsible for deleting the file via cleanupFile().
 */
export async function textToMp3File(
  text: string,
  voice: VoiceOption = DEFAULT_VOICE
): Promise<string> {
  const engine = await getEngine(voice);
  const filePath = join(tmpdir(), `wct-tts-${randomUUID()}.mp3`);

  await new Promise<void>((resolve, reject) => {
    const { audioStream } = engine.toStream(text);
    const chunks: Buffer[] = [];

    audioStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    audioStream.on("end", async () => {
      try {
        await writeFile(filePath, Buffer.concat(chunks));
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    audioStream.on("error", reject);
  });

  return filePath;
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
 */
export function splitIntoChunks(text: string, maxChars = 1000): string[] {
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
