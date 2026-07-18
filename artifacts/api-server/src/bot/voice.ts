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
import { textToMp3File, cleanupFile, splitIntoChunks } from "./tts.js";
import type { VoiceOption } from "./voices.js";
import { DEFAULT_VOICE } from "./voices.js";

export interface ReadSession {
  guildId: string;
  title: string;
  paragraphs: string[];
  paragraphIndex: number;
  chunkIndex: number;
  chunks: string[];
  paused: boolean;
  stopped: boolean;
  player: AudioPlayer;
  textChannel: TextBasedChannel;
}

const sessions = new Map<string, ReadSession>();

// Per-guild voice preference — read per-chunk so /voice takes effect immediately
const guildVoices = new Map<string, VoiceOption>();

export function getGuildVoice(guildId: string): VoiceOption {
  return guildVoices.get(guildId) ?? DEFAULT_VOICE;
}

export function setGuildVoice(guildId: string, voice: VoiceOption): void {
  guildVoices.set(guildId, voice);
  console.log(`[voice] guild ${guildId} voice → ${voice.id}`);
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
  const conn = getVoiceConnection(guildId);
  conn?.destroy();
}

export async function startReading(
  guild: Guild,
  voiceChannel: VoiceBasedChannel,
  textChannel: TextBasedChannel,
  title: string,
  paragraphs: string[]
): Promise<void> {
  stopSession(guild.id);

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });

  const session: ReadSession = {
    guildId: guild.id,
    title,
    paragraphs,
    paragraphIndex: 0,
    chunkIndex: 0,
    chunks: [],
    paused: false,
    stopped: false,
    player,
    textChannel,
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
  playNextChunk(session, connection);

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    stopSession(guild.id);
  });
}

async function playNextChunk(
  session: ReadSession,
  connection: VoiceConnection
): Promise<void> {
  if (session.stopped) return;
  if (session.paused) return;

  // Advance to next paragraph when current chunk list is exhausted
  while (session.chunkIndex >= session.chunks.length) {
    if (session.paragraphIndex >= session.paragraphs.length) {
      await safeSend(session.textChannel, `✅ Finished reading **${session.title}**!`);
      stopSession(session.guildId);
      return;
    }

    const para = session.paragraphs[session.paragraphIndex]!;
    session.chunks = splitIntoChunks(para);
    session.chunkIndex = 0;
    session.paragraphIndex++;

    // Progress update every 10 paragraphs
    if ((session.paragraphIndex - 1) % 10 === 0 && session.paragraphIndex > 1) {
      const pct = Math.round(((session.paragraphIndex - 1) / session.paragraphs.length) * 100);
      await safeSend(
        session.textChannel,
        `📖 Paragraph ${session.paragraphIndex - 1}/${session.paragraphs.length} (${pct}%)`
      );
    }
  }

  const chunk = session.chunks[session.chunkIndex]!;
  session.chunkIndex++;

  // Read the guild's current voice preference every chunk — so /voice mid-read works instantly
  const voice = getGuildVoice(session.guildId);

  let tmpFile: string | null = null;
  try {
    tmpFile = await textToMp3File(chunk, voice);

    if (session.stopped || session.paused) {
      if (tmpFile) await cleanupFile(tmpFile);
      return;
    }

    const resource = createAudioResource(tmpFile, { inputType: StreamType.Arbitrary });
    session.player.play(resource);

    await entersState(session.player, AudioPlayerStatus.Playing, 10_000);
    await entersState(session.player, AudioPlayerStatus.Idle, 300_000);
  } catch (err) {
    if (!session.stopped) {
      console.error(`[playNextChunk] TTS failed, skipping chunk: ${(err as Error).message}`);
      // Don't spam the channel — just log and move on
    }
  } finally {
    if (tmpFile) await cleanupFile(tmpFile);
  }

  // Small breathing room between chunks — reduces WS pressure on Edge TTS
  if (!session.stopped && !session.paused) {
    setTimeout(() => playNextChunk(session, connection), 150);
  }
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

  const connection = getVoiceConnection(guildId);
  if (connection) {
    setTimeout(() => playNextChunk(session, connection), 150);
  }
  return true;
}

export function skipParagraph(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;
  session.chunkIndex = session.chunks.length; // exhaust current paragraph
  session.player.stop();
  return true;
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
