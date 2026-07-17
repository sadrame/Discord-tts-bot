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
  // Clean up any existing session
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

  // Join voice channel
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch {
    stopSession(guild.id);
    throw new Error("Could not connect to voice channel within 15 seconds.");
  }

  connection.subscribe(player);

  // Start reading paragraphs
  playNextChunk(session, connection);

  // Handle disconnection
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    stopSession(guild.id);
  });
}

async function playNextChunk(
  session: ReadSession,
  connection: VoiceConnection
): Promise<void> {
  if (session.stopped) return;
  if (session.paused) {
    // Will be resumed by resumeSession()
    return;
  }

  // Build chunk list for current paragraph if exhausted
  while (session.chunkIndex >= session.chunks.length) {
    if (session.paragraphIndex >= session.paragraphs.length) {
      // Done reading
      await sendMessage(session.textChannel, `✅ Finished reading **${session.title}**!`);
      stopSession(session.guildId);
      return;
    }

    const para = session.paragraphs[session.paragraphIndex]!;
    session.chunks = splitIntoChunks(para);
    session.chunkIndex = 0;
    session.paragraphIndex++;

    // Announce chapter progress every ~10 paragraphs
    if ((session.paragraphIndex - 1) % 10 === 0 && session.paragraphIndex > 1) {
      const pct = Math.round(((session.paragraphIndex - 1) / session.paragraphs.length) * 100);
      await sendMessage(
        session.textChannel,
        `📖 Reading paragraph ${session.paragraphIndex - 1}/${session.paragraphs.length} (${pct}%)`
      );
    }
  }

  const chunk = session.chunks[session.chunkIndex]!;
  session.chunkIndex++;

  let tmpFile: string | null = null;
  try {
    tmpFile = await textToMp3File(chunk);
    if (session.stopped || session.paused) {
      await cleanupFile(tmpFile);
      return;
    }

    const resource = createAudioResource(tmpFile, {
      inputType: StreamType.Arbitrary,
    });

    session.player.play(resource);

    await entersState(session.player, AudioPlayerStatus.Playing, 10_000);
    await entersState(session.player, AudioPlayerStatus.Idle, 300_000);
  } catch (err) {
    if (!session.stopped) {
      await sendMessage(
        session.textChannel,
        `⚠️ TTS error on chunk, skipping: ${(err as Error).message}`
      );
    }
  } finally {
    if (tmpFile) await cleanupFile(tmpFile);
  }

  // Continue next chunk (recurse via setImmediate to avoid stack overflow on long chapters)
  if (!session.stopped && !session.paused) {
    setImmediate(() => playNextChunk(session, connection));
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
    playNextChunk(session, connection);
  }
  return true;
}

export function skipParagraph(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;

  // Jump to next paragraph
  session.chunkIndex = session.chunks.length; // exhaust current paragraph chunks
  session.player.stop(); // triggers next chunk via the Idle state
  return true;
}

async function sendMessage(channel: TextBasedChannel, content: string): Promise<void> {
  try {
    if ("send" in channel) {
      await (channel as { send(content: string): Promise<unknown> }).send(content);
    }
  } catch {
    // ignore
  }
}
