import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
  GuildMember,
} from "discord.js";
import { scrapeChapter } from "./scraper.js";
import {
  startReading,
  stopSession,
  pauseSession,
  resumeSession,
  skipParagraph,
  getSession,
} from "./voice.js";

const PREFIX = "!";

const COMMANDS = `
📖 **WCT Reader Bot Commands**
\`!read <url>\` — Scrape a chapter URL and read it in your voice channel
\`!stop\` — Stop reading and leave the voice channel
\`!pause\` — Pause reading
\`!resume\` — Resume reading
\`!skip\` — Skip the current paragraph
\`!progress\` — Show current reading progress
\`!help\` — Show this message
`.trim();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ WCT Reader Bot ready! Logged in as ${c.user.tag}`);
  c.user.setActivity("📖 Ready to read chapters");
});

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  try {
    switch (command) {
      case "help":
        await message.reply(COMMANDS);
        break;

      case "read": {
        const url = args[0];
        if (!url || !url.startsWith("http")) {
          await message.reply("❌ Please provide a valid URL.\nUsage: `!read <url>`");
          return;
        }

        const member = message.member as GuildMember | null;
        const voiceChannel = member?.voice?.channel;
        if (!voiceChannel) {
          await message.reply("❌ You need to be in a voice channel first!");
          return;
        }

        const statusMsg = await message.reply(`🔍 Fetching chapter from <${url}>...`);

        let chapter;
        try {
          chapter = await scrapeChapter(url);
        } catch (err) {
          await statusMsg.edit(`❌ Could not read that page: ${(err as Error).message}`);
          return;
        }

        await statusMsg.edit(
          `📖 Starting to read **${chapter.title}** (${chapter.paragraphs.length} paragraphs)\n` +
          `Voice: **Jenny** (Microsoft Neural TTS)`
        );

        try {
          await startReading(
            message.guild,
            voiceChannel,
            message.channel as TextChannel,
            chapter.title,
            chapter.paragraphs
          );
        } catch (err) {
          await message.channel.send(`❌ Voice error: ${(err as Error).message}`);
        }
        break;
      }

      case "stop": {
        const session = getSession(message.guild.id);
        if (!session) {
          await message.reply("❌ Nothing is currently playing.");
          return;
        }
        stopSession(message.guild.id);
        await message.reply("⏹️ Stopped reading and left the voice channel.");
        break;
      }

      case "pause": {
        if (pauseSession(message.guild.id)) {
          await message.reply("⏸️ Paused. Use `!resume` to continue.");
        } else {
          await message.reply("❌ Nothing is playing or already paused.");
        }
        break;
      }

      case "resume": {
        if (resumeSession(message.guild.id)) {
          await message.reply("▶️ Resuming...");
        } else {
          await message.reply("❌ Nothing is paused.");
        }
        break;
      }

      case "skip": {
        if (skipParagraph(message.guild.id)) {
          await message.reply("⏭️ Skipping to next paragraph...");
        } else {
          await message.reply("❌ Nothing is currently playing.");
        }
        break;
      }

      case "progress": {
        const session = getSession(message.guild.id);
        if (!session) {
          await message.reply("❌ Nothing is currently playing.");
          return;
        }
        const pct = Math.round(
          (session.paragraphIndex / session.paragraphs.length) * 100
        );
        const bar = buildProgressBar(pct);
        await message.reply(
          `📖 **${session.title}**\n` +
          `${bar} ${pct}%\n` +
          `Paragraph ${session.paragraphIndex}/${session.paragraphs.length}` +
          (session.paused ? " *(paused)*" : "")
        );
        break;
      }

      default:
        // Unknown command — ignore silently
        break;
    }
  } catch (err) {
    console.error("Command error:", err);
    try {
      await message.reply(`❌ An error occurred: ${(err as Error).message}`);
    } catch {
      // ignore
    }
  }
});

function buildProgressBar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

const token = process.env["DISCORD_BOT_TOKEN"];
if (!token) {
  console.error("DISCORD_BOT_TOKEN environment variable is not set.");
  process.exit(1);
}

client.login(token).catch((err) => {
  console.error("Failed to log in:", err);
  process.exit(1);
});
