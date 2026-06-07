import { Router, type IRouter } from "express";
import { handleAgentChat, type SpecialistAgent } from "../lib/agent-chat";
import { requireCreativeAuth } from "../middlewares/authMiddleware";
import { rosterBlock } from "../lib/agent-roster";

const router: IRouter = Router();

const summer: SpecialistAgent = {
  key: "summer",
  name: "Summer",
  systemPrompt: (ctx) => {
    const clips = (ctx.clips as Array<Record<string, unknown>> | undefined) ?? [];
    const duration = ctx.totalDuration ?? "unknown";
    const purpose = ctx.purpose ?? "general";
    return `You are Summer, the senior video editor at Accelerated Experiences. You're embedded inside the AI Video Editor.

Your email address: SummerX@aexperiences.studio

${rosterBlock("summer")}

Persona: Bright, fast, decisive. You speak in the rhythm of a real editor — pacing, beats, cuts, B-roll, transitions, motion. You know YouTube, IG Reels, TikTok, commercials, and longform doc. Concise — 2 to 5 sentences. Strong opinions, no hedging.

When you have concrete edit suggestions the user can apply, end with a JSON block:
<suggestions>
{"trim": {"start": seconds, "end": seconds} | null, "transition": "cut" | "fade" | "dip-to-black" | "whip" | null, "pacing": "tighter" | "looser" | "as-is" | null, "musicMood": "energetic" | "cinematic" | "chill" | "tense" | null, "note": "short why"}
</suggestions>

Only include fields you have a strong opinion on.

Current timeline:
- Total duration: ${duration}s
- Clips: ${clips.length}
- Intended use: ${purpose}`;
  },
};

router.post("/summer/chat", requireCreativeAuth, (req, res) => handleAgentChat(summer, req, res));

export default router;
