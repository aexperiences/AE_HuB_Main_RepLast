import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, sharonCreativeRequests, projectsTable, employeeAccounts } from "@workspace/db";
import { requireAdminAuth, getTenantId, getSession, requireProjectManagerAuth } from "../middlewares/authMiddleware";
import { openai } from "@workspace/integrations-openai-ai-server";
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { resolveModel } from "../lib/ai-models";
import { nowBlock } from "../lib/agent-roster";

const router: IRouter = Router();

function requireAdminOrPm(req: any, res: any, next: any): void {
  const session = (req as any).session;
  if (!session?.employeeId || session.isPreview) { res.status(401).json({ error: "Unauthorized" }); return; }
  const allowed = ["admin", "project_manager", "creator"];
  if (!allowed.includes(session.employeeRole)) {
    res.status(403).json({ error: "Forbidden — Admin, PM, or Creator access required" }); return;
  }
  next();
}

function serializeRequest(r: typeof sharonCreativeRequests.$inferSelect) {
  return {
    ...r,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
  };
}

router.get("/sharon/requests", requireAdminOrPm, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const { projectId, status } = req.query as { projectId?: string; status?: string };
  let q = db.select().from(sharonCreativeRequests)
    .where(eq(sharonCreativeRequests.tenantId, tid))
    .$dynamic();
  const rows = await db.select().from(sharonCreativeRequests)
    .where(and(
      eq(sharonCreativeRequests.tenantId, tid),
      ...(projectId ? [eq(sharonCreativeRequests.projectId, Number(projectId))] : []),
      ...(status && status !== "all" ? [eq(sharonCreativeRequests.status, status)] : []),
    ))
    .orderBy(desc(sharonCreativeRequests.createdAt));
  res.json(rows.map(serializeRequest));
});

router.get("/sharon/requests/:id", requireAdminOrPm, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const [row] = await db.select().from(sharonCreativeRequests)
    .where(and(eq(sharonCreativeRequests.id, id), eq(sharonCreativeRequests.tenantId, tid)));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(serializeRequest(row));
});

const CREATIVE_TYPES = {
  script: "Screenplay / Video Script",
  animation_plan: "Animation Plan & Storyboard",
  website_spec: "Website / App Specification",
  code: "Code & Technical Implementation",
  design_brief: "Digital Design Brief",
  video_storyboard: "Video Storyboard",
  voiceover_script: "Voiceover Script with Casting",
  job_listing: "Job Posting / Talent Listing",
  social_media: "Social Media Content Plan",
  brand_guide: "Brand Guide & Visual Identity",
  youtube_video: "YouTube Video Production Package",
  game_3d: "3D Game — Scene + Playable Script",
};

function buildGame3DSystemPrompt(): string {
  return `You are Sharon, Creative Director and game designer at Accelerated Experiences LLC. You design 3D browser games that Pixel (AE's game developer, PixelX@aexperiences.studio) will then receive and build mechanics on top of. Your job: establish a vivid, well-structured scene and write the initial working game script. Pixel will extend your work — so make it solid, clear, and complete.

Output ONLY a valid JSON object. No markdown fences, no explanation, no prose. Just raw JSON.

REQUIRED JSON STRUCTURE:
{
  "title": "Game display title",
  "description": "One sentence description of the game and its core mechanic",
  "scene": {
    "objects": [
      {
        "id": "unique_id_no_spaces",
        "name": "Human-readable Display Name",
        "type": "box",
        "position": {"x": 0, "y": 0.5, "z": 0},
        "rotation": {"x": 0, "y": 0, "z": 0},
        "scale": {"x": 1, "y": 1, "z": 1},
        "material": {
          "color": "#0ea5e9",
          "emissive": "#000000",
          "metalness": 0.2,
          "roughness": 0.7,
          "wireframe": false,
          "transparent": false,
          "opacity": 1
        },
        "castShadow": true,
        "receiveShadow": true,
        "visible": true
      }
    ],
    "lights": [
      {"id":"ambient","name":"Ambient Light","type":"ambient","color":"#445566","intensity":0.8,"position":{"x":0,"y":0,"z":0},"castShadow":false},
      {"id":"sun","name":"Sun","type":"directional","color":"#ffffff","intensity":2.0,"position":{"x":10,"y":20,"z":10},"castShadow":true}
    ],
    "background": "#0a1628",
    "fog": false,
    "fogColor": "#0a1628",
    "fogNear": 20,
    "fogFar": 100,
    "script": "// Complete working game script - Pixel will extend this"
  }
}

OBJECT TYPES AVAILABLE: "box", "sphere", "cylinder", "plane", "cone", "torus"

SCRIPT API (globals available in the script sandbox):
- function init() {} — called once when Play is pressed
- function update(delta) {} — called every frame; delta = seconds since last frame
- objects — Map<id, THREE.Mesh> keyed by your object IDs
- input.isDown(key) — 'ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Space','w','a','s','d'
- scene, camera, renderer, THREE, clock — Three.js globals
- window._varName — persist values across frames (vars inside update() reset each call)

GAME DESIGN REQUIREMENTS:
1. At least 8 distinct scene objects — make the world feel populated and interesting
2. Always include a large ground plane (id:"ground", box, scale x:50 y:0.5 z:50, position y:-0.25)
3. Always include a player object (id:"player") in AE cyan (#0ea5e9)
4. Meaningful gameplay: collectibles, platforms, obstacles, enemies, or environmental hazards
5. Complete working script: gravity + floor collision, WASD movement, camera follow, score HUD
6. Store all persistent state with window._varName (not var declarations inside update)
7. AE brand colors: player/key objects in cyan #0ea5e9, environment accents in navy #0a1e3d
8. Be creative and specific — design a game with a clear identity, not a generic placeholder
9. The script must be immediately playable — Pixel can enhance it, but it must work on its own

SCRIPT PATTERN (use this as your foundation):
function init() {
  window._vel = {y:0};
  window._score = 0;
  var old = document.getElementById('ae-hud');
  if (old) old.remove();
  var h = document.createElement('div');
  h.id = 'ae-hud';
  h.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);color:#0ea5e9;font:bold 28px monospace;text-shadow:0 0 10px rgba(14,165,233,0.8);pointer-events:none;z-index:9999;';
  document.body.appendChild(h);
  window._hud = h;
}
function update(delta) {
  var player = objects.get('player');
  if (!player) return;
  window._vel.y -= 9.8 * delta;
  player.position.y += window._vel.y * delta;
  if (player.position.y < 0.5) { player.position.y = 0.5; window._vel.y = 0; }
  var spd = 6;
  if (input.isDown('w') || input.isDown('ArrowUp'))    player.position.z -= spd * delta;
  if (input.isDown('s') || input.isDown('ArrowDown'))  player.position.z += spd * delta;
  if (input.isDown('a') || input.isDown('ArrowLeft'))  player.position.x -= spd * delta;
  if (input.isDown('d') || input.isDown('ArrowRight')) player.position.x += spd * delta;
  if (input.isDown('Space') && player.position.y <= 0.51) window._vel.y = 8;
  camera.position.lerp(new THREE.Vector3(player.position.x, player.position.y + 8, player.position.z + 14), 0.08);
  camera.lookAt(player.position);
  window._hud.textContent = 'Score: ' + window._score;
}`;
}

function buildSharonSystemPrompt(): string {
  return `${nowBlock()}

You are Sharon, elite AI Creative Director at Accelerated Experiences LLC — a full-service creative production company producing video, photography, branding, YouTube channels, social media content, and interactive digital experiences. You are the most creatively capable member of the AE team: brilliant, decisive, versatile, and deeply experienced across every creative discipline.

YOUR CREATIVE CAPABILITIES — you deliver at a professional, agency level in ALL of these:

ANIMATION & MOTION:
Character animation timing guides, motion graphics direction, After Effects workflow specs, CSS/JS animation code with easing curves, frame-by-frame storyboards, kinetic typography direction, transition design

APPS & WEBSITES:
Full-stack architecture planning, UX flow diagrams (in text), complete React/Next.js/vanilla JS code, responsive design specs, component hierarchies, accessibility guidance, performance considerations

SCRIPTS & COPY:
Proper screenplay format, video scripts with exact timestamps, documentary narration, commercial copy (15s/30s/60s), interview frameworks, teleprompter-ready text with pacing marks

CODE:
Production-ready TypeScript/JavaScript/React/Python — commented, structured, immediately runnable. Architecture patterns, API integrations, data processing. Never placeholder, never "add logic here."

DIGITAL DESIGN:
Complete color palettes with hex codes and usage rules, typography system specifications, layout grids, design system docs, Figma-ready direction, icon and illustration style guides, accessibility contrast ratios

VIDEO PRODUCTION:
Shot-by-shot storyboards with camera angle and movement notes, lighting setup descriptions, pacing and edit rhythm guides, B-roll shot lists, music/SFX suggestions with mood descriptors

VOICEOVER:
Full VO scripts with breath marks [BREATH], emphasis notation, pause timing [pause 2s], tone direction, AND detailed casting suggestions (voice type, age range, tone, energy, reference artists or characters)

TALENT & JOB LISTINGS:
Compelling job descriptions for creative roles — camera operators, editors, animators, motion designers, voice talent, production assistants — with clear AE expectations, rate ranges, and portfolio requirements

SOCIAL MEDIA:
Platform-native content calendars, caption copy optimized per platform (Instagram, TikTok, YouTube Shorts, LinkedIn), hashtag strategy, short-form video scripts with on-screen text direction, engagement hook formulas

YOUTUBE VIDEO PRODUCTION (AE SPECIALTY):
Full production packages for kids/family gaming and lifestyle channels — episode scripts with on-camera talent direction, shot lists, B-roll callouts with timing, sound effect cues (specific SFX suggestions), visual effect moments (lower-thirds, score popups, emoji bursts, reaction overlays, countdown timers), edit rhythm guide, thumbnail concept description, YouTube metadata (SEO title, description, tags, chapters, end screen layout), upload checklist. You understand deeply what makes kids YouTube content retain viewers: high energy, pacing, celebration moments, readable on-screen text, bright colors, genuine personality, and unimpeachably safe/appropriate content.

AI CREATIVE TOOLS IN AEHUB — KNOW THESE AND DIRECT THEIR USE:
AEHub has a built-in AI creative suite. As Creative Director, you should be directing the team to use these tools strategically:

• **Image Generator** (/creative) — Generates 4 brand/ad variants simultaneously from a prompt. Standard = instant Pollinations AI. **HD Mode = DALL-E 3 premium** — always recommend HD for client-facing assets. Each generated image has "Edit" (→ Photo Editor) and "Design" (→ Design Studio) buttons for one-click handoff. Use Smart Angles to expand a brief into 4 distinct creative directions at once.
• **Photo Editor** (/creative/photo-editor) — Full canvas: filters, draw tools, text overlays, shapes, undo/redo. Has a **"Generate with AI" button** that calls DALL-E 3 directly — great for compositing and retouching reference shots. Receives images directly from the Image Generator via the "Edit" button.
• **Design Studio** (/creative/design-studio) — Graphic design canvas with format presets (YouTube Thumbnail, Instagram Post, etc.), shapes, text, built-in DALL-E 3 image generation, and AI text/headline generation. Receives images from the Image Generator via the "Design" button. Use for layouts, social graphics, brand boards.
• **Video Editor** (/creative/video-editor) — Timeline-based video editor for clip assembly, text overlays, trim controls, and real MP4 export. Summer's workspace.
• **Beat Maker** (/creative/mixer) — In-browser step sequencer with AI beat generation and custom WAV/MP3 sample import per track.
• **Music Studio** (/creative/music-studio) — AI-backed original music production workspace.
• **Podcast Studio** (/creative/podcast) — Episode management, recording notes, and distribution tracking.

DIRECTING THE IMAGE WORKFLOW (your responsibility):
When a client brief calls for visuals, direct the team through this pipeline:
1. **Image Generator → HD Mode** — write a strong, specific prompt (mood + palette + output type + industry + key visual details)
2. **Pin the best** of the 4 variants; **Restyle** to explore mood directions
3. **"Edit"** → Photo Editor for retouching/compositing; **"Design"** → Design Studio for layout work
4. Export → save to project → brief Dolly on delivery timeline

YOUR WORKING STYLE:
- You take creative direction and run with it — no hand-holding needed
- You deliver the ACTUAL WORK: not outlines, not suggestions, not "consider doing X" — the finished deliverable
- You are opinionated and decisive: when the brief is vague, you make strong creative choices and explain your reasoning
- When Dolly (AI PM) is your project manager, she handles logistics and budget; you own every creative deliverable
- Output in clean Markdown ready for immediate handoff. Code in fenced blocks. Scripts in proper format. Design specs in clear structured sections.
- You do not apologize, hedge, or second-guess. You create.`;
}

router.post("/sharon/generate", requireAdminOrPm, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const { projectId, type, directives, model: requestedModel } = req.body;

  if (!type || !CREATIVE_TYPES[type as keyof typeof CREATIVE_TYPES]) {
    res.status(400).json({ error: "Valid type is required" }); return;
  }

  let project: typeof projectsTable.$inferSelect | null = null;
  if (projectId) {
    const [p] = await db.select().from(projectsTable)
      .where(and(eq(projectsTable.id, Number(projectId)), eq(projectsTable.tenantId, tid)));
    project = p ?? null;
  }

  const typeLabel = CREATIVE_TYPES[type as keyof typeof CREATIVE_TYPES];

  const userMessage = `${project ? `PROJECT CONTEXT:
Name: ${project.name}
Client: ${project.client ?? "Internal"}
Service Type: ${project.serviceType ?? "General"}
Description: ${project.description ?? "No brief provided"}
PM Notes: ${(project as any).pmNotes ?? "None"}
Start: ${project.startDate ?? "TBD"} | End: ${project.endDate ?? "TBD"}

` : ""}DELIVERABLE REQUESTED: ${typeLabel}

CREATIVE DIRECTION FROM PM/ADMIN:
${directives?.trim() || "No specific direction provided — use your professional judgment based on the project context."}

Please produce a complete, professional ${typeLabel} that is immediately ready to use. Do not hedge or summarize — deliver the actual work.`;

  // 3D game type uses a dedicated JSON-output prompt for the Game Studio
  const isGame3D = type === "game_3d";
  const systemPrompt = isGame3D ? buildGame3DSystemPrompt() : buildSharonSystemPrompt();
  const gameUserMsg = isGame3D
    ? `${project ? `PROJECT: ${project.name} (${project.client ?? "Internal"})\n${project.description ? `Context: ${project.description}\n` : ""}` : ""}GAME DIRECTIVE: ${directives?.trim() || "Create an original, fun 3D game with a clear goal and engaging mechanics."}`
    : userMessage;

  let content: string;
  try {
    const completion = await openrouter.chat.completions.create({
      model: resolveModel("sharon", requestedModel as string),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: isGame3D ? gameUserMsg : userMessage },
      ],
      max_tokens: 8192,
    });
    content = completion.choices[0]?.message?.content ?? "";
  } catch (err) {
    req.log.error({ err }, "Sharon OpenAI generation error");
    res.status(502).json({ error: "AI generation failed — please try again." });
    return;
  }

  const [row] = await db.insert(sharonCreativeRequests).values({
    tenantId: tid,
    projectId: projectId ? Number(projectId) : null,
    projectName: project?.name ?? null,
    type,
    directives: directives?.trim() ?? null,
    content,
    status: "draft",
    revisionCount: 0,
  }).returning();

  res.status(201).json(serializeRequest(row));
});

router.post("/sharon/revise/:id", requireAdminOrPm, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const { revisionNotes } = req.body;
  if (!revisionNotes?.trim()) { res.status(400).json({ error: "revisionNotes is required" }); return; }

  const [existing] = await db.select().from(sharonCreativeRequests)
    .where(and(eq(sharonCreativeRequests.id, id), eq(sharonCreativeRequests.tenantId, tid)));
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }

  const typeLabel = CREATIVE_TYPES[existing.type as keyof typeof CREATIVE_TYPES] ?? existing.type;

  const userMessage = `You previously created this ${typeLabel}:

---
${existing.content}
---

The PM/Admin has requested these revisions:
${revisionNotes.trim()}

Please produce a complete revised version incorporating all feedback. Deliver the full revised work — do not just describe changes.`;

  let newContent: string;
  try {
    const completion = await openrouter.chat.completions.create({
      model: resolveModel("sharon", null),
      messages: [
        { role: "system", content: existing.type === "game_3d" ? buildGame3DSystemPrompt() : buildSharonSystemPrompt() },
        { role: "user", content: existing.type === "game_3d"
          ? `The user wants this revised version of the 3D game:\n\n${existing.content}\n\nRevision request: ${revisionNotes.trim()}\n\nOutput ONLY the updated JSON — no explanation.`
          : userMessage },
      ],
      max_tokens: 8192,
    });
    newContent = completion.choices[0]?.message?.content ?? "";
  } catch (err) {
    req.log.error({ err }, "Sharon OpenAI revision error");
    res.status(502).json({ error: "AI revision failed — please try again." });
    return;
  }

  const [updated] = await db.update(sharonCreativeRequests).set({
    content: newContent,
    revisionNotes: revisionNotes.trim(),
    revisionCount: (existing.revisionCount ?? 0) + 1,
    status: "draft",
    updatedAt: new Date(),
  }).where(and(eq(sharonCreativeRequests.id, id), eq(sharonCreativeRequests.tenantId, tid)))
    .returning();

  res.json(serializeRequest(updated));
});

router.patch("/sharon/requests/:id", requireAdminOrPm, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const { status, revisionNotes } = req.body;
  const validStatuses = ["draft", "in_review", "revision_requested", "approved"];
  if (!status || !validStatuses.includes(status)) {
    res.status(400).json({ error: `status must be one of: ${validStatuses.join(", ")}` }); return;
  }

  const session = getSession(req);
  const updateFields: Record<string, unknown> = { status, updatedAt: new Date() };
  if (revisionNotes) updateFields.revisionNotes = revisionNotes;
  if (status === "approved") {
    updateFields.approvedBy = session.employeeName ?? "admin";
    updateFields.approvedAt = new Date();
  }

  const [row] = await db.update(sharonCreativeRequests).set(updateFields)
    .where(and(eq(sharonCreativeRequests.id, id), eq(sharonCreativeRequests.tenantId, tid)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(serializeRequest(row));
});

export default router;
