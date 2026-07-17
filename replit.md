# WCT Reader Bot

A Discord bot that joins voice channels and reads web novel chapters aloud using Microsoft Neural TTS (Jenny voice). Share a chapter link in any channel and the bot scrapes the text, joins your voice channel, and reads it like Eleven Reader — but for Discord.

## Run & Operate

- `pnpm --filter @workspace/api-server run bot` — run the Discord bot (workflow: "Discord Bot")
- `pnpm run typecheck` — full typecheck across all packages

## Bot Commands

| Command | Description |
|---|---|
| `!read <url>` | Scrape a chapter URL and read it in your voice channel |
| `!stop` | Stop reading and leave voice |
| `!pause` | Pause playback |
| `!resume` | Resume playback |
| `!skip` | Skip current paragraph |
| `!progress` | Show reading progress bar |
| `!help` | Show command list |

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Discord: discord.js v14 + @discordjs/voice
- TTS: Microsoft Edge Neural TTS (`msedge-tts`, no API key required)
- Scraping: axios + cheerio
- Audio: opusscript (pure JS Opus encoder) + system ffmpeg

## Where things live

- `artifacts/api-server/src/bot/index.ts` — bot entry point, command handlers
- `artifacts/api-server/src/bot/scraper.ts` — URL scraper (WCT + generic sites)
- `artifacts/api-server/src/bot/tts.ts` — Microsoft Neural TTS wrapper
- `artifacts/api-server/src/bot/voice.ts` — voice channel session management

## Architecture decisions

- TTS runs sentence-by-sentence via streaming so long chapters don't need to buffer fully before playback starts.
- Each guild gets one active `ReadSession`; starting a new `!read` replaces the existing one.
- opusscript used instead of native @discordjs/opus to avoid native build requirements on Replit.
- Scraper tries site-specific selectors first (WCT), falls back to generic article/entry-content selectors.

## Discord Bot Setup

Requires in Discord Developer Portal (discord.com/developers/applications):
- **Privileged Gateway Intents**: Message Content Intent ✅
- **Bot Permissions**: Send Messages, Read Message History, Connect, Speak, View Channels

Required secret: `DISCORD_BOT_TOKEN`

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._
