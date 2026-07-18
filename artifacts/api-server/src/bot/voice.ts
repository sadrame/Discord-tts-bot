import {
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  AudioPlayer,
  AudioPlayerStatus,
  VoiceConnection,
} from "@discordjs/voice";
import {
  VoiceBasedChannel,
  TextBasedChannel,
  Guild,
} from "discord.js";
import { textToMp3File, cleanupFile, splitIntoChunks, warmUpVoice } from "./tts.js";
import type { VoiceOption } from "./voices.js";
import { DEFAULT_VOICE } from "./voices.js";

export interface ReadSession {
  guildId: string;
  title: string;
  allChunks: string[];   // flat list of every text chunk across all paragraphs
  chunkIndex: number;    // where we are in allChunks
  paused: boolean;
  stopped: boolean;
  player: AudioPlayer;
  textChannel: TextBasedChannel;
  // For progress display
  totalParagraphs: number;
}

const sessions = new Map<string, ReadSession>();
const guildVoices = new Map<string, VoiceOption>();

export function getGuildVoice(guildId: string): VoiceOption {
  return guildVoices.get(guildId) ?? DEFAULT_VOICE;
}

export function setGuildVoice(guildId: string, voice: VoiceOption): void {
  guildVoices.set(guildId, voice);
  console.log(`[voice] guild ${guildId} → ${voice.id}`);
  // Pre-warm the WebSocket for this voice so the pipeline doesn't cold-start it
  warmUpVoice(voice);
}

export function getSession(guildId: string): ReadSession | undefined {
  return sessions.get(guildId);
}

export function stopSession(guildId: string): void {
  const session = sessions.get(guildId);
  if (session) {
    session.stopped = true;
    session.player.stop(true);
  }
  sessions.delete(guildId);
  getVoiceConnection(guildId)?.destroy();
}

export async function startReading(
  guild: Guild,
  voiceChannel: VoiceBasedChannel,
  textChannel: TextBasedChannel,
  title: string,
  paragraphs: string[]
): Promise<void> {
  stopSession(guild.id);

  // Flatten all paragraphs into one chunk list up front
  const allChunks: string[] = [];
  for (const para of paragraphs) {
    allChunks.push(...splitIntoChunks(para));
  }

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });

  const session: ReadSession = {
    guildId: guild.id,
    title,
    allChunks,
    chunkIndex: 0,
    paused: false,
    stopped: false,
    player,
    textChannel,
    totalParagraphs: paragraphs.length,
  };

  sessions.set(guild.id, session);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch {
    stopSession(guild.id);
    throw new Error("Could not connect to the voice channel within 15 seconds.");
  }

  connection.subscribe(player);
  connection.on(VoiceConnectionStatus.Disconnected, () => stopSession(guild.id));

  // Run the pipeline — don't await, let it run in background
  runPipeline(session, connection).catch((err) =>
    console.error("[pipeline] uncaught:", err)
  );
}

/**
 * Pipelined reading loop:
 *   While chunk N is *playing*, chunk N+1 is already being *generated*.
 *   This eliminates the gap between sentences.
 */
async function runPipeline(session: ReadSession, connection: VoiceConnection): Promise<void> {
  // Pre-generate the very first chunk
  let nextFile = await generateChunk(session);

  while (nextFile !== null && !session.stopped) {
    if (session.paused) {
      // Clean up the pre-generated file and wait until resumed
      await cleanupFile(nextFile);
      nextFile = null;

      // Poll for resume
      while (session.paused && !session.stopped) {
        await sleep(200);
      }
      if (session.stopped) break;

      // Regenerate from current position after resume
      nextFile = await generateChunk(session);
      continue;
    }

    const currentFile = nextFile;

    // Kick off generation of the NEXT chunk in parallel while this one plays
    const nextGenPromise = generateChunk(session);

    // Play the current chunk
    try {
      const resource = createAudioResource(currentFile, { inputType: StreamType.Arbitrary });
      session.player.play(resource);
      await entersState(session.player, AudioPlayerStatus.Playing, 10_000);
      await entersState(session.player, AudioPlayerStatus.Idle, 300_000);
    } catch (err) {
      console.error("[pipeline] play error:", (err as Error).message);
    } finally {
      await cleanupFile(currentFile);
    }

    // Grab the pre-generated next chunk (usually already ready by now)
    nextFile = await nextGenPromise;
  }

  if (!session.stopped) {
    await safeSend(session.textChannel, `✅ Finished reading **${session.title}**!`);
    stopSession(session.guildId);
  }
}

/**
 * Generate the TTS file for the current chunk and advance the index.
 * Returns null when there are no more chunks.
 */
async function generateChunk(session: ReadSession): Promise<string | null> {
  // Skip over any already-consumed index (e.g. after a skip)
  while (session.chunkIndex < session.allChunks.length) {
    const text = session.allChunks[session.chunkIndex]!;
    session.chunkIndex++;

    // Progress update every 20 chunks
    if (session.chunkIndex % 20 === 0) {
      const pct = Math.round((session.chunkIndex / session.allChunks.length) * 100);
      safeSend(session.textChannel, `📖 ${pct}% through **${session.title}**`).catch(() => {});
    }

    if (session.stopped) return null;

    const voice = getGuildVoice(session.guildId); // re-read every chunk so /voice works mid-read

    try {
      const file = await textToMp3File(text, voice);
      return file;
    } catch (err) {
      // Log but don't send to channel — just skip the chunk silently
      console.error(`[generateChunk] skipping chunk after TTS failure: ${(err as Error).message}`);
      // continue to next chunk in the loop
    }
  }

  return null; // all chunks exhausted
}

export function pauseSession(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session || session.paused) return false;
  session.paused = true;
  session.player.pause();
  return true;
}

export function resumeSession(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session || !session.paused) return false;
  session.paused = false;
  session.player.unpause();
  return true;
}

export function skipParagraph(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;
  // Advance ~10 chunks (roughly one paragraph worth)
  session.chunkIndex = Math.min(session.chunkIndex + 10, session.allChunks.length);
  session.player.stop(); // triggers Idle → pipeline moves on
  return true;
}

export function getProgressInfo(guildId: string): { index: number; total: number; title: string; paused: boolean } | null {
  const session = sessions.get(guildId);
  if (!session) return null;
  return {
    index: session.chunkIndex,
    total: session.allChunks.length,
    title: session.title,
    paused: session.paused,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeSend(channel: TextBasedChannel, content: string): Promise<void> {
  try {
    if ("send" in channel) {
      await (channel as { send(content: string): Promise<unknown> }).send(content);
    }
  } catch (err) {
    console.error("[safeSend]", err);
  }
}
