---
name: Edge TTS single WebSocket fix
description: Why non-Jenny voices fail and how the single-engine + rawToStream fix works
---

## The Problem
`msedge-tts` creates a new WebSocket to Microsoft's Edge TTS server per `MsEdgeTTS` instance. Rapid connection creation (one per voice, one per chunk) causes Microsoft to rate-limit/drop connections — specifically for non-default voices. Jenny (en-US-JennyNeural) always works because it's Microsoft's default and gets preferential treatment.

## The Fix
Use ONE shared `MsEdgeTTS` instance for ALL voices. Specify the voice per-request by calling `engine.rawToStream(ssml)` instead of `engine.toStream(text)`, with a hand-built SSML `<voice name="en-US-BrandonNeural">` element embedded in each request.

**Why:** `rawToStream` bypasses the library's `_SSMLTemplate` (which bakes in `this._voice` from `setMetadata`). The voice is inside the SSML payload, not the WebSocket connection — so voice switching costs zero new connections.

**How to apply:** In `tts.ts`:
- One `sharedEngine: MsEdgeTTS | null` — created once with Jenny as the base via `setMetadata`
- `buildSsml(text, voiceId)` constructs the SSML with voice embedded; locale inferred from voiceId (`en-US-JennyNeural` → `en-US`)
- `synthesize()` calls `engine.rawToStream(ssml)` 
- On failure: call `invalidateEngine()` to null out sharedEngine; next attempt reconnects fresh
- Global semaphore still held for entire `textToMp3File` call (all retries) to prevent concurrent connections

## Bookmarks path
Use `process.cwd()` (not `import.meta.url`) for the `data/bookmarks.json` path — works on Render, Railway, Fly.io, and local dev without path-resolution issues from tsx/ESM.
