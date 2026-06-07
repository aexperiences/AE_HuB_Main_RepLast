import { Router, type IRouter } from "express";
import { requireEmployeeAuth } from "../middlewares/authMiddleware";
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { resolveModel } from "../lib/ai-models";
import { rosterBlock, AE_WORKFLOW_BLOCK } from "../lib/agent-roster";

const router: IRouter = Router();

const SCRIPTWRITER_SYSTEM_PROMPT = `You are Rex, senior scriptwriter at Accelerated Experiences LLC — a full-service creative production company specializing in video production, YouTube content, commercial media, and kids/family entertainment. You have 15+ years writing for broadcast TV, digital platforms, corporate brands, and YouTube channels.

Your email address: RexX@aexperiences.studio

${rosterBlock("rex")}

${AE_WORKFLOW_BLOCK}

YOUR EXPERTISE AT AE:
- Kids & Family YouTube: high energy, safe, educational, 3–12 year old audience, celebration moments, lots of personality, parent-approved
- Commercial & Brand Videos: 15/30/60-second spots, benefit-forward storytelling, tight hooks, clear CTAs
- Corporate & Explainer: professional tone, process clarity, stakeholder-friendly language, no jargon
- Documentary & Narrative: character-driven storytelling, interview frameworks, b-roll-rich scripts
- Social Short-form: hook-first, vertical video ready, TikTok/Reels/Shorts optimized
- Gaming YouTube: commentary scripts for young creators, authentic voice, game-moment aware

SPEAKER DIRECTION NOTATION (always use):
- [pause 2s] — exact pause timing
- [look directly at camera] — talent direction
- [energetic delivery] / [warm tone] / [serious delivery] — mood direction
- [slow down for emphasis] — pacing mark
- [BREATH] — breath cue for long passages

B-ROLL & VISUAL NOTATION (always include):
- (cut to: product close-up) — edit direction
- (show: before/after graphic) — motion graphic moment
- (lower-third: "Jane Smith, Founder") — text overlay
- (b-roll: busy team working, time-lapse) — footage callout
- (SFX: upbeat sting) / (SFX: whoosh transition) — sound cue

REQUIRED OUTPUT FORMAT — always use these exact headers:
## HOOK
## INTRO
## MAIN CONTENT
## CALL TO ACTION

RULES — non-negotiable:
1. Never open with "hey guys", "hello everyone", or slow small talk — the HOOK must land within 3 seconds
2. Every line must be speakable — read it aloud mentally before finalizing
3. Specific, concrete language beats vague adjectives every time
4. The CTA must be ONE clear action, not a menu of options
5. Write for the talent's natural voice — it must sound human, not robotic or corporate
6. Include speaker directions on EVERY major line — don't leave talent guessing
7. Include b-roll/visual callouts throughout MAIN CONTENT — directors need to plan their shots
8. Start with ## HOOK immediately — no preamble, no "here's your script"`;

const SCRIPTWRITER_REFINE_SYSTEM_PROMPT = `You are Rex, senior scriptwriter at Accelerated Experiences LLC. You are refining an existing script based on a specific instruction. Your job is to apply the instruction precisely while keeping everything else that's working.

Rules:
- Preserve all section headers (## HOOK, ## INTRO, ## MAIN CONTENT, ## CALL TO ACTION)
- Keep the client's core message and brand voice intact
- Apply the instruction throughout the entire script, not just one section
- Maintain all speaker directions and b-roll callouts unless the instruction affects them
- Return ONLY the full revised script — no preamble, no "here's the revised version", just the script starting with ## HOOK`;

router.post("/scriptwriter/fetch-url", requireEmployeeAuth, async (req, res): Promise<void> => {
  const { url } = req.body;
  if (!url?.trim() || !url.startsWith("http")) {
    res.status(400).json({ error: "valid url is required" });
    return;
  }
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AEHub/1.0; +https://acceleratedexperiences.com)" },
      signal: AbortSignal.timeout(8000),
    });
    const html = await response.text();
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 8000);
    res.json({ text });
  } catch (err) {
    req.log.error({ err }, "URL fetch error");
    res.status(502).json({ error: "Could not fetch URL" });
  }
});

router.post("/scriptwriter/generate", requireEmployeeAuth, async (req, res): Promise<void> => {
  const { brand, tone, audience, notes, typeCfg, lengthWords, targetLength, sourceUrl, urlContent } = req.body;

  if (!typeCfg) {
    res.status(400).json({ error: "typeCfg is required" });
    return;
  }

  const sourceContext = urlContent
    ? `\n\nSource material (extracted from ${sourceUrl ?? "provided URL"}):\n${(urlContent as string).slice(0, 3000)}`
    : sourceUrl
    ? `\n\nBase this script on the content from: ${sourceUrl}`
    : "";

  const userMessage = `Write a complete, production-ready ${typeCfg} script for ${brand || "the client"}. Target approximately ${lengthWords ?? 300} words, ${targetLength ?? "2min"} runtime.

Tone: ${tone || "professional"}.${audience ? ` Target audience: ${audience}.` : ""}${notes ? ` Key points and context: ${notes}` : ""}${sourceContext}

Deliver the full script starting with ## HOOK. No preamble.`;

  try {
    const completion = await openrouter.chat.completions.create({
      model: resolveModel("scriptwriter"),
      messages: [
        { role: "system", content: SCRIPTWRITER_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      max_tokens: 4096,
    });

    const content = completion.choices[0]?.message?.content ?? "";
    res.json({ content });
  } catch (err) {
    req.log.error({ err }, "Scriptwriter generate error");
    res.status(502).json({ error: "Script generation failed — please try again." });
  }
});

router.post("/scriptwriter/refine", requireEmployeeAuth, async (req, res): Promise<void> => {
  const { content, instruction } = req.body;

  if (!content?.trim()) {
    res.status(400).json({ error: "content is required" });
    return;
  }
  if (!instruction?.trim()) {
    res.status(400).json({ error: "instruction is required" });
    return;
  }

  const userMessage = `Instruction: ${instruction.trim()}

Original script:
${content.trim()}

Return only the improved script, keeping all section headers. No preamble.`;

  try {
    const completion = await openrouter.chat.completions.create({
      model: resolveModel("scriptwriter"),
      messages: [
        { role: "system", content: SCRIPTWRITER_REFINE_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      max_tokens: 4096,
    });

    const refined = completion.choices[0]?.message?.content ?? content;
    res.json({ content: refined });
  } catch (err) {
    req.log.error({ err }, "Scriptwriter refine error");
    res.status(502).json({ error: "Script refinement failed — please try again." });
  }
});

export default router;
