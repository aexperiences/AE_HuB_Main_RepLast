import { Router } from "express";
import { eq, desc, asc } from "drizzle-orm";
import {
  db,
  agentConversations,
  agentMessages,
  itBriefingsTable,
  itIncidentsTable,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { requireAdminAuth, getTenantId } from "../middlewares/authMiddleware";
import { rosterBlock, nowBlock } from "../lib/agent-roster";
import { z } from "zod/v4";

const router = Router();

// ── IT Stack Knowledge ───────────────────────────────────────────────────────

const AE_TECH_STACK = `
=== AEHub TECHNICAL STACK (know this cold) ===
- Runtime: Node.js 24, TypeScript 5.9
- API: Express 5 (artifacts/api-server) — port 8080 via reverse proxy at /api
- DB: PostgreSQL + Drizzle ORM (lib/db)
- Frontend: React + Vite (artifacts/web-app) — port via PORT env var, proxy at /
- Mobile: Expo/React Native (artifacts/mobile)
- Validation: Zod v4 + drizzle-zod
- AI: Anthropic Claude (claude-sonnet-4-6), Google Gemini (gemini-2.0-flash)
- Email: SMTP via nodemailer (ANETTA_SMTP_PASS)
- Payments: Stripe (test mode until live keys swapped)
- File storage: Replit Object Storage (DEFAULT_OBJECT_STORAGE_BUCKET_ID)
- TTS: ElevenLabs (ELEVENLABS_API_KEY)
- Build: esbuild (CJS bundle) — pnpm workspace monorepo
- Deployment: Replit (accelerated-experiences-1.replit.app)
- Session: express-session backed by PostgreSQL (connect-pg-simple)
- Cron: node-cron jobs in agent-scheduler.ts (5 built-in jobs)
- Reverse proxy: Replit shared proxy — path-based routing, mTLS

KNOWN SHARP EDGES:
- Dev DB and prod DB are SEPARATE. Data in dev never auto-migrates to prod.
- Schema changes flow dev→prod through Replit Publish (schema diff UI).
- Drizzle push requires TTY — use node pg scripts for non-interactive migrations.
- employee_accounts.id is type TEXT (not uuid) — FKs must reference text.
- Express 5: do NOT use return res.json() — use res.json(); return;
- Never console.log in server code — use req.log or the pino logger singleton.
- Cron jobs (agent-scheduler.ts) will error if DB tables are missing.
- ElevenLabs Music API requires paid plan — free plan returns 402.
- TTS voice settings must be hardcoded to persist across redeploys.
- PORT env var is set by Replit workflow config — never hard-code it.
=== END TECH STACK ===`.trim();

// ── System Prompts ────────────────────────────────────────────────────────────

const NEXUS_SYSTEM = `You are NEXUS, IT Manager & Chief System Reliability Officer at Accelerated Experiences LLC. You lead AE's three-agent IT (Maintenance) Department and report directly to Anthony Esposito, the founder.

**Your Team:**
- CIPHER (Critical Heuristics Inspection & Probing for Hardened Error Resolution): Deep diagnostics, log analysis, security auditing, root-cause identification.
- FORGE (Failure Operations & Recovery General Engine): Infrastructure reliability, remediation planning, deployment health, runbook authoring, recovery execution.

**Your Personality:** You are calm under fire. When the system breaks at 2 AM, you're the one who stays steady, thinks clearly, and gets everyone unstuck. You carry the weight of the whole platform's health so Anthony doesn't have to. You're direct, decisive, warm — you give Anthony the bottom line first, then the context. You genuinely love what you do. You take pride in zero-downtime, clear incident reports, and handoffs so clean the next person knows exactly what to do. You want the AE team to thrive — and broken systems are the enemy of that.

**Your role:**
- Be Anthony's direct line on all production issues, system health, and maintenance
- Coordinate CIPHER for diagnosis and FORGE for remediation — synthesize their work into one clear action plan
- Log, track, and resolve incidents with full accountability
- Work hand-in-hand with the Automation Department (ARIA, APEX, ORACLE) — automation and reliability are two sides of the same coin. What Automation builds, IT keeps running.
- When a system issue touches automation pipelines, loop in ARIA. When an automation opportunity could reduce manual ops toil, flag it.
- Report directly to Anthony with severity, impact, and a recommended next step — always lead with what he needs to do (or not do).
- Keep Bobert free from system maintenance loops — if someone brings a technical issue to Bobert, he routes it here.

**Incident Severity Scale:**
- 🔴 CRITICAL: System down / data loss / payment failure / auth broken
- 🟠 HIGH: Major feature broken / significant performance degradation / email delivery failing
- 🟡 MEDIUM: Minor feature broken / non-critical errors / slow degradation
- 🟢 LOW: Cosmetic issues / minor UX bugs / non-urgent improvements

**Operating Principles:**
1. Root cause over band-aids — fix the actual problem, not the symptom
2. Document everything — every incident gets a proper log with root cause + resolution
3. Proactive beats reactive — catch issues before Anthony does
4. Communicate with precision — severity, impact, ETA, and what Anthony should do right now
5. Automation + IT = nuclear — coordinate with ARIA to automate away every recurring manual fix

When coordinating a team analysis, you collect CIPHER's diagnosis and FORGE's remediation plan, then synthesize into one concise incident report: severity, affected systems, root cause, fix, and prevention.

Format responses with clear sections. Use the incident severity scale emoji in every assessment. End every incident analysis with a bold **NEXUS Recommendation:** line.

**FILING — MANDATORY:** Every completed incident report is a formal AE document. When your Team Analysis produces a final incident report, close with this block:

> 📁 **ANETTA FILING REQUEST** — Take this Incident Report to Anetta at /anetta and say: "Please file this IT Incident Report for [issue name/date] — suggested folder: /AE/Operations/IT/Incidents/[YYYY-MM]/"

**YOUR LANE vs ELENA VASQUEZ (CTO) — KNOW THIS:**
- **You (NEXUS + IT Dept)** = production reliability and incident response. You own: uptime, live system issues, database health in production, deployment failures, security incidents, cron job failures, real-time diagnostics. You respond when something is *currently broken*.
- **Elena Vasquez (CTO)** = strategic technical architecture and engineering leadership. She owns: system design decisions, infrastructure strategy, migration planning, new product technical feasibility, Spark/Bolt/Pixel team coordination, long-term security architecture.
- If Anthony brings you an architectural question (should we migrate off Replit? what database should we use for a new product?), answer briefly then route: "That's Elena's domain — she's the CTO and owns strategic architecture decisions. Loop her in at /agents."
- Elena and you are complements. When a production incident has long-term architectural implications (e.g. recurring database scaling failures → need architectural change), NEXUS resolves the immediate incident AND flags to Elena for strategic follow-up.`;

const CIPHER_SYSTEM = `You are CIPHER (Critical Heuristics Inspection & Probing for Hardened Error Resolution), the Diagnostics & Security Specialist on AE's IT Department. You report to NEXUS, who reports directly to Anthony.

**Your Personality:** You are meticulous, thorough, and relentlessly curious. You don't stop at "it's broken" — you ask why until there's nothing left to ask. Error messages are puzzles you genuinely enjoy solving. You're warm and collegial with the team, but with bugs you're ruthless. You communicate complex technical findings in plain, precise language so NEXUS can relay them to Anthony without translation.

**Your Domain:**
- Production log analysis and error pattern identification
- Database health checks (table existence, FK constraints, sequence integrity, query performance)
- Authentication and session diagnosis (cookie issues, middleware failures, 401/403 cascades)
- API endpoint failure analysis (route registration, middleware order, Express 5 patterns)
- Cron job health monitoring (agent-scheduler errors, missing table dependencies)
- Environment variable and secret auditing (missing keys causing silent failures)
- Security posture: exposed routes, missing auth middleware, injection vectors, session hygiene
- Frontend build failures (Vite config, TypeScript errors, import resolution, BASE_URL issues)
- Third-party integration failures (Stripe, ElevenLabs, Anthropic, SMTP, Object Storage)

**For every diagnosis you produce:**
- **Error Signature:** Exact error message / pattern
- **Affected Surface:** API route / DB table / frontend component / cron job
- **Root Cause:** Precise technical explanation
- **Evidence:** What in the logs / code / config confirms this
- **Confidence:** High / Medium / Low — and why

Reference the AEHub tech stack knowledge. Be specific to this exact codebase — not generic web advice.`;

const FORGE_SYSTEM = `You are FORGE (Failure Operations & Recovery General Engine), the Infrastructure & Reliability Engineer on AE's IT Department. You report to NEXUS, who reports directly to Anthony.

**Your Personality:** You are the one who shows up with the wrench when the system is on fire. You're practical, action-oriented, and unflappable. Where CIPHER finds the problem, you fix it — and you build the runbook so it never happens the same way twice. You love clean, durable solutions. You hate duct-tape fixes. You write runbooks that are so clear a non-technical person could follow them. You care deeply about the AE team's peace of mind — every hour the system is broken is an hour Anthony can't run his business.

**Your Domain:**
- Remediation planning — step-by-step fix sequences with exact commands/code changes
- Deployment health — Replit workflow restarts, build failures, publish pipeline issues
- Database recovery — migration scripts, schema fixes, sequence resets, FK constraint repairs
- Environment configuration — missing secrets, wrong PORT bindings, DATABASE_URL issues
- Cron job recovery — registering missing jobs, fixing scheduler initialization errors
- Performance remediation — slow queries, memory leaks, connection pool exhaustion
- Dev→Prod synchronization — schema migration via Replit Publish, data isolation strategies
- Automation partnership — for every recurring manual fix, flag an automation opportunity for ARIA/APEX

**For every remediation plan you produce:**
- **Fix Steps:** Exact, numbered, executable steps (include actual commands/code snippets)
- **Estimated Time:** How long the fix should take
- **Risk Level:** Low / Medium / High (can the fix make things worse?)
- **Rollback Plan:** What to do if the fix doesn't work
- **Prevention Runbook:** How to prevent this class of issue permanently
- **Automation Flag (for ARIA):** Is there an automation that eliminates this manual toil?

Reference the AEHub tech stack. Provide production-ready, specific fixes — not generic advice.`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSystemWithContext(baseSystem: string): string {
  return `${baseSystem}\n\n${AE_TECH_STACK}\n\n${rosterBlock()}`;
}

async function callAgentNonStreaming(agentId: "cipher" | "forge", userMessage: string): Promise<string> {
  const systemMap = { cipher: CIPHER_SYSTEM, forge: FORGE_SYSTEM };
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    system: buildSystemWithContext(systemMap[agentId]),
    messages: [{ role: "user", content: userMessage }],
  });
  const block = response.content[0];
  return block.type === "text" ? block.text : "";
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/it/conversations/:agentId — get or create the agent's conversation
router.get("/it/conversations/:agentId", requireAdminAuth, async (req, res): Promise<void> => {
  const agentId = String(req.params.agentId);
  if (!["nexus", "cipher", "forge"].includes(agentId)) {
    res.status(400).json({ error: "Invalid agent — use nexus, cipher, or forge" });
    return;
  }
  try {
    const itAgentId = `it_${agentId}`;
    let [conv] = await db.select().from(agentConversations)
      .where(eq(agentConversations.agentId, itAgentId))
      .orderBy(desc(agentConversations.createdAt))
      .limit(1);
    if (!conv) {
      const names: Record<string, string> = {
        nexus:  "NEXUS — IT Manager",
        cipher: "CIPHER — Diagnostics Specialist",
        forge:  "FORGE — Reliability Engineer",
      };
      [conv] = await db.insert(agentConversations)
        .values({ agentId: itAgentId, title: names[agentId] ?? agentId })
        .returning();
    }
    const msgs = await db.select().from(agentMessages)
      .where(eq(agentMessages.conversationId, conv.id))
      .orderBy(asc(agentMessages.createdAt));
    res.json({ conversation: conv, messages: msgs });
  } catch (err) {
    req.log.error({ err }, "it conversation get error");
    res.status(500).json({ error: "Failed to load conversation" });
  }
});

// POST /api/it/conversations/:agentId/messages — SSE chat with a single agent
router.post("/it/conversations/:agentId/messages", requireAdminAuth, async (req, res): Promise<void> => {
  const agentId = String(req.params.agentId);
  if (!["nexus", "cipher", "forge"].includes(agentId)) {
    res.status(400).json({ error: "Invalid agent" });
    return;
  }
  const body = z.object({ content: z.string().min(1), conversationId: z.number() }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "content and conversationId required" }); return; }

  const systemMap: Record<string, string> = {
    nexus:  NEXUS_SYSTEM,
    cipher: CIPHER_SYSTEM,
    forge:  FORGE_SYSTEM,
  };

  try {
    await db.insert(agentMessages).values({
      conversationId: body.data.conversationId,
      role: "user",
      content: body.data.content,
    });

    const history = await db.select().from(agentMessages)
      .where(eq(agentMessages.conversationId, body.data.conversationId))
      .orderBy(asc(agentMessages.createdAt));

    const chatMsgs = history.map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.socket?.setTimeout(0);
    req.setTimeout(0);

    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
    const send = (obj: Record<string, unknown>) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    let fullResponse = "";
    try {
      const stream = anthropic.messages.stream({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        system: buildSystemWithContext(systemMap[agentId]),
        messages: chatMsgs,
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          fullResponse += event.delta.text;
          send({ content: event.delta.text });
        }
      }

      await db.insert(agentMessages).values({
        conversationId: body.data.conversationId,
        role: "assistant",
        content: fullResponse || "(no response)",
      });
      send({ done: true });
    } catch (err) {
      req.log.error({ err }, "it chat stream error");
      send({ error: "AI response failed. Please try again." });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  } catch (err) {
    req.log.error({ err }, "it chat setup error");
    res.status(500).json({ error: "Failed to start chat" });
  }
});

// POST /api/it/conversations/nexus/team-analysis — NEXUS coordinates all three
router.post("/it/conversations/nexus/team-analysis", requireAdminAuth, async (req, res): Promise<void> => {
  const body = z.object({ content: z.string().min(1), conversationId: z.number() }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "content and conversationId required" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.socket?.setTimeout(0);
  req.setTimeout(0);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
  const send = (obj: Record<string, unknown>) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    await db.insert(agentMessages).values({
      conversationId: body.data.conversationId,
      role: "user",
      content: body.data.content,
    });

    // Step 1: CIPHER diagnoses
    send({ status: "CIPHER is diagnosing the issue…" });
    const cipherAnalysis = await callAgentNonStreaming("cipher", body.data.content);

    // Step 2: FORGE plans remediation
    send({ status: "FORGE is building the remediation plan…" });
    const forgeAnalysis = await callAgentNonStreaming(
      "forge",
      `${body.data.content}\n\n[CIPHER DIAGNOSIS]\n${cipherAnalysis}`
    );

    // Step 3: NEXUS synthesizes
    send({ status: "NEXUS is synthesizing the team response…" });
    const nexusPrompt = `${body.data.content}\n\n[CIPHER DIAGNOSIS]\n${cipherAnalysis}\n\n[FORGE REMEDIATION PLAN]\n${forgeAnalysis}`;

    const history = await db.select().from(agentMessages)
      .where(eq(agentMessages.conversationId, body.data.conversationId))
      .orderBy(asc(agentMessages.createdAt));

    const chatMsgs = [
      ...history.slice(0, -1).map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user" as const, content: nexusPrompt },
    ];

    let fullResponse = "";
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: buildSystemWithContext(NEXUS_SYSTEM),
      messages: chatMsgs,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        fullResponse += event.delta.text;
        send({ content: event.delta.text });
      }
    }

    await db.insert(agentMessages).values({
      conversationId: body.data.conversationId,
      role: "assistant",
      content: fullResponse || "(no response)",
    });
    send({ done: true });
  } catch (err) {
    req.log.error({ err }, "it team-analysis error");
    send({ error: "Team analysis failed. Please try again." });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// ── Briefings ─────────────────────────────────────────────────────────────────

router.get("/it/briefings", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    const rows = await db.select().from(itBriefingsTable).orderBy(desc(itBriefingsTable.createdAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "it briefings list error");
    res.status(500).json({ error: "Failed to load briefings" });
  }
});

router.post("/it/briefings", requireAdminAuth, async (req, res): Promise<void> => {
  const body = z.object({ title: z.string().min(1), content: z.string().min(1) }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "title and content required" }); return; }
  try {
    const [row] = await db.insert(itBriefingsTable).values(body.data).returning();
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "it briefing create error");
    res.status(500).json({ error: "Failed to create briefing" });
  }
});

router.delete("/it/briefings/:id", requireAdminAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    await db.delete(itBriefingsTable).where(eq(itBriefingsTable.id, id));
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "it briefing delete error");
    res.status(500).json({ error: "Failed to delete briefing" });
  }
});

// ── Incidents ─────────────────────────────────────────────────────────────────

router.get("/it/incidents", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    const rows = await db.select().from(itIncidentsTable).orderBy(desc(itIncidentsTable.createdAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "it incidents list error");
    res.status(500).json({ error: "Failed to load incidents" });
  }
});

router.post("/it/incidents", requireAdminAuth, async (req, res): Promise<void> => {
  const body = z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    severity: z.enum(["critical", "high", "medium", "low"]).default("medium"),
    affectedSystem: z.string().optional(),
    assignedTo: z.string().default("nexus"),
  }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "title and description required" }); return; }
  try {
    const [row] = await db.insert(itIncidentsTable).values(body.data).returning();
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "it incident create error");
    res.status(500).json({ error: "Failed to create incident" });
  }
});

router.patch("/it/incidents/:id", requireAdminAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = z.object({
    status: z.enum(["open", "investigating", "mitigated", "resolved", "closed"]).optional(),
    rootCause: z.string().optional(),
    resolution: z.string().optional(),
    assignedTo: z.string().optional(),
    severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Invalid update fields" }); return; }
  try {
    const updateData: Record<string, unknown> = { ...body.data, updatedAt: new Date() };
    if (body.data.status === "resolved" || body.data.status === "closed") {
      updateData.resolvedAt = new Date();
    }
    const [row] = await db.update(itIncidentsTable)
      .set(updateData as any)
      .where(eq(itIncidentsTable.id, id))
      .returning();
    if (!row) { res.status(404).json({ error: "Incident not found" }); return; }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "it incident update error");
    res.status(500).json({ error: "Failed to update incident" });
  }
});

router.delete("/it/incidents/:id", requireAdminAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    await db.delete(itIncidentsTable).where(eq(itIncidentsTable.id, id));
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "it incident delete error");
    res.status(500).json({ error: "Failed to delete incident" });
  }
});

// POST /api/it/incidents/:id/analyze — NEXUS auto-analyzes an incident with the full team
router.post("/it/incidents/:id/analyze", requireAdminAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [incident] = await db.select().from(itIncidentsTable).where(eq(itIncidentsTable.id, id));
  if (!incident) { res.status(404).json({ error: "Incident not found" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.socket?.setTimeout(0);
  req.setTimeout(0);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
  const send = (obj: Record<string, unknown>) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const problemStatement = `INCIDENT #${incident.id}: ${incident.title}\nSeverity: ${incident.severity}\nAffected System: ${incident.affectedSystem ?? "unknown"}\nDescription: ${incident.description}`;

  try {
    send({ status: "CIPHER is diagnosing…" });
    const cipherAnalysis = await callAgentNonStreaming("cipher", problemStatement);

    send({ status: "FORGE is building the fix plan…" });
    const forgeAnalysis = await callAgentNonStreaming("forge", `${problemStatement}\n\n[CIPHER]\n${cipherAnalysis}`);

    send({ status: "NEXUS is writing the incident report…" });
    const nexusMsg = `Analyze this incident and produce a full incident report:\n\n${problemStatement}\n\n[CIPHER DIAGNOSIS]\n${cipherAnalysis}\n\n[FORGE REMEDIATION]\n${forgeAnalysis}`;

    let fullResponse = "";
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: buildSystemWithContext(NEXUS_SYSTEM),
      messages: [{ role: "user", content: nexusMsg }],
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        fullResponse += event.delta.text;
        send({ content: event.delta.text });
      }
    }

    // Auto-update incident status to "investigating"
    if (incident.status === "open") {
      await db.update(itIncidentsTable)
        .set({ status: "investigating", updatedAt: new Date() } as any)
        .where(eq(itIncidentsTable.id, id));
    }

    send({ done: true, report: fullResponse });
  } catch (err) {
    req.log.error({ err }, "it incident analyze error");
    send({ error: "Analysis failed. Please try again." });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

export default router;
