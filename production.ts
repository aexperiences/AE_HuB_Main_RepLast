import { Router, type IRouter } from "express";
import { requireProjectManagerAuth } from "../middlewares/authMiddleware";
import { openai } from "@workspace/integrations-openai-ai-server";

const router: IRouter = Router();

router.post("/production/sfx-recommendations", requireProjectManagerAuth, async (req, res): Promise<void> => {
  const { script, contentType } = req.body;
  if (!script?.trim()) { res.status(400).json({ error: "script is required" }); return; }

  const systemPrompt = `You are a professional sound designer and music supervisor specializing in kids' YouTube content, gaming videos, and digital media. You have deep knowledge of free sound libraries including YouTube Audio Library, Freesound.org, Pixabay, and Zapsplat.

Analyze the provided script/scene description and recommend specific sound effects and music for each key moment. Be very specific — name the exact type of sound, not generic labels.

Respond with valid JSON matching this exact shape:
{
  "recommendations": [
    {
      "timestamp": "string — approx time or scene label e.g. '0:00' or 'Intro'",
      "description": "string — what's happening in the scene",
      "sfxSuggestion": "string — specific sound description e.g. 'Upbeat chiptune intro jingle with 8-bit synth, 4-8 seconds'",
      "searchTerms": ["array", "of", "search", "terms", "to", "find", "this", "sound"],
      "platforms": ["YouTube Audio Library", "Freesound.org", "Pixabay", "Zapsplat"],
      "type": "sfx" | "music" | "both"
    }
  ]
}

Return 8-15 recommendations covering the full video. For kids' Nintendo gaming content be specific: coin collection sounds, level-up jingles, crowd reactions, victory fanfares, etc. Only include platforms where the sound is realistically findable for free.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Content Type: ${contentType}\n\nScript/Scene Description:\n${script.trim()}` },
      ],
      response_format: { type: "json_object" },
      max_tokens: 2000,
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw);
    res.json(parsed);
  } catch (err: any) {
    req.log.error({ err }, "SFX recommendation failed");
    res.status(500).json({ error: "AI service unavailable" });
  }
});

router.post("/production/youtube-package", requireProjectManagerAuth, async (req, res): Promise<void> => {
  const { title, script, channel, brandVoice } = req.body;
  if (!title?.trim()) { res.status(400).json({ error: "title is required" }); return; }

  const voiceGuidance: Record<string, string> = {
    "AE Standard":   "Use a professional, confident tone aligned with the Accelerated Experiences brand — clear, purposeful, and polished.",
    "Bold & Punchy": "Use high-energy language, short punchy sentences, power words, exclamation points, and ALL CAPS for emphasis.",
    "Kids-Friendly": "Use simple words, fun emojis, exclamation points, excitement, and language that appeals to kids aged 6-12.",
    "Storyteller":   "Use narrative hooks, emotional arc language, curiosity gaps, and story-driven framing throughout.",
    "Corporate":     "Use formal, business-professional language — polished, measured, credibility-forward with no slang.",
  };
  const voiceInstruction = voiceGuidance[brandVoice as string] ?? voiceGuidance["AE Standard"];

  const systemPrompt = `You are a YouTube SEO expert and channel manager specializing in kids' gaming content. You know exactly what makes titles, descriptions, and tags rank and click on YouTube Kids and regular YouTube.

Brand Voice Instruction: ${voiceInstruction}

Generate a complete YouTube upload package optimized for kids' Nintendo gaming content. The channel is family-friendly. Apply the brand voice instruction to ALL text you generate — titles, description, end screen script, and thumbnail concept.

Respond with valid JSON matching this exact shape:
{
  "titles": ["array of 4 title options — mix of clickbait/curiosity, direct/keyword, fun/emoji styles. Max 60 chars each. Apply the brand voice tone."],
  "description": "full SEO description — starts with 2-3 hype sentences matching brand voice, then chapter timestamps if provided, then subscribe CTA, then social links placeholder, then hashtags. 400-600 words.",
  "tags": ["array of 20-25 tags — mix of broad (nintendo, gaming, kids youtube) and specific (game title, character names, channel name). Lowercase."],
  "thumbnailConcept": "detailed thumbnail direction: background color, text overlay (5 words max, specific font style), host position, reaction expression, game element to feature, border/badge style for kids appeal",
  "chapters": ["0:00 Intro", "1:30 Gameplay Starts", ... — realistic timestamps based on provided info, or sensible defaults"],
  "endScreenScript": "20-second spoken end screen script the host says on camera — includes subscribe ask, bell notification, video recommendation prompt, sign-off matching brand voice",
  "playlistSuggestion": "suggested playlist name and why this video fits it"
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Channel: ${channel || "Manx Ninja Pig"}\nVideo Title/Topic: ${title.trim()}\n\nScript / Key Moments:\n${script?.trim() || "Nintendo gaming video with on-camera host commentary"}` },
      ],
      response_format: { type: "json_object" },
      max_tokens: 2000,
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw);
    res.json(parsed);
  } catch (err: any) {
    req.log.error({ err }, "YouTube package generation failed");
    res.status(500).json({ error: "AI service unavailable" });
  }
});

export default router;
