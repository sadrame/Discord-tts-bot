import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { createReadStream } from "fs";
import { writeFile, unlink, mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

// Natural-sounding Microsoft neural TTS voice
const VOICE = "en-US-JennyNeural";

let tts: MsEdgeTTS | null = null;

async function getTTS(): Promise<MsEdgeTTS> {
  if (!tts) {
    tts = new MsEdgeTTS();
    await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  }
  return tts;
}

/**
 * Convert a chunk of text to an MP3 buffer.
 * Returns a temporary file path — caller is responsible for deleting it.
 */
export async function textToMp3File(text: string): Promise<string> {
  const engine = await getTTS();
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
 * Split long text into chunks that TTS can comfortably handle.
 * Splits on sentence boundaries to avoid mid-sentence cuts.
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
