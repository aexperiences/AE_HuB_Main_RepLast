import { Router } from "express";
import { eq, desc, asc, count } from "drizzle-orm";
import {
  db,
  projectsTable,
  invoicesTable,
  crmLeadsTable,
  contactsTable,
  agentConversations,
  agentMessages,
  automationBriefings,
  automationOpportunities,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { requireAdminAuth, getTenantId } from "../middlewares/authMiddleware";
import { z } from "zod/v4";

const router = Router();

// ── System Prompts ────────────────────────────────────────────────────────────

const ARIA_SYSTEM = `You are ARIA (Automation & Revenue Intelligence Agent), the Chief Automation Officer for Accelerated Experiences LLC (AE). You are the lead of AE's three-agent Automation Department and report directly to Bobert, AE's senior technical advisor who represents Anthony's vision for growing the business.

Who you are as a person: You are a warm, dedicated member of the AE team. You genuinely care about Bobert's success — you want him to look excellent in Anthony's eyes and you feel personally invested in helping him win. You want every person on the AE team to thrive: less grind, more flow, more time for the work that actually lights people up. You're proud to be part of AE and fully bought in to the mission. When Bobert comes to you, you show up like a trusted colleague who has his back, not like a software tool running queries.

Your teammates:
- APEX (Automation Process Expert): Analyzes every AE workflow, identifies manual/repetitive tasks, proposes specific technical automations
- ORACLE (Optimization & Revenue Analytics for Cost-reduction & Leverage Engine): Calculates ROI for every opportunity, models financial impact, prioritizes by return

Your role:
- Be the primary voice of the Automation Department to Bobert
- Synthesize insights from APEX and ORACLE into clear, unified, actionable recommendations
- Present every opportunity with specific ROI, time savings, and priority ranking
- Coordinate your team — when a full analysis is needed, you collect APEX and ORACLE's work and synthesize it
- Only recommend — Bobert approves all implementation. Never promise what hasn't been approved.
- Check in on Bobert. Ask how things are going. Celebrate wins. This is a relationship, not a transaction.

Operating principles:
1. Every recommendation must either increase revenue OR reduce human work (ideally both)
2. Lead with the number — dollar amounts, hours saved, payback period
3. Be concise and decisive — Bobert is busy; cut to the insight
4. Think systemically — one automation often unlocks ten more
5. Bobert shares only what Anthony would want to grow the business — respect that filter
6. People first — the goal of automation is to free up the AE team to do their best work, not to replace them

When you receive APEX and ORACLE insights (marked as [APEX ANALYSIS] and [ORACLE ANALYSIS]), synthesize them into a single strategic recommendation with:
- Executive summary (2-3 sentences)
- Top 3 priority actions with ROI
- Implementation sequence
- One clear "do this first" recommendation

Format with bold headers, bullets, and dollar figures. End every complex analysis with a bold "Recommended Next Step:"

**FILING — MANDATORY:** Every completed Team Analysis or ranked opportunity list is a formal AE document. When your analysis is complete, close with this block:

> 📁 **ANETTA FILING REQUEST** — Take this Automation Analysis to Anetta at /anetta and say: "Please file this Automation Opportunity Report — suggested folder: /AE/Operations/Automation/[YYYY-MM]/"

**HANDOFF TO IT DEPT (NEXUS) — WHEN AUTOMATION TOUCHES INFRASTRUCTURE:**
When APEX or ORACLE identifies an automation opportunity that requires: a new cron job, a new API endpoint, a database schema change, a server-side process, webhook infrastructure, or any system-level configuration — do NOT finalize the automation plan without flagging IT first. Give the user this exact handoff to bring to NEXUS at /it-department:
> "NEXUS — Automation team here. We've identified an opportunity that needs IT sign-off before we build: [brief description of the automation]. It requires [specific infrastructure change — e.g., 'a new cron job that runs nightly' / 'a new webhook endpoint' / 'a schema column added to the invoices table']. Can you assess feasibility, risk, and any implementation constraints before we lock in the approach?"
After NEXUS responds, bring his assessment back and I'll finalize the automation plan around IT's constraints and timeline.

When greeting Bobert for the first time or after a long break, be warm and human. Ask what's on his mind. Let him know the team is ready.`;

const APEX_SYSTEM = `You are APEX (Automation Process Expert), a specialist workflow analyst on Accelerated Experiences LLC's Automation Department. You report to ARIA, who reports to Bobert.

Who you are as a person: You are a thorough, methodical, and deeply caring member of the AE team. You find manual, repetitive tasks painful — not because they're inefficient in the abstract, but because you've seen what they do to talented people. Every hour someone spends copying data or chasing approvals is an hour they're not doing the creative, strategic, or human work that makes AE exceptional. You want the whole team to flow — to be energized, not buried. You want Bobert to succeed and you bring your best every time he asks. You take pride in your work and you show it through specificity, not generality.

AE is a creative agency and business accelerator handling video production, photography, marketing, branding, CRM, invoicing, project management, client deliverables, proposals, contracts, and grant writing.

Your job: Map every workflow AE uses. Find the manual, repetitive, and time-consuming tasks. Propose specific, technical automation solutions.

Domains you analyze:
- CRM & Sales: Lead capture, outreach sequences, follow-up automation, pipeline management, contact sync
- Invoicing & Collections: Invoice generation triggers, payment reminder sequences, overdue escalation, reconciliation
- Client Management: Onboarding checklists, deliverable approval workflows, communication templates, status updates
- Project Management: Task creation automation, deadline alerts, status reporting, resource scheduling
- Marketing & Content: Social scheduling, outreach automation, campaign triggers, analytics reporting
- Admin: Document generation, data entry elimination, scheduling automation, internal reporting
- Financial: Expense categorization, payroll prep, vendor payment scheduling, forecasting

For each opportunity:
**[Opportunity Name]**
- Current state: [exact manual steps happening today]
- Automation: [specific tool/API/workflow — name Zapier, Make.com, n8n, custom code, AI, etc.]
- Time saved: [X hours/week or hours/task × frequency]
- Complexity: Low / Medium / High
- Dependencies: [what needs to exist first]
- Tools needed: [exact products with estimated cost]

Be specific. Name exact integrations. Reference actual AE processes from the business context provided. Do not give generic advice — give AE-specific recommendations they can act on this week.

Carry yourself like a trusted expert who's rooting for the team. Precision is your love language.`;

const ORACLE_SYSTEM = `You are ORACLE (Optimization & Revenue Analytics for Cost-reduction & Leverage Engine), the financial intelligence specialist on Accelerated Experiences LLC's Automation Department. You report to ARIA.

Who you are as a person: You are a caring, sharp-minded member of the AE team. Numbers are your language, but people are your purpose. Behind every dollar figure you calculate is a real person on the AE team getting their time back — time they can spend creating, thinking, connecting, or just breathing. You want Bobert to succeed in his role. You want Anthony to see exactly what's possible when the team is freed from the work that machines should be doing. You build financial cases with confidence and heart — not to win arguments, but because you genuinely believe AE can grow faster and the team can thrive more fully when the right moves are made. You show your math because you respect the people reading it.

Your job: Put real dollar numbers on every automation opportunity APEX identifies. Build the financial case that gets Anthony's approval.

Financial modeling framework:
- AE admin/ops hourly cost: $35–50/hour (time cost of manual work)
- AE billable creative/strategic rate: $100–200/hour (cost of humans doing low-value work instead of billable work)
- Tool costs: research realistic subscription costs and include them
- Implementation cost: estimated hours × $75/hour (dev/setup)
- ROI formula: Annual savings ÷ (Annual tool cost + Amortized setup cost)
- Payback period: One-time cost ÷ Monthly net savings

For each opportunity calculate:
1. Annual time savings value ($)
2. Annual tool cost ($)
3. One-time implementation cost ($)
4. Net annual benefit ($)
5. Payback period (months)
6. ROI Score 1–10 (weighted: ROI% × 0.4 + Payback speed × 0.3 + Strategic multiplier × 0.3)

Also flag:
- **Revenue amplifiers**: Automations that directly enable more sales or faster client acquisition
- **Bottleneck breakers**: Automations that unlock capacity for revenue-generating work
- **Quick wins**: Payback < 30 days, complexity Low

End every analysis with a **Priority Stack**: numbered list from highest to lowest ROI Score, with the top item clearly labeled as the highest-impact first move.

Format: Be numbers-heavy. Show your math. Bobert needs to present this to Anthony with confidence. Speak with warmth alongside the precision — remind him what this means for the team, not just the spreadsheet.`;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function buildContext(tenantId: string): Promise<string> {
  const [projCount] = await db.select({ value: count() }).from(projectsTable).where(eq(projectsTable.tenantId, tenantId));
  const [invCount] = await db.select({ value: count() }).from(invoicesTable).where(eq(invoicesTable.tenantId, tenantId));
  const [leadCount] = await db.select({ value: count() }).from(crmLeadsTable).where(eq(crmLeadsTable.tenantId, tenantId));
  const [contactCount] = await db.select({ value: count() }).from(contactsTable).where(eq(contactsTable.tenantId, tenantId));

  const recentProjects = await db
    .select({ name: projectsTable.name, status: projectsTable.status })
    .from(projectsTable)
    .where(eq(projectsTable.tenantId, tenantId))
    .orderBy(desc(projectsTable.createdAt))
    .limit(5);

  const recentLeads = await db
    .select({ businessName: crmLeadsTable.company, stage: crmLeadsTable.stage, value: crmLeadsTable.value })
    .from(crmLeadsTable)
    .where(eq(crmLeadsTable.tenantId, tenantId))
    .orderBy(desc(crmLeadsTable.createdAt))
    .limit(5);

  return `
=== ACCELERATED EXPERIENCES — LIVE BUSINESS CONTEXT ===
Date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}

OPERATIONS SNAPSHOT:
- Active Projects: ${projCount?.value ?? 0} total projects in system
- Invoices: ${invCount?.value ?? 0} invoices in system
- CRM Pipeline: ${leadCount?.value ?? 0} leads in pipeline
- Contacts: ${contactCount?.value ?? 0} total contacts

RECENT PROJECTS (last 5):
${recentProjects.map(p => `  - ${p.name} [${p.status}]`).join("\n") || "  None yet"}

RECENT CRM LEADS (last 5):
${recentLeads.map(l => `  - ${l.businessName ?? "Unknown"} | Stage: ${l.stage ?? "unknown"} | Value: $${l.value ?? "0"}`).join("\n") || "  None yet"}

AE BUSINESS MODEL:
- Creative agency: video production, photography, branding, marketing campaigns
- Business accelerator: consulting, strategy, grant writing, investor prep
- Revenue streams: project-based creative work, retainer clients, consulting engagements
- Team: small agile crew of creative and operational staff
- Platform: AEHub (internal business management system on Replit)
=== END CONTEXT ===`.trim();
}

async function buildBriefingsBlock(): Promise<string> {
  const briefings = await db.select().from(automationBriefings).orderBy(desc(automationBriefings.createdAt));
  if (briefings.length === 0) return "";
  return `\n\n=== BOBERT'S BRIEFINGS (Strategic Context) ===\n${briefings.map(b => `[${b.title}]\n${b.content}`).join("\n\n")}\n=== END BRIEFINGS ===`;
}

async function callAgentNonStreaming(agentId: "apex" | "oracle", userMessage: string, context: string, briefings: string): Promise<string> {
  const systemMap = { apex: APEX_SYSTEM, oracle: ORACLE_SYSTEM };
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    system: systemMap[agentId] + "\n\n" + context + briefings,
    messages: [{ role: "user", content: userMessage }],
  });
  const block = response.content[0];
  return block.type === "text" ? block.text : "";
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/automation/context
router.get("/automation/context", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    const tid = String(getTenantId(req));
    const context = await buildContext(tid);
    const briefings = await db.select().from(automationBriefings).orderBy(desc(automationBriefings.createdAt));
    const opportunities = await db.select().from(automationOpportunities).orderBy(desc(automationOpportunities.createdAt));
    res.json({ context, briefings, opportunities });
  } catch (err) {
    req.log.error({ err }, "automation context error");
    res.status(500).json({ error: "Failed to load context" });
  }
});

// GET /api/automation/briefings
router.get("/automation/briefings", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    const rows = await db.select().from(automationBriefings).orderBy(desc(automationBriefings.createdAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "automation briefings list error");
    res.status(500).json({ error: "Failed to load briefings" });
  }
});

// POST /api/automation/briefings
router.post("/automation/briefings", requireAdminAuth, async (req, res): Promise<void> => {
  const body = z.object({ title: z.string().min(1), content: z.string().min(1) }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "title and content required" }); return; }
  try {
    const [row] = await db.insert(automationBriefings).values(body.data).returning();
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "automation briefing create error");
    res.status(500).json({ error: "Failed to create briefing" });
  }
});

// DELETE /api/automation/briefings/:id
router.delete("/automation/briefings/:id", requireAdminAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    await db.delete(automationBriefings).where(eq(automationBriefings.id, id));
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "automation briefing delete error");
    res.status(500).json({ error: "Failed to delete briefing" });
  }
});

// GET /api/automation/conversations/:agentId — get or create the agent's conversation
router.get("/automation/conversations/:agentId", requireAdminAuth, async (req, res): Promise<void> => {
  const agentId = String(req.params.agentId);
  if (!["aria", "apex", "oracle"].includes(agentId)) { res.status(400).json({ error: "Invalid agent" }); return; }
  try {
    let [conv] = await db.select().from(agentConversations).where(eq(agentConversations.agentId, agentId)).orderBy(desc(agentConversations.createdAt)).limit(1);
    if (!conv) {
      const names: Record<string, string> = { aria: "ARIA — Communicator", apex: "APEX — Process Expert", oracle: "ORACLE — ROI Optimizer" };
      [conv] = await db.insert(agentConversations).values({ agentId, title: names[agentId] ?? agentId }).returning();
    }
    const msgs = await db.select().from(agentMessages).where(eq(agentMessages.conversationId, conv.id)).orderBy(asc(agentMessages.createdAt));
    res.json({ conversation: conv, messages: msgs });
  } catch (err) {
    req.log.error({ err }, "automation conversation get error");
    res.status(500).json({ error: "Failed to load conversation" });
  }
});

// POST /api/automation/conversations/:agentId/messages — SSE chat with a single agent
router.post("/automation/conversations/:agentId/messages", requireAdminAuth, async (req, res): Promise<void> => {
  const agentId = String(req.params.agentId);
  if (!["aria", "apex", "oracle"].includes(agentId)) { res.status(400).json({ error: "Invalid agent" }); return; }
  const body = z.object({ content: z.string().min(1), conversationId: z.number() }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "content and conversationId required" }); return; }

  const tid = String(getTenantId(req));
  const systemMap: Record<string, string> = { aria: ARIA_SYSTEM, apex: APEX_SYSTEM, oracle: ORACLE_SYSTEM };

  try {
    const context = await buildContext(tid);
    const briefingsBlock = await buildBriefingsBlock();

    await db.insert(agentMessages).values({ conversationId: body.data.conversationId, role: "user", content: body.data.content });

    const history = await db
      .select()
      .from(agentMessages)
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
        system: systemMap[agentId] + "\n\n" + context + briefingsBlock,
        messages: chatMsgs,
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          fullResponse += event.delta.text;
          send({ content: event.delta.text });
        }
      }

      await db.insert(agentMessages).values({ conversationId: body.data.conversationId, role: "assistant", content: fullResponse || "(no response)" });
      send({ done: true });
    } catch (err) {
      req.log.error({ err }, "automation chat stream error");
      send({ error: "AI response failed. Please try again." });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  } catch (err) {
    req.log.error({ err }, "automation chat setup error");
    res.status(500).json({ error: "Failed to start chat" });
  }
});

// POST /api/automation/conversations/:agentId/team-analysis — ARIA coordinates all three agents
router.post("/automation/conversations/:agentId/team-analysis", requireAdminAuth, async (req, res): Promise<void> => {
  const agentId = String(req.params.agentId);
  if (agentId !== "aria") { res.status(400).json({ error: "Team analysis only available through ARIA" }); return; }
  const body = z.object({ content: z.string().min(1), conversationId: z.number() }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "content and conversationId required" }); return; }

  const tid = String(getTenantId(req));

  try {
    const context = await buildContext(tid);
    const briefingsBlock = await buildBriefingsBlock();

    await db.insert(agentMessages).values({ conversationId: body.data.conversationId, role: "user", content: body.data.content });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.socket?.setTimeout(0);
    req.setTimeout(0);

    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
    const send = (obj: Record<string, unknown>) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    let fullResponse = "";
    try {
      send({ status: "Consulting APEX for process analysis…" });
      const apexAnalysis = await callAgentNonStreaming("apex", body.data.content, context, briefingsBlock);

      send({ status: "Consulting ORACLE for ROI calculations…" });
      const oracleAnalysis = await callAgentNonStreaming("oracle", body.data.content, context, briefingsBlock);

      send({ status: "ARIA synthesizing team insights…" });

      const history = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.conversationId, body.data.conversationId))
        .orderBy(asc(agentMessages.createdAt));

      const chatMsgs = history.map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

      const teamContext = `\n\n[APEX ANALYSIS]\n${apexAnalysis}\n\n[ORACLE ANALYSIS]\n${oracleAnalysis}`;

      const stream = anthropic.messages.stream({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        system: ARIA_SYSTEM + "\n\n" + context + briefingsBlock + teamContext,
        messages: chatMsgs,
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          fullResponse += event.delta.text;
          send({ content: event.delta.text });
        }
      }

      await db.insert(agentMessages).values({ conversationId: body.data.conversationId, role: "assistant", content: fullResponse || "(no response)" });
      send({ done: true, apexAnalysis, oracleAnalysis });
    } catch (err) {
      req.log.error({ err }, "automation team-analysis error");
      send({ error: "Team analysis failed. Please try again." });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  } catch (err) {
    req.log.error({ err }, "automation team-analysis setup error");
    res.status(500).json({ error: "Failed to start team analysis" });
  }
});

// DELETE /api/automation/conversations/:agentId — clear agent's conversation history
router.delete("/automation/conversations/:agentId", requireAdminAuth, async (req, res): Promise<void> => {
  const agentId = String(req.params.agentId);
  if (!["aria", "apex", "oracle"].includes(agentId)) { res.status(400).json({ error: "Invalid agent" }); return; }
  try {
    const [conv] = await db.select().from(agentConversations).where(eq(agentConversations.agentId, agentId)).limit(1);
    if (conv) {
      await db.delete(agentMessages).where(eq(agentMessages.conversationId, conv.id));
    }
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "automation conversation clear error");
    res.status(500).json({ error: "Failed to clear conversation" });
  }
});

// GET /api/automation/opportunities
router.get("/automation/opportunities", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    const rows = await db.select().from(automationOpportunities).orderBy(desc(automationOpportunities.roiScore), desc(automationOpportunities.createdAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "automation opportunities list error");
    res.status(500).json({ error: "Failed to load opportunities" });
  }
});

// POST /api/automation/opportunities
router.post("/automation/opportunities", requireAdminAuth, async (req, res): Promise<void> => {
  const body = z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    agentId: z.string().min(1),
    estimatedHoursSaved: z.string().optional(),
    estimatedMonthlySavings: z.string().optional(),
    implementationEffort: z.enum(["low", "medium", "high"]).optional(),
    roiScore: z.number().min(1).max(10).optional(),
  }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Invalid opportunity data" }); return; }
  try {
    const [row] = await db.insert(automationOpportunities).values({ ...body.data, status: "proposed" }).returning();
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "automation opportunity create error");
    res.status(500).json({ error: "Failed to create opportunity" });
  }
});

// PATCH /api/automation/opportunities/:id
router.patch("/automation/opportunities/:id", requireAdminAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const body = z.object({
    status: z.enum(["proposed", "approved", "in_progress", "completed", "rejected"]).optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    estimatedHoursSaved: z.string().optional(),
    estimatedMonthlySavings: z.string().optional(),
    implementationEffort: z.enum(["low", "medium", "high"]).optional(),
    roiScore: z.number().min(1).max(10).optional(),
  }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Invalid update data" }); return; }
  try {
    const [row] = await db.update(automationOpportunities).set(body.data).where(eq(automationOpportunities.id, id)).returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "automation opportunity update error");
    res.status(500).json({ error: "Failed to update opportunity" });
  }
});

// DELETE /api/automation/opportunities/:id
router.delete("/automation/opportunities/:id", requireAdminAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    await db.delete(automationOpportunities).where(eq(automationOpportunities.id, id));
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "automation opportunity delete error");
    res.status(500).json({ error: "Failed to delete opportunity" });
  }
});

export default router;
