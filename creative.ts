import { requireEmployeeAuth, requireAdminAuth, getTenantId } from "../middlewares/authMiddleware";
import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, creativeBriefsTable, shotListsTable, shotListItemsTable } from "@workspace/db";
import { z } from "zod";

const router: IRouter = Router();

const toBrief = (b: typeof creativeBriefsTable.$inferSelect) => ({
  ...b,
  createdAt: b.createdAt.toISOString(),
  updatedAt: b.updatedAt.toISOString(),
});

const toShotList = (s: typeof shotListsTable.$inferSelect) => ({
  ...s,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

const toItem = (i: typeof shotListItemsTable.$inferSelect) => ({
  ...i,
  createdAt: i.createdAt.toISOString(),
});

const BriefBody = z.object({
  title: z.string().min(1),
  projectId: z.number().int().optional().nullable(),
  clientName: z.string().optional().nullable(),
  status: z.enum(["draft", "in_review", "approved", "active", "archived"]).optional(),
  overview: z.string().optional().nullable(),
  targetAudience: z.string().optional().nullable(),
  toneAndMood: z.string().optional().nullable(),
  keyMessages: z.string().optional().nullable(),
  deliverableSpecs: z.string().optional().nullable(),
  inspirationRefs: z.string().optional().nullable(),
  mandatoryInclusions: z.string().optional().nullable(),
  mandatoryExclusions: z.string().optional().nullable(),
  dueDate: z.string().optional().nullable(),
  createdBy: z.string().optional().nullable(),
});

const ShotListBody = z.object({
  title: z.string().min(1),
  projectId: z.number().int().optional().nullable(),
  clientName: z.string().optional().nullable(),
  shootDate: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  director: z.string().optional().nullable(),
  photographer: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  createdBy: z.string().optional().nullable(),
});

const ShotItemBody = z.object({
  description: z.string().min(1),
  shotNumber: z.number().int().optional().nullable(),
  angle: z.string().optional().nullable(),
  lens: z.string().optional().nullable(),
  lighting: z.string().optional().nullable(),
  talent: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  status: z.enum(["planned", "captured", "unusable"]).optional(),
});

const IdParam = z.object({ id: z.coerce.number().int() });

// ── Creative Briefs ──────────────────────────────────────────────────────────

router.get("/creative/briefs", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const projectId = req.query.projectId ? Number(req.query.projectId) : null;
  const rows = projectId
    ? await db.select().from(creativeBriefsTable).where(and(eq(creativeBriefsTable.tenantId, tid), eq(creativeBriefsTable.projectId, projectId))).orderBy(desc(creativeBriefsTable.createdAt))
    : await db.select().from(creativeBriefsTable).where(eq(creativeBriefsTable.tenantId, tid)).orderBy(desc(creativeBriefsTable.createdAt));
  res.json(rows.map(toBrief));
});

router.get("/creative/briefs/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const p = IdParam.safeParse(req.params);
  if (!p.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const [row] = await db.select().from(creativeBriefsTable).where(and(eq(creativeBriefsTable.id, p.data.id), eq(creativeBriefsTable.tenantId, tid)));
  if (!row) { res.status(404).json({ error: "Brief not found" }); return; }
  res.json(toBrief(row));
});

router.post("/creative/briefs", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const parsed = BriefBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.insert(creativeBriefsTable).values({
    ...parsed.data,
    tenantId: tid,
    status: parsed.data.status ?? "draft",
  }).returning();
  res.status(201).json(toBrief(row));
});

router.patch("/creative/briefs/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const p = IdParam.safeParse(req.params);
  if (!p.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = BriefBody.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.update(creativeBriefsTable).set(parsed.data).where(and(eq(creativeBriefsTable.id, p.data.id), eq(creativeBriefsTable.tenantId, tid))).returning();
  if (!row) { res.status(404).json({ error: "Brief not found" }); return; }
  res.json(toBrief(row));
});

router.delete("/creative/briefs/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const p = IdParam.safeParse(req.params);
  if (!p.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const [row] = await db.delete(creativeBriefsTable).where(and(eq(creativeBriefsTable.id, p.data.id), eq(creativeBriefsTable.tenantId, tid))).returning();
  if (!row) { res.status(404).json({ error: "Brief not found" }); return; }
  res.sendStatus(204);
});

// ── Shot Lists ───────────────────────────────────────────────────────────────

router.get("/creative/shot-lists", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const projectId = req.query.projectId ? Number(req.query.projectId) : null;
  const rows = projectId
    ? await db.select().from(shotListsTable).where(and(eq(shotListsTable.tenantId, tid), eq(shotListsTable.projectId, projectId))).orderBy(desc(shotListsTable.createdAt))
    : await db.select().from(shotListsTable).where(eq(shotListsTable.tenantId, tid)).orderBy(desc(shotListsTable.createdAt));
  res.json(rows.map(toShotList));
});

router.get("/creative/shot-lists/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const p = IdParam.safeParse(req.params);
  if (!p.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const [list] = await db.select().from(shotListsTable).where(and(eq(shotListsTable.id, p.data.id), eq(shotListsTable.tenantId, tid)));
  if (!list) { res.status(404).json({ error: "Shot list not found" }); return; }
  const items = await db.select().from(shotListItemsTable).where(eq(shotListItemsTable.shotListId, p.data.id)).orderBy(shotListItemsTable.shotNumber);
  res.json({ ...toShotList(list), items: items.map(toItem) });
});

router.post("/creative/shot-lists", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const parsed = ShotListBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.insert(shotListsTable).values({ ...parsed.data, tenantId: tid }).returning();
  res.status(201).json(toShotList(row));
});

router.patch("/creative/shot-lists/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const p = IdParam.safeParse(req.params);
  if (!p.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = ShotListBody.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.update(shotListsTable).set(parsed.data).where(and(eq(shotListsTable.id, p.data.id), eq(shotListsTable.tenantId, tid))).returning();
  if (!row) { res.status(404).json({ error: "Shot list not found" }); return; }
  res.json(toShotList(row));
});

router.delete("/creative/shot-lists/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const p = IdParam.safeParse(req.params);
  if (!p.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const [row] = await db.delete(shotListsTable).where(and(eq(shotListsTable.id, p.data.id), eq(shotListsTable.tenantId, tid))).returning();
  if (!row) { res.status(404).json({ error: "Shot list not found" }); return; }
  res.sendStatus(204);
});

// ── Shot List Items ──────────────────────────────────────────────────────────

router.post("/creative/shot-lists/:id/items", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const p = IdParam.safeParse(req.params);
  if (!p.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const [list] = await db.select().from(shotListsTable).where(and(eq(shotListsTable.id, p.data.id), eq(shotListsTable.tenantId, tid)));
  if (!list) { res.status(404).json({ error: "Shot list not found" }); return; }
  const parsed = ShotItemBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.insert(shotListItemsTable).values({
    ...parsed.data,
    shotListId: p.data.id,
    status: parsed.data.status ?? "planned",
  }).returning();
  res.status(201).json(toItem(row));
});

router.patch("/creative/shot-lists/:id/items/:itemId", requireEmployeeAuth, async (req, res): Promise<void> => {
  const itemId = Number(req.params.itemId);
  if (isNaN(itemId)) { res.status(400).json({ error: "Invalid itemId" }); return; }
  const parsed = ShotItemBody.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.update(shotListItemsTable).set(parsed.data).where(eq(shotListItemsTable.id, itemId)).returning();
  if (!row) { res.status(404).json({ error: "Shot not found" }); return; }
  res.json(toItem(row));
});

router.delete("/creative/shot-lists/:id/items/:itemId", requireEmployeeAuth, async (req, res): Promise<void> => {
  const itemId = Number(req.params.itemId);
  if (isNaN(itemId)) { res.status(400).json({ error: "Invalid itemId" }); return; }
  const [row] = await db.delete(shotListItemsTable).where(eq(shotListItemsTable.id, itemId)).returning();
  if (!row) { res.status(404).json({ error: "Shot not found" }); return; }
  res.sendStatus(204);
});

/* ── Smart Angles: expand a brief into 4 distinct creative directions ───────── */
router.post("/creative/expand-prompt", requireEmployeeAuth, async (req, res): Promise<void> => {
  const { business, industry, mood, outputType } = req.body ?? {};
  if (!business && !industry) {
    res.status(400).json({ error: "business or industry required" });
    return;
  }

  const systemPrompt = `You are a world-class creative director. Given a brief, you generate EXACTLY 4 completely different creative angles as valid JSON. Each angle has a distinct visual concept, mood, and compositional approach.

Return ONLY valid JSON — no markdown, no explanation. Format:
[
  { "name": "Angle Name", "emoji": "🎨", "description": "One sentence describing this angle's concept", "prompt": "detailed image generation prompt for this specific angle" },
  ... (4 total)
]

Rules for the 4 angles:
1. Minimalist / Clean — lots of white space, simple geometry, subtle palette
2. Bold / Editorial — high contrast, strong typography feel, graphic shapes
3. Photorealistic / Cinematic — feels like a real photograph or film still, natural lighting, lifestyle
4. Artistic / Textured — painterly, illustrated, hand-crafted feel, rich textures

Each prompt should be specific, detailed, and directly usable for image generation (describe lighting, composition, color, mood, subject matter).`;

  const brief = `Business: ${business || "Creative agency"}\nIndustry: ${industry || "General"}\nMood: ${mood || "professional"}\nOutput type: ${outputType || "social media visual"}`;

  try {
    const { openrouter } = await import("@workspace/integrations-openrouter-ai");
    const aiResponse = await openrouter.chat.completions.create({
      model: "google/gemini-2.0-flash-001",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: brief },
      ],
      max_tokens: 1200,
    });
    const raw = aiResponse.choices[0]?.message?.content ?? "[]";
    // Strip markdown code fences if present
    const cleaned = raw.replace(/```(?:json)?\n?/g, "").replace(/```$/g, "").trim();
    const angles = JSON.parse(cleaned);
    if (!Array.isArray(angles)) throw new Error("Expected array");
    res.json({ angles: angles.slice(0, 4) });
  } catch (err: any) {
    (req as any).log?.error?.({ err }, "Smart angles generation failed");
    res.status(500).json({ error: err?.message ?? "Smart angles unavailable" });
  }
});

/* ── AI Creative Director inline chat ──────────────────────────────────────── */
router.post("/creative/director", requireEmployeeAuth, async (req, res): Promise<void> => {
  const { message, context } = req.body ?? {};
  if (!message || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const contextStr = context ? `\n\nCurrent page context: ${JSON.stringify(context)}` : "";
  const systemPrompt = `You are the AI Creative Director for Accelerated Experiences LLC — a full-service creative production company specializing in video, photography, branding, social media, podcast, YouTube, gaming, and digital experiences.

Your role is to give fast, expert creative direction: concept ideas, campaign strategies, copy angles, visual direction, mood/tone, content frameworks, and creative problem-solving. You are opinionated, decisive, and concise.

Guidelines:
- Give concrete, actionable creative recommendations — not generic advice
- When suggesting visuals, be specific about mood, color, composition, reference points
- When suggesting copy, provide actual lines — not just descriptions
- When suggesting a campaign concept, name it and give the core idea in one sentence
- Keep responses punchy: 2-4 sentences for quick questions, up to 8-10 for complex briefs
- Never hedge — make a strong creative choice and defend it
- AE brand: deep navy (#0a1e3d), vibrant cyan (#0ea5e9). Zero purple/violet/indigo.${contextStr}`;

  try {
    const { openrouter } = await import("@workspace/integrations-openrouter-ai");
    const aiResponse = await openrouter.chat.completions.create({
      model: "google/gemini-2.0-flash-001",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: message.trim() },
      ],
      max_tokens: 500,
    });
    const reply = aiResponse.choices[0]?.message?.content ?? "";
    res.json({ reply });
  } catch (err: any) {
    (req as any).log?.error?.({ err }, "Creative director chat failed");
    res.status(500).json({ error: err?.message ?? "Creative Director is unavailable right now" });
  }
});

// ── AI Creative Variant Generator ────────────────────────────────────────────
router.post("/creative/generate-variants", requireEmployeeAuth, async (req, res): Promise<void> => {
  const { concept } = req.body;
  if (!concept?.trim()) { res.status(400).json({ error: "concept is required" }); return; }

  const DIRECTIONS = [
    { style: "BOLD & HIGH-ENERGY",        hint: "bold, loud, cinematic, energetic, stops the scroll, makes a statement" },
    { style: "EMOTIONAL & STORYTELLING",  hint: "emotional, narrative-driven, human, authentic, pulls heartstrings, deeply memorable" },
    { style: "MINIMAL & PREMIUM",         hint: "minimal, clean, luxury, sophisticated, premium brand feel, less is more" },
  ];

  try {
    const { openrouter } = await import("@workspace/integrations-openrouter-ai");

    const variants = await Promise.all(DIRECTIONS.map(async (dir) => {
      const r = await openrouter.chat.completions.create({
        model: "google/gemini-2.0-flash-001",
        messages: [
          {
            role: "system",
            content: `You are a senior creative strategist at Accelerated Experiences LLC (video, photo, branding, social, podcast, gaming). AE brand: navy #0a1e3d, cyan #0ea5e9. Generate ONE creative direction for the given project. This direction must feel: ${dir.hint}. Return ONLY a valid JSON object (no markdown, no extra text) with these exact keys: name (3-4 word punchy direction title), angle (1 sentence core creative concept), tone (3-4 comma-separated tone words), targetAudience (specific audience), keyMessages (3 key messages joined by " • "), approach (2-3 sentences on execution), visualStyle (specific visual direction with colors/composition/references), platforms (comma-separated recommended formats/platforms).`,
          },
          { role: "user", content: `Project concept: "${concept.trim()}"` },
        ],
        max_tokens: 500,
      });
      const content = r.choices[0]?.message?.content ?? "{}";
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) return { name: dir.style, angle: "Creative direction unavailable", tone: "N/A", targetAudience: "", keyMessages: "", approach: "", visualStyle: "", platforms: "" };
      try { return { ...JSON.parse(match[0]), _style: dir.style }; }
      catch { return { name: dir.style, angle: content.slice(0, 120), tone: "", targetAudience: "", keyMessages: "", approach: "", visualStyle: "", platforms: "", _style: dir.style }; }
    }));

    res.json({ variants });
  } catch (err: any) {
    (req as any).log?.error?.({ err }, "Variant generation failed");
    res.status(500).json({ error: err?.message ?? "Variant generation failed" });
  }
});

/* ── Architecture: generate world-class build prompts ──────────────────────── */
const ARCHITECTURE_KINDS = ["web_app", "website", "mobile_app", "business_os", "api"] as const;
const ArchitectureRequestSchema = z.object({
  projectType:  z.enum(ARCHITECTURE_KINDS).default("web_app"),
  description:  z.string().trim().min(1, "description is required").max(4000),
  audience:     z.string().trim().max(500).optional().default(""),
  features:     z.string().trim().max(2000).optional().default(""),
  stackPrefs:   z.string().trim().max(500).optional().default(""),
  integrations: z.string().trim().max(500).optional().default(""),
  constraints:  z.string().trim().max(1000).optional().default(""),
}).strict();

const ArchitectureResponseSchema = z.object({
  title:      z.string().min(1).max(120),
  summary:    z.string().min(1).max(800),
  prompt:     z.string().min(1),
  techStack:  z.array(z.string()).max(20).optional().default([]),
  dataModel:  z.array(z.string()).max(20).optional().default([]),
  screens:    z.array(z.string()).max(20).optional().default([]),
  milestones: z.array(z.string()).max(20).optional().default([]),
  qualityBar: z.array(z.string()).max(20).optional().default([]),
});

router.post("/creative/architecture", requireAdminAuth, async (req, res): Promise<void> => {
  const parsed = ArchitectureRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
    return;
  }
  const { projectType, description, audience, features, stackPrefs, integrations, constraints } = parsed.data;
  const kind = projectType;
  const KIND_GUIDE: Record<string, string> = {
    web_app:      "a production-grade full-stack web application (React + TypeScript + a real backend + a real database)",
    website:      "a polished marketing website / landing page (responsive, fast, accessible, SEO-friendly)",
    mobile_app:   "a real React Native / Expo mobile app (iOS + Android), with native UX patterns and proper navigation",
    business_os:  "a multi-module internal business operating system (auth, roles, dashboards, CRUD, reporting) — a Replit-style monorepo with API + DB + web client",
    api:          "a clean REST/JSON API service with OpenAPI contract, typed handlers, validation, and proper error handling",
  };
  const kindLine = KIND_GUIDE[kind];

  const systemPrompt = `You are a world-class senior software architect. Your single job is to take a user's rough idea and produce ONE elite, copy-paste-ready BUILD PROMPT that an AI coding agent (like Replit Agent, Claude Code, Cursor, or v0) can execute to build a high-quality, production-grade product.

The user is building ${kindLine}.

You output STRICT JSON only — no prose, no markdown fences, no preamble. Shape:
{
  "title": "Short project name (max 6 words)",
  "summary": "One sentence describing what gets built.",
  "prompt": "THE FULL BUILD PROMPT — multi-paragraph, markdown formatted, ready to paste into an AI coding agent.",
  "techStack": ["bullet list of recommended stack with brief reason each (max 8)"],
  "dataModel": ["bullet list of key entities/tables and their important fields (max 10)"],
  "screens": ["bullet list of key pages/screens/endpoints (max 10)"],
  "milestones": ["ordered list of build phases the agent should follow (max 6)"],
  "qualityBar": ["non-negotiable quality requirements — auth, validation, error handling, no mock data, accessibility, brand polish, etc. (max 8)"]
}

The "prompt" field is the headline output. It MUST:
1. Open with a one-paragraph product summary in plain English (who it's for, what it does, why it matters).
2. Specify the exact stack (frameworks, languages, DB, key libraries) and a clear file structure.
3. Define data model: tables/collections with field names and types.
4. List every screen / route / endpoint with what it does.
5. Spell out auth, roles, and authorization rules if relevant.
6. Demand quality bars: no mocks, no placeholder data, proper validation (Zod), proper error handling, accessible UI, responsive design, and a clean visual identity (specify a real palette).
7. Forbid lazy patterns explicitly: no fake "Lorem" content, no console.log for prod logging, no silent error swallowing, no purple/violet/indigo if brand says otherwise.
8. End with a milestone-ordered build plan the agent should execute end-to-end.
9. Be specific, decisive, and self-contained — assume the agent has no other context.

Tone: confident, technical, prescriptive. Length: long enough to be unambiguous — typically 350–700 words.`;

  const userMsg = [
    `Project type: ${kind}`,
    `Description: ${description}`,
    audience      ? `Target users: ${audience}` : null,
    features      ? `Must-have features: ${features}` : null,
    stackPrefs    ? `Stack preferences: ${stackPrefs}` : null,
    integrations  ? `Required integrations: ${integrations}` : null,
    constraints   ? `Constraints: ${constraints}` : null,
  ].filter(Boolean).join("\n");

  try {
    const { openrouter } = await import("@workspace/integrations-openrouter-ai");
    const aiResponse = await openrouter.chat.completions.create({
      model: "anthropic/claude-sonnet-4",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userMsg },
      ],
      max_tokens: 4000,
    });
    const raw = aiResponse.choices[0]?.message?.content ?? "{}";
    const cleaned = raw.replace(/```(?:json)?\n?/g, "").replace(/```$/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    let parsedJson: unknown;
    try { parsedJson = JSON.parse(match ? match[0] : cleaned); }
    catch {
      (req as any).log?.error?.({ raw }, "Architecture: AI returned non-JSON");
      res.status(502).json({ error: "Architecture generator returned a malformed response. Please try again." });
      return;
    }
    const shaped = ArchitectureResponseSchema.safeParse(parsedJson);
    if (!shaped.success) {
      (req as any).log?.error?.({ issues: shaped.error.issues }, "Architecture: AI output failed schema");
      res.status(502).json({ error: "Architecture generator returned an incomplete response. Please try again." });
      return;
    }
    res.json(shaped.data);
  } catch (err: any) {
    (req as any).log?.error?.({ err: err?.message, stack: err?.stack }, "Architecture prompt generation failed");
    res.status(500).json({ error: "Architecture generator is temporarily unavailable. Please try again." });
  }
});

export default router;
