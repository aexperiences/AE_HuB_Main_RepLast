import { Router, type IRouter } from "express";
import { requireEmployeeAuth } from "../middlewares/authMiddleware";

const router: IRouter = Router();

const VOICE_IDS: Record<string, string> = {
  default:  "21m00Tcm4TlvDq8ikWAM",  // Rachel — warm, calm American female
  sharon:   "XrExE9yKIg1WjnnlVkGX",  // Matilda — warm American female
  dolly:    "LcfcDJNUP1GQjkzn1xUU",  // Emily — calm, meditation-style
  geoffrey: "onwK4e9ZLuTAKqWW03F9",  // Daniel — deep, professional British
  bobert:   "TX3LPaxmHKxFdv7VOQHJ",  // Liam — warm, natural, calm American male
};

// eleven_multilingual_v2 = highest quality, most natural-sounding model (slower but best for demos)
// eleven_turbo_v2_5 = speed-optimised, noticeably more robotic — only use where latency matters more than quality
const VOICE_MODELS: Record<string, string> = {
  default:  "eleven_turbo_v2_5",
  bobert:   "eleven_multilingual_v2",  // Demo quality — best naturalness for client-facing use
  sharon:   "eleven_turbo_v2_5",
  dolly:    "eleven_turbo_v2_5",
  geoffrey: "eleven_turbo_v2_5",
};

interface VoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
}

const VOICE_SETTINGS: Record<string, VoiceSettings> = {
  // Lower stability = more natural human variation (not monotone)
  // Lower style    = less artificial exaggeration (not robotic)
  default: { stability: 0.50, similarity_boost: 0.80, style: 0.08, use_speaker_boost: false },
  bobert:  { stability: 0.42, similarity_boost: 0.82, style: 0.08, use_speaker_boost: false },
  sharon:  { stability: 0.50, similarity_boost: 0.80, style: 0.08, use_speaker_boost: false },
  dolly:   { stability: 0.55, similarity_boost: 0.80, style: 0.05, use_speaker_boost: false },
  geoffrey:{ stability: 0.50, similarity_boost: 0.80, style: 0.08, use_speaker_boost: false },
};

router.use("/tts", requireEmployeeAuth);

router.post("/tts", async (req, res) => {
  const apiKey = process.env.ELEVENLABS_API_KEY ?? null;
  if (!apiKey) {
    res.status(503).json({ error: "TTS not configured" });
    return;
  }

  const { text, persona = "default" } = (req.body ?? {}) as { text?: string; persona?: string };
  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "text required" });
    return;
  }

  const voiceId  = VOICE_IDS[persona]    ?? VOICE_IDS.default;
  const settings = VOICE_SETTINGS[persona] ?? VOICE_SETTINGS.default;
  const modelId  = VOICE_MODELS[persona]  ?? VOICE_MODELS.default;
  const clean = text
    .replace(/```[\s\S]*?```/g, "")           // drop code blocks entirely — don't say "code block"
    .replace(/`[^`]+`/g, "")
    .replace(/#{1,6}\s+/g, "")
    .replace(/[*_~]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\p{Emoji_Presentation}/gu, "")
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/^[-•]\s*/gm, "")               // strip bullet dashes/dots that get read aloud
    .replace(/^\d+\.\s*/gm, "")              // strip numbered list prefixes
    .replace(/\n{2,}/g, ". ")               // paragraph breaks become natural pauses
    .replace(/\n/g, ", ")                    // single line breaks become brief pauses
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 2500);

  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: clean,
          model_id: modelId,
          voice_settings: settings,
        }),
      },
    );

    if (!r.ok) {
      const err = await r.text().catch(() => "");
      req.log.error({ status: r.status, err }, "ElevenLabs TTS error");
      res.status(502).json({ error: "TTS upstream failed" });
      return;
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");

    if (r.body) {
      const reader = (r.body as unknown as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (e) {
    req.log.error({ e }, "TTS fetch error");
    res.status(500).json({ error: "TTS error" });
  }
});

export default router;
