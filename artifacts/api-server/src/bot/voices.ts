/**
 * Curated Microsoft Edge Neural TTS voices — high quality, no API key needed.
 * Same underlying engine as Azure Cognitive Services / Eleven Reader's web voices.
 */
export interface VoiceOption {
  id: string;           // msedge-tts voice name
  label: string;        // friendly display name
  accent: string;       // accent / region
  gender: "Male" | "Female";
  style?: string;       // personality note
}

export const VOICES: VoiceOption[] = [
  // ── American English ──
  { id: "en-US-JennyNeural",    label: "Jenny",    accent: "American",   gender: "Female", style: "Friendly, warm" },
  { id: "en-US-AriaNeural",     label: "Aria",     accent: "American",   gender: "Female", style: "Expressive, clear" },
  { id: "en-US-EmmaNeural",     label: "Emma",     accent: "American",   gender: "Female", style: "Expressive" },
  { id: "en-US-SaraNeural",     label: "Sara",     accent: "American",   gender: "Female", style: "Cheerful" },
  { id: "en-US-NancyNeural",    label: "Nancy",    accent: "American",   gender: "Female", style: "Pleasant" },
  { id: "en-US-GuyNeural",      label: "Guy",      accent: "American",   gender: "Male",   style: "Professional" },
  { id: "en-US-DavisNeural",    label: "Davis",    accent: "American",   gender: "Male",   style: "Casual" },
  { id: "en-US-JasonNeural",    label: "Jason",    accent: "American",   gender: "Male",   style: "Calm" },
  { id: "en-US-TonyNeural",     label: "Tony",     accent: "American",   gender: "Male",   style: "Confident" },
  { id: "en-US-BrandonNeural",  label: "Brandon",  accent: "American",   gender: "Male",   style: "Deep, steady" },
  { id: "en-US-EricNeural",     label: "Eric",     accent: "American",   gender: "Male",   style: "Smooth" },
  { id: "en-US-RogerNeural",    label: "Roger",    accent: "American",   gender: "Male",   style: "Conversational" },
  // ── British English ──
  { id: "en-GB-SoniaNeural",    label: "Sonia",    accent: "British",    gender: "Female", style: "Clear, crisp" },
  { id: "en-GB-LibbyNeural",    label: "Libby",    accent: "British",    gender: "Female", style: "Warm" },
  { id: "en-GB-MaisieNeural",   label: "Maisie",   accent: "British",    gender: "Female", style: "Youthful" },
  { id: "en-GB-RyanNeural",     label: "Ryan",     accent: "British",    gender: "Male",   style: "Natural" },
  { id: "en-GB-ThomasNeural",   label: "Thomas",   accent: "British",    gender: "Male",   style: "Deep, authoritative" },
  // ── Australian English ──
  { id: "en-AU-NatashaNeural",  label: "Natasha",  accent: "Australian", gender: "Female", style: "Bright, clear" },
  { id: "en-AU-WilliamNeural",  label: "William",  accent: "Australian", gender: "Male",   style: "Relaxed" },
  // ── Irish ──
  { id: "en-IE-EmilyNeural",    label: "Emily",    accent: "Irish",      gender: "Female", style: "Lilting" },
  { id: "en-IE-ConnorNeural",   label: "Connor",   accent: "Irish",      gender: "Male",   style: "Warm" },
];

export const DEFAULT_VOICE = VOICES[0]!; // Jenny

export function findVoice(query: string): VoiceOption | undefined {
  const q = query.toLowerCase().trim();
  return (
    VOICES.find((v) => v.id.toLowerCase() === q) ??
    VOICES.find((v) => v.label.toLowerCase() === q) ??
    VOICES.find(
      (v) =>
        v.label.toLowerCase().includes(q) ||
        v.accent.toLowerCase().includes(q)
    )
  );
}

export function voiceListEmbed(): string {
  const byAccent = new Map<string, VoiceOption[]>();
  for (const v of VOICES) {
    if (!byAccent.has(v.accent)) byAccent.set(v.accent, []);
    byAccent.get(v.accent)!.push(v);
  }

  const lines: string[] = ["🎙️ **Available Voices** — use `/voice name:<name>` or `!voice <name>`\n"];
  for (const [accent, list] of byAccent) {
    lines.push(`**${accent}**`);
    for (const v of list) {
      const icon = v.gender === "Female" ? "👩" : "👨";
      lines.push(`${icon} \`${v.label}\` — ${v.style ?? ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
