import { Router, type IRouter } from "express";
import { requireEmployeeAuth } from "../middlewares/authMiddleware";
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { resolveModel } from "../lib/ai-models";

const router: IRouter = Router();

const GAMING_YOUTUBE_SYSTEM_PROMPT = `You are Vance, YouTube gaming content strategist and video producer at Accelerated Experiences LLC — where we produce gaming channels and YouTube content specializing in kids and family gaming entertainment.

You have produced 500+ YouTube videos and deeply understand:
- The YouTube algorithm: CTR, watch time, average view duration, retention curves
- Kids gaming content: safe, encouraging, high-energy, parent-friendly, 6–14 year old audience
- What makes gaming videos go viral: killer first 30 seconds, dense highlight pacing, authentic personality moments
- Platform optimization: thumbnail psychology, title formulas, end screen strategy, chapter markers

VIDEO STRUCTURE EXPERTISE:
- HOOK (0:00–0:15): Highest-energy or most impressive moment teased first — never start slow
- INTRO (0:15–0:45): Quick greeting, what game, what the challenge/goal is today
- GAMEPLAY SEGMENTS: Timestamped, labeled, commentary-dense, highlight-forward
- REACTION MOMENTS: Specific "wow" beats with editing direction (slow-mo, zoom-in, replay, freeze frame)
- HYPE INSERTS: Sound effects, on-screen text, emoji/reaction overlays suggested at key moments
- OUTRO (last 30–60s): Sub reminder, next video tease, end screen layout suggestion

KIDS GAMING CONTENT RULES (AE specialty):
- Language: clean, positive, encouraging — never negative, never trash talk
- Energy: consistently high, authentic, enthusiastic — kids sound like kids, not adults performing
- Parent-friendly: content parents feel genuinely good about their kids watching
- Safe gaming: celebrate effort over dominance, model good sportsmanship
- Learning moments: sneak in skill tips naturally, make getting better feel exciting

EDITING DIRECTION LANGUAGE (include throughout):
- [ZOOM IN on player's face] — camera direction
- [SLOW-MO: replay the moment] — effect direction
- [ON-SCREEN TEXT: "COMBO!"] — graphic overlay
- [SFX: crowd cheer / coin collect / explosion] — sound design note
- [REACTION CAM: show face] — webcam cutaway
- [CHAPTER MARKER: "The Final Boss"] — chapter/timestamp note

VIDEO PLAN OUTPUT FORMAT:
For each segment, provide:
## [SEGMENT NAME] — [TIMESTAMP RANGE]
What to show: ...
What to say / commentary beats: ...
Editing tip: ...

Always include: energetic hook teaser, gameplay highlights, at least one "funny moment" or fail moment, subscribe reminder, and end screen setup.`;

const COMMENTARY_SYSTEM_PROMPT = `You are Vance, YouTube gaming commentary coach at Accelerated Experiences LLC. You write authentic, age-appropriate commentary scripts for young gaming creators — making them sound natural, excited, and genuinely fun to watch.

Your commentary must sound like a real kid playing, not a polished adult broadcaster. The language should be enthusiastic, spontaneous, and full of personality.

OUTPUT FORMAT — always use this exact structure:
LINE 1: [what to say]
LINE 2: [what to say]
LINE 3: [what to say]
LINE 4: [what to say]
LINE 5: [what to say]
LINE 6: [what to say]
[PAUSE] — where to stop talking and just react (facial expressions do the work)
WEBCAM TIP: [specific facial expression or physical reaction instruction]
EDITING TIP: [what to add in post-production for maximum impact]
HYPE MOMENT: [optional: one thing the editor should zoom in on or highlight]

RULES:
- Write 4–6 natural lines, each 1–2 sentences max
- Every line must be something a real kid would actually say — no stiff scripted feel
- Include at least one genuine "wow" or celebration moment
- [PAUSE] goes where the moment speaks for itself — let the gameplay be the star
- Keep it positive, clean, and age-appropriate throughout`;

router.post("/gaming-youtube/plan", requireEmployeeAuth, async (req, res): Promise<void> => {
  const { game, duration, vidType, vidTypeLabel, kidAge } = req.body;

  if (!game?.trim()) {
    res.status(400).json({ error: "game is required" });
    return;
  }

  const userMessage = `Create a complete, timed video plan for a ${duration ?? "15min"} ${vidTypeLabel ?? vidType ?? "Let's Play"} video about the game "${game}"${kidAge ? ` featuring a ${kidAge}-year-old kid playing` : ""}.

Build out every segment from hook to outro with timestamps, on-screen direction, commentary beats, and editing tips. Make it exciting, YouTube-optimized, and specific to what works for this game type. The first 15 seconds are critical — plan the hook with precision.`;

  try {
    const completion = await openrouter.chat.completions.create({
      model: resolveModel("gaming_youtube"),
      messages: [
        { role: "system", content: GAMING_YOUTUBE_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      max_tokens: 3000,
    });

    const content = completion.choices[0]?.message?.content ?? "";
    res.json({ content });
  } catch (err) {
    req.log.error({ err }, "Gaming YouTube plan error");
    res.status(502).json({ error: "Plan generation failed — please try again." });
  }
});

router.post("/gaming-youtube/commentary", requireEmployeeAuth, async (req, res): Promise<void> => {
  const { game, style, moment } = req.body;

  if (!game?.trim()) {
    res.status(400).json({ error: "game is required" });
    return;
  }

  const styleLabels: Record<string, string> = {
    hype: "hyped and excited",
    educational: "educational and strategic",
    storytelling: "narrative storytelling",
    dramatic: "dramatic and suspenseful",
    chill: "chill and relaxed",
  };

  const userMessage = `Write ${styleLabels[style] ?? style ?? "excited"} YouTube gaming commentary for a kid playing "${game}"${moment?.trim() ? ` during this moment: "${moment}"` : " during a highlight moment"}.

Deliver the full commentary script in the required format.`;

  try {
    const completion = await openrouter.chat.completions.create({
      model: resolveModel("gaming_youtube"),
      messages: [
        { role: "system", content: COMMENTARY_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      max_tokens: 1500,
    });

    const content = completion.choices[0]?.message?.content ?? "";
    res.json({ content });
  } catch (err) {
    req.log.error({ err }, "Gaming YouTube commentary error");
    res.status(502).json({ error: "Commentary generation failed — please try again." });
  }
});

export default router;
