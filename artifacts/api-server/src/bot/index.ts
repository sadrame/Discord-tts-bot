import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  GuildMember,
  TextChannel,
  ChatInputCommandInteraction,
  Interaction,
  REST,
  Routes,
} from "discord.js";
import { scrapeChapter } from "./scraper.js";
import {
  startReading,
  stopSession,
  pauseSession,
  resumeSession,
  skipParagraph,
  getSession,
  getGuildVoice,
  setGuildVoice,
} from "./voice.js";
import { VOICES, voiceListEmbed, findVoice, DEFAULT_VOICE } from "./voices.js";
import { slashCommands } from "./commands.js";

const PREFIX = "!";

// ─── Help text ───────────────────────────────────────────────────────────────

function helpText(): string {
  return [
    "📖 **WCT Reader Bot**",
    "",
    "`/read <url>` or `!read <url>` — fetch a chapter and read it in your voice channel",
    "`/stop` or `!stop` — stop reading and leave voice",
    "`/pause` or `!pause` — pause playback",
    "`/resume` or `!resume` — resume playback",
    "`/skip` or `!skip` — skip current paragraph",
    "`/progress` or `!progress` — show a progress bar",
    "`/voice [name]` or `!voice [name]` — change voice (no name = list voices)",
    "`/help` or `!help` — show this message",
  ].join("\n");
}

// ─── Progress bar ────────────────────────────────────────────────────────────

function buildProgressBar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

// ─── Shared command logic ────────────────────────────────────────────────────
// Each handler accepts the raw inputs and returns a reply string.
// Both slash and prefix handlers call into these.

async function handleRead(
  guildId: string,
  guildObj: import("discord.js").Guild,
  textChannel: TextChannel,
  voiceChannel: import("discord.js").VoiceBasedChannel | null | undefined,
  url: string
): Promise<string> {
  if (!url.startsWith("http")) {
    return "❌ Please provide a valid URL.";
  }
  if (!voiceChannel) {
    return "❌ You need to be in a voice channel first!";
  }

  // Initial ack — the real status comes via channel messages during reading
  let chapter;
  try {
    chapter = await scrapeChapter(url);
  } catch (err) {
    return `❌ Could not read that page: ${(err as Error).message}`;
  }

  const voice = getGuildVoice(guildId);
  const reply =
    `📖 Starting **${chapter.title}** (${chapter.paragraphs.length} paragraphs)\n` +
    `🎙️ Voice: **${voice.label}** — ${voice.accent} ${voice.gender}`;

  // Fire-and-forget — reading happens in background
  startReading(guildObj, voiceChannel, textChannel, chapter.title, chapter.paragraphs).catch(
    async (err) => {
      await textChannel.send(`❌ Voice error: ${(err as Error).message}`);
    }
  );

  return reply;
}

function handleStop(guildId: string): string {
  if (!getSession(guildId)) return "❌ Nothing is currently playing.";
  stopSession(guildId);
  return "⏹️ Stopped reading and left the voice channel.";
}

function handlePause(guildId: string): string {
  return pauseSession(guildId)
    ? "⏸️ Paused. Use `/resume` or `!resume` to continue."
    : "❌ Nothing is playing or already paused.";
}

function handleResume(guildId: string): string {
  return resumeSession(guildId) ? "▶️ Resuming..." : "❌ Nothing is paused.";
}

function handleSkip(guildId: string): string {
  return skipParagraph(guildId)
    ? "⏭️ Skipping to next paragraph..."
    : "❌ Nothing is currently playing.";
}

function handleProgress(guildId: string): string {
  const session = getSession(guildId);
  if (!session) return "❌ Nothing is currently playing.";
  const pct = Math.round((session.paragraphIndex / session.paragraphs.length) * 100);
  const bar = buildProgressBar(pct);
  return (
    `📖 **${session.title}**\n` +
    `${bar} ${pct}%\n` +
    `Paragraph ${session.paragraphIndex}/${session.paragraphs.length}` +
    (session.paused ? " *(paused)*" : "")
  );
}

function handleVoice(guildId: string, name?: string): string {
  if (!name) return voiceListEmbed();

  const match = findVoice(name);
  if (!match) {
    return (
      `❌ Voice **${name}** not found. Use \`/voice\` (no name) or \`!voice\` to see the full list.`
    );
  }
  setGuildVoice(guildId, match);
  return `✅ Voice set to **${match.label}** (${match.accent} ${match.gender} — ${match.style ?? ""})`;
}

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ─── Ready: register slash commands ──────────────────────────────────────────

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ WCT Reader Bot ready! Logged in as ${c.user.tag}`);
  c.user.setActivity("📖 !help or /help");

  // Register slash commands globally
  try {
    const rest = new REST().setToken(process.env["DISCORD_BOT_TOKEN"]!);
    await rest.put(Routes.applicationCommands(c.user.id), {
      body: slashCommands,
    });
    console.log("✅ Slash commands registered globally.");
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
});

// ─── Slash command handler ────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) {
    await interaction.reply({ content: "❌ This bot only works in servers.", ephemeral: true });
    return;
  }

  const cmd = interaction as ChatInputCommandInteraction;
  const guildId = interaction.guild.id;
  const member = interaction.member as GuildMember | null;
  const voiceChannel = member?.voice?.channel ?? null;
  const textChannel = interaction.channel as TextChannel;

  // Defer for potentially slow operations
  const slow = ["read"].includes(cmd.commandName);
  if (slow) await cmd.deferReply();

  let reply = "";

  try {
    switch (cmd.commandName) {
      case "read": {
        const url = cmd.options.getString("url", true);
        reply = await handleRead(guildId, interaction.guild, textChannel, voiceChannel, url);
        break;
      }
      case "stop":     reply = handleStop(guildId);     break;
      case "pause":    reply = handlePause(guildId);    break;
      case "resume":   reply = handleResume(guildId);   break;
      case "skip":     reply = handleSkip(guildId);     break;
      case "progress": reply = handleProgress(guildId); break;
      case "voice": {
        const name = cmd.options.getString("name") ?? undefined;
        reply = handleVoice(guildId, name);
        break;
      }
      case "help": reply = helpText(); break;
      default:     reply = "❓ Unknown command."; break;
    }
  } catch (err) {
    reply = `❌ Error: ${(err as Error).message}`;
  }

  if (slow) {
    await cmd.editReply(reply);
  } else {
    await cmd.reply(reply);
  }
});

// ─── Prefix command handler ───────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();
  const guildId = message.guild.id;
  const member = message.member as GuildMember | null;
  const voiceChannel = member?.voice?.channel ?? null;
  const textChannel = message.channel as TextChannel;

  let reply = "";

  try {
    switch (command) {
      case "read": {
        const url = args[0] ?? "";
        const placeholder = await message.reply("🔍 Fetching chapter...");
        reply = await handleRead(guildId, message.guild, textChannel, voiceChannel, url);
        await placeholder.edit(reply);
        return; // already replied
      }
      case "stop":     reply = handleStop(guildId);          break;
      case "pause":    reply = handlePause(guildId);         break;
      case "resume":   reply = handleResume(guildId);        break;
      case "skip":     reply = handleSkip(guildId);          break;
      case "progress": reply = handleProgress(guildId);      break;
      case "voice":    reply = handleVoice(guildId, args[0]); break;
      case "help":     reply = helpText();                    break;
      default: return; // ignore unknown prefix commands silently
    }
  } catch (err) {
    reply = `❌ Error: ${(err as Error).message}`;
  }

  await message.reply(reply);
});

// ─── Start ────────────────────────────────────────────────────────────────────

const token = process.env["DISCORD_BOT_TOKEN"];
if (!token) {
  console.error("DISCORD_BOT_TOKEN is not set.");
  process.exit(1);
}

client.login(token).catch((err) => {
  console.error("Failed to log in:", err);
  process.exit(1);
});
