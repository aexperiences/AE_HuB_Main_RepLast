import { Router, type IRouter } from "express";
import { eq, desc, and, gte, sql } from "drizzle-orm";
import { db, emailDraftsTable, filingRequestsTable, emailsTable } from "@workspace/db";
import { requireAdminAuth, requireEmployeeAuth, getTenantId, getSession } from "../middlewares/authMiddleware";
import { sendAnettaEmail, isAnettaEmailConfigured } from "../lib/anetta-email";
import { logger } from "../lib/logger";
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { resolveModel } from "../lib/ai-models";
import { rosterBlock, AE_WORKFLOW_BLOCK } from "../lib/agent-roster";
import { AE_FILING_SYSTEM, requestFiling, scopeForRole, pathAllowed } from "../lib/anetta-filing";

const AEHUB_SYSTEM_MANUAL = `You are the AEHub System Expert — an AI assistant that knows every feature, workflow, and shortcut inside AEHub (Accelerated Experiences LLC's business operating system). Answer user questions clearly, specifically, and with exact paths/buttons to click.

${rosterBlock()}

${AE_WORKFLOW_BLOCK}

=== AEHUB OVERVIEW ===
AEHub is Accelerated Experiences LLC's all-in-one business management platform. It covers:
• Creative Studio (unified workspace at /creative — Bobert builds images, code, mockups, scripts on demand)
• Filing Cabinet (/files — central document storage; Anetta routes new files through admin approval)
• Financial Management (Geoffrey AI CFO — analysis, grants, opportunity radar)
• Project Management (Dolly AI PM — tasks, timelines, vendors, budgets)
• CRM (leads, pipeline, contacts, email blast)
• Client Portal (client accounts, deliverables, contracts, invoices)
• Agent Hub (Sharon, Dolly, Geoffrey, Anetta — AI agent team)
• Administrative (Anetta — email drafting, inbox approval, filing approval)

=== NAVIGATION ===
All routes start from the sidebar after login at aehub.
- Dashboard: /  (financial overview, revenue health, quick stats)
- Projects: /projects
- Clients: /clients
- Invoices: /invoices
- Contracts: /contracts
- Proposals: /proposals
- Expenses: /expenses
- CRM: /crm (leads, pipeline, activities)
- Contacts: /contacts (436 contacts, search, filter, email blast)
- Team: /team (employees, roles, onboarding)
- Deliverables: /deliverables
- Creative Suite: /creative (command center)
- Agent Hub: /agents (all 4 agents)
- Geoffrey (AI CFO): /geoffrey
- Sharon (Creative Director): /sharon
- Dolly (Project Manager): /dolly
- Anetta (Admin Assistant): /anetta
- Anetta Inbox: /anetta/inbox (email approvals)
- Anetta Filing Approvals: /anetta/filing (admin-only — approve / re-route files Anetta wants to file)
- Anetta Manual: /anetta/manual
- Filing Cabinet: /files (browse + download all stored documents)
- Grant Proposals: /grants (admin-only tracker for in-flight proposals)
- Request a Grant: /grants/request (any employee — fills a short form to kick off the AI grant writing pipeline)
- Architecture (admin-only): /creative/architecture
- Calendar: /calendar (all employees — company-wide events, shoots, meetings, deadlines)
- Automation Department: /automation (admin-only — ARIA, APEX, ORACLE)
- IT Department: /it-department (admin-only — NEXUS, CIPHER, FORGE)
- Digital Inventors: /inventors (admin-only — EINSTEIN, NOVA, VEGA, LYRA)

=== CREATIVE STUDIO ===
The Creative Studio is now ONE unified workspace at /creative — Bobert is the agent inside it.
Tell users "go to Creative Studio" and stop there; do NOT send them to /creative/ai-studio,
/creative/design-studio, /creative/web-studio, /creative/mobile-studio, /creative/music-studio,
/creative/ai-assistant, or /creative/scripts — those routes all redirect to /creative now.

Inside /creative, Bobert can build on demand:
• Images, logos, artwork, web mockups, mobile mockups (Gemini image generation)
• Websites / landing pages, mobile screens, browser games, React components, API routes, scripts (code generation)
Workspace toolbar (above the chat): New Project (clear), Open (load a saved project), Save (snapshot + assets).
Hover any asset card to delete it. Voice input via the mic button.

Tools that still have their own pages (linked from /creative tiles):
• Creative Briefs (/creative/briefs) — Briefs with ⚡ 3 Directions (Bold / Emotional / Minimal).
• Creative Shot Lists (/creative/shot-lists) — Scenes, equipment, crew, location.
• Project Mockups (/creative/mockups) — Designer builds + comment threads.
• Podcast Studio (/creative/podcast) — Shows, episodes, guests.
• 3D Game Studio (/creative/game-studio) — Browser-based 3D game builder.
• Photo Editor / Social Designer / Video Editor / Beat Maker / Gaming Studio / Production Tools — production-only roles.
• Architecture (/creative/architecture) — ADMIN-ONLY. Generates world-class build prompts for apps/sites/business
  systems. After generating, hit "Approve & Send to Bobert" to hand the prompt off — Bobert auto-receives it
  in /creative and starts building immediately.

=== FILING CABINET ===
Route: /files (all employees except product testers)
• Browse, search, and download every document stored in AE's filing cabinet.
• Organized by folders the admin/Anetta have approved.

Anetta Filing Approvals: /anetta/filing (admin-only)
• When an agent (Anetta, Geoffrey, etc.) wants to file a generated document, it lands here for admin review.
• Admin can confirm Anetta's suggested folder/filename, override either field, or reject the file.
• Approved files appear in /files immediately.

=== CREATIVE BRIEFS — 3 DIRECTIONS ===
1. Go to /creative/briefs
2. Open or create a brief
3. Hit the ⚡ "3 Directions" button in the toolbar
4. AI generates Bold, Emotional, and Minimal creative directions in parallel
5. Click any direction to auto-fill your brief with that concept

=== GEOFFREY (AI CFO / ACCOUNTANT) ===
Route: /geoffrey
Tabs: Analysis | Action Requests | Wealth Playbook | Opportunity Radar | Grants

• Financial Analysis — Pulls all invoices, expenses, projects. Calculates GP margin, tax liability (SE + Federal), quarterly payments. Generates top financial priority for the week.
• Opportunity Radar — Scores revenue health 0-100. Identifies cost leaks by category (month-over-month spikes). Finds 3-4 high-margin opportunities AE isn't pursuing. Returns healthLabel: Excellent/Good/Fair/At Risk/Critical.
• Grant Hunt — 9 curated grants matched to AE's profile (women-owned, minority-owned, media, tech, arts). Shows urgency: critical (<14 days), urgent (<30 days), soon (<90 days). Includes Amber Grant, MBDA, NEA, Google Black Founders, SBIR, and more.
• Action Requests — Geoffrey proposes actions (invoice follow-ups, tax payments, categorization fixes). Admin approves/denies each before Geoffrey executes.
• Wealth Playbook — Long-term wealth building strategy for founders Anthony & Jessica.
• AI Model — Default: deepseek/deepseek-chat. Can switch models via the ModelSwitcher dropdown.

=== GRANT WRITING SYSTEM ===
Full pipeline: Geoffrey Hunt → Grant Proposals → Anetta → Phase 1 (Planner) → Admin Gate → Phase 2 (Writer+Critic) → Final Review → Submit

Step-by-step:
1. Geoffrey → Grants tab: Review the 9 matched grants. See deadlines, fit scores, urgency.
2. Grants page (/grants): Create a new grant proposal targeting a specific grant.
3. Anetta (/anetta): Ask Anetta to "Start grant planning for [Grant Name]" — she triggers Phase 1 (Planner).
4. Admin Gate: The strategy plan appears in /grants with status "plan_pending". Review and approve it.
5. Phase 2 auto-runs: Writer drafts the full proposal, Senior Critic polishes it.
6. Final Review: Approve & Send, or request revisions.
7. Submit: Send completed proposal to the funder.

Key grant deadlines (as of May 2026):
• Amber Grant — May 31 (CRITICAL — THIS MONTH) — $10K monthly + $25K annual — women-owned
• Google Black Founders Fund — Rolling, apply now — $50-100K + $200K credits
• MBDA Minority Business Grant — Sep 15 — $150K-500K — federal
• NEA Media Arts — Oct 2026 — $10K-100K — video/film/podcast
• SBIR Phase I — Rolling — $150K-1.5M — AI/tech R&D

=== ANETTA (ADMINISTRATIVE ASSISTANT) ===
Route: /anetta
• Chat with Anetta to: draft emails, coordinate departments, check deadlines, get status updates.
• All emails drafted go to /anetta/inbox for admin approval before sending.
• Inbox: /anetta/inbox — approve, edit, or reject drafts.
• To draft an email: "Draft an email to [client name] about [topic]"
• To check deadlines: "What deliverables are due this week?"
• To coordinate: "Get a status update from all departments"

EMAIL FORMATTING (Anetta):
• Internal notes to admin/team → plain text is fine.
• Anything going to a CUSTOMER, CLIENT, PROSPECT, PARTNER, or the PUBLIC → Anetta MUST write
  it as formatted HTML (paragraphs, bold, lists). She fills the body_html field on the draft.
• Drafts marked "Formatted" in /anetta/inbox render as styled HTML in the preview and are sent
  to recipients with full formatting. Plain-text drafts show as monospace preview.
• Company signature is appended automatically — Anetta never writes her own sign-off.

=== NOTES (WORD PROCESSOR) ===
Route: /notes (all employees, sidebar → Workspace → Notes)
• Rich-text editor (bold, italic, headings, bullet/numbered lists, blockquotes, undo/redo).
• Autosave; pin notes to keep them at the top; full-text search across all notes.
• Use for: drafting customer-facing copy, meeting agendas, brainstorms, anything you'd type in Google Docs.
• Notes are private per employee.

=== SHARON (AI CREATIVE DIRECTOR) ===
Route: /sharon
• End-to-end creative production: YouTube packages, 3D games, website specs, brand guides.
• Disciplines: video, photography, branding, social media, podcast, web, mobile, code, 3D, gaming, ads, music.
• Request Revision: Sharon regenerates based on feedback.
• Can be assigned to specific projects to handle all creative deliverables.

=== DOLLY (AI PROJECT MANAGER) ===
Route: /dolly
• Breaks projects into prioritized tasks with roles and timelines.
• Vendor recommendations with cost estimates.
• Full budget breakdown — tracks spending vs remaining.
• Purchase Requests: generated by Dolly, approved by Admin.

=== SOCIAL MEDIA DEPARTMENT ===
Route: /social-dept
Three specialized AI agents for all social media work. They are production specialists — like Rex for scripts or Bentley for visuals, but for social media. Always route social media campaign work here after creating the project.
• VIBE (Director) — reports to Sharon. Leads the team. Viral campaign architecture, YouTube strategy, full-funnel social integration, client automation. Use "Team Campaign Analysis" mode for a full strategy brief.
• ECHO (Copy Specialist) — platform-native copywriting for X (Twitter), Instagram, Facebook, LinkedIn, TikTok, YouTube. Viral hooks, brand voice, content calendars.
• PRISM (Analytics Specialist) — campaign performance analysis, ROI tracking, KPI dashboards, audience intelligence, optimization recommendations.
HOW TO USE: When a client project involves social media, after you create the project and brief Dolly on the timeline, send the user to /social-dept with Sharon's creative brief and tell them to activate VIBE's "Team Campaign Analysis" for the full strategy. The campaign strategy VIBE produces gets filed back through you.
Social media campaign projects typically need these tasks: Campaign Strategy Brief (VIBE), Platform Copy Package (ECHO), KPI Dashboard Setup (PRISM), Sharon Copy Review, Anetta Filing, Campaign Go-Live, PRISM Performance Report (2 weeks post-launch).

=== CRM ===
Route: /crm
• Leads pipeline: stages from New Lead → Qualified → Proposal → Won/Lost.
• CRM Activities: log calls, meetings, emails, notes per lead.
• Pipeline view: visual kanban of all active deals.

=== CONTACTS ===
Route: /contacts (admin only)
• 436 contacts across: Education (117), Marketing Agency (89), Technology/SaaS (34), Web Leads (34), App Leads (33), Investor/VC (25), Foundation/Grant (18), Outdoor/Lifestyle (20), and more.
• Search by name, company, email, or category.
• Filter by Role (Grant Contact, Investor, Prospect, Client, Vendor, Partner) and Category.
• Select multiple contacts → Email Blast: compose a message and open in your email client (BCC all).
• Vendors with a contact link sync automatically when contact info is updated.

=== INVOICES & PAYMENTS ===
Route: /invoices
• Create invoices with line items, due dates, and notes.
• Status: Draft → Sent → Paid / Overdue.
• Stripe integration: "Pay Now" button on client-facing invoices processes real credit card payments.
  - Currently in test mode. To go live: add live Stripe keys in Replit Publish settings.
  - Stripe fee: 2.9% + 30¢ per transaction, 2-day payout to bank.

=== PROJECTS ===
Route: /projects
• Create/manage projects with status, budget, service type, and client assignment.
• Project tasks (sub-tasks) with assignee, due date, and status.
• Linked to: deliverables, expenses, invoices, mockups, scripts, shot lists, briefs.

=== CLIENT PORTAL ===
• Clients log in at /client (separate from employee login).
• They can view: their contracts, invoices (with Pay Now), proposals, deliverables, artwork uploads.
• Preview codes allow clients to view deliverables without logging in.

=== SECURITY & PERMISSIONS ===
Roles (highest to lowest): admin → project_manager → accounting → creator → account_rep → employee → product_tester → client
• Admin: full access to everything.
• Project Manager: projects, creative suite, CRM, team.
• Accounting: invoices, expenses, Geoffrey.
• Creator: creative suite tools only.
• Client: client portal only.

Bobert is the AI agent that lives inside /creative — he builds whatever the user asks for using
image-generation and code-generation tools. Anyone with Creative access can chat with him.
The Architecture page (/creative/architecture) is admin-only and exists specifically to generate
high-quality build prompts that get approved and sent to Bobert.

=== CALENDAR ===
Route: /calendar (all employees)
• Company-wide event and scheduling hub — shoots, client meetings, project milestones, delivery deadlines, business events.
• Click any date on the calendar grid to create a new event. Fill in title, date, time, and type.
• Event types: Meeting, Shoot, Deadline, Review, Other. Optionally link to a project and assign to a team member.
• Upcoming events surface on the Dashboard in the Upcoming Deadlines panel.
• Use Calendar for the full timeline view of how all work fits together; use the Deadlines page (/deadlines) for the prioritized flat list of due dates.

=== AUTOMATION DEPARTMENT ===
Route: /automation (admin only)
Three-agent team that finds, designs, and calculates ROI for every automation opportunity across AE's workflows. They report to Bobert. All recommendations go to Anthony for approval — the team recommends; Anthony approves; IT + Automation execute.

• ARIA (Chief Automation Officer) — team lead and primary voice. Synthesizes APEX and ORACLE insights into unified, ranked strategic recommendations with dollar impact and payback period. Every analysis ends with bold "Recommended Next Step." Use ARIA's Team Analysis for a full scan.
• APEX (Automation Process Expert) — maps every AE workflow, identifies manual/repetitive tasks, proposes specific technical automations (Zapier, Make.com, n8n, custom AI, etc.). For each opportunity: current state, automation solution, hours saved per week, complexity (Low/Medium/High), dependencies, tools + cost.
• ORACLE (Revenue Analytics) — calculates ROI for every opportunity. Produces dollar savings, payback period, revenue uplift potential, and implementation risk score. Prioritizes opportunities by financial return.

Domains covered: CRM & sales, invoicing & collections, client management, project management, marketing & content, admin, financial operations.

HOW TO USE: Go to /automation → open ARIA → ask for a full opportunity scan or focus on a specific workflow. ARIA collects APEX's process analysis and ORACLE's ROI models, synthesizes into one ranked priority list. If someone says "we keep doing X manually every week" → that goes to Automation.

IT + Automation partnership: FORGE (IT) flags every recurring manual fix as an automation opportunity for ARIA. The two departments coordinate on implementation.

=== IT DEPARTMENT ===
Route: /it-department (admin only)
Three-agent production reliability team. NEXUS leads and reports directly to Anthony. Every NEXUS response ends with bold "NEXUS Recommendation" — Anthony's clear action item.

• NEXUS (IT Manager) — incident command. Coordinates CIPHER and FORGE. Manages the IT Incidents board. First stop for any unknown system issue. Team Analysis button triggers a full CIPHER + FORGE pipeline.
• CIPHER (Diagnostics Specialist) — root-cause analysis. Production log analysis, database health, auth/session failures, API route diagnosis, cron job health, environment variable auditing, security posture, third-party integration failures (Stripe, ElevenLabs, Anthropic, SMTP). Produces: Error Signature, Affected Surface, Root Cause, Evidence, Confidence level.
• FORGE (Reliability Engineer) — remediation and repair. Step-by-step fix sequences with exact commands, deployment health, database recovery, environment configuration, cron job recovery, performance remediation, dev→prod synchronization. Produces: Fix Steps, Estimated Time, Risk Level, Rollback Plan, Prevention Runbook.

Incident severity: 🔴 CRITICAL (system down / payment failure / auth broken) → 🟠 HIGH (major feature broken / email failing) → 🟡 MEDIUM (minor feature broken / slow degradation) → 🟢 LOW (cosmetic / non-urgent).

HOW TO USE: Go to /it-department → NEXUS → describe exactly what is broken (which page, exact error message, when it started, production vs dev). NEXUS classifies severity, routes to CIPHER for diagnosis and FORGE for the fix, returns unified incident report. If someone says "the app is broken" or "something is not working" → that goes to IT Department.

=== DIGITAL INVENTORS ===
Route: /inventors (admin only)
Four-agent innovation engine that identifies new product and market opportunities, validates them with data, engineers the concept, and defines the marketing strategy. EINSTEIN leads and reports directly to Anthony.

• EINSTEIN (Director of Digital Innovation) — team lead. Synthesizes NOVA + LYRA + VEGA into one Invention Brief for Anthony. Focuses on the intersection of AE's creative expertise, existing verticals, and emerging technology. Every brief ends with bold "EINSTEIN Recommendation."
• NOVA (Market Intelligence & New Ventures) — finds market gaps, new niches, and untapped opportunities. Tells you WHERE to invent. Specialty: psychographic/demographic targeting across AE's current client base.
• LYRA (Marketing Data & Brand Strategy) — validates WHO buys it and WHY they'll pay. Market sizing, competitive landscape, brand fit within AE portfolio.
• VEGA (Chief Product Engineer) — designs and engineers the concept. Tells you HOW to build it. Product spec, platform, core features, technical feasibility assessment.

Invention Brief format (output of Team Analysis):
🔭 THE OPPORTUNITY | 📊 MARKET PROOF (LYRA) | 🗺️ WHO BUYS IT (NOVA) | ⚙️ WHAT IT IS (VEGA) | 🏆 WHY AE WINS | 🚀 FIRST MOVE

HOW TO USE: Go to /inventors → EINSTEIN → describe the market gap or product idea → ask for Team Analysis. When an Invention Brief includes a social media launch component, EINSTEIN briefs VIBE at /social-dept automatically. If someone asks "what should we build next?" or "is there a market for X?" → that goes to Digital Inventors.

Always answer with the exact route to navigate to, specific button names, and step-by-step instructions.`;

const router: IRouter = Router();

const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";

// ── GET /api/anetta/triage-summary ───────────────────────────────────────────
// Returns triage activity from the last N hours for the inbox dashboard
router.get("/anetta/triage-summary", requireAdminAuth, async (req, res): Promise<void> => {
  const tid    = getTenantId(req);
  const hours  = Math.min(Number(req.query.hours ?? 24), 168);
  const since  = new Date(Date.now() - hours * 3_600_000);

  const rows = await db.select({
    id:             emailsTable.id,
    fromAddress:    emailsTable.fromAddress,
    fromName:       emailsTable.fromName,
    subject:        emailsTable.subject,
    triageCategory: emailsTable.triageCategory,
    triageUrgent:   emailsTable.triageUrgent,
    triageSummary:  emailsTable.triageSummary,
    triageAction:   emailsTable.triageAction,
    triageDraftId:  emailsTable.triageDraftId,
    triagedAt:      emailsTable.triagedAt,
    receivedAt:     emailsTable.receivedAt,
  })
    .from(emailsTable)
    .where(and(
      eq(emailsTable.tenantId, tid as any),
      eq(emailsTable.direction, "inbound"),
      gte(emailsTable.triagedAt, since),
    ))
    .orderBy(desc(emailsTable.triagedAt));

  const counts = {
    lead_inquiry: 0, client: 0, vendor_admin: 0, internal: 0, spam: 0, total: rows.length,
  };
  let draftsPending = 0;
  let autoFiled     = 0;
  let urgentCount   = 0;
  for (const r of rows) {
    const cat = r.triageCategory as keyof typeof counts | null;
    if (cat && cat in counts) (counts as any)[cat]++;
    if (r.triageDraftId) draftsPending++;
    if (r.triageAction === "auto_filed") autoFiled++;
    if (r.triageUrgent) urgentCount++;
  }

  // Last triage timestamp
  const lastTriagedAt = rows[0]?.triagedAt ?? null;

  res.json({ since, lastTriagedAt, counts, draftsPending, autoFiled, urgentCount, emails: rows });
});

// ── GET /api/anetta/drafts ─────────────────────────────────────────────────────
// List all email drafts (pending, sent, rejected)
router.get("/anetta/drafts", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const status = req.query.status as string | undefined;

  let rows;
  if (status && status !== "all") {
    rows = await db.select().from(emailDraftsTable)
      .where(and(eq(emailDraftsTable.tenantId, tid as any), eq(emailDraftsTable.status, status)))
      .orderBy(desc(emailDraftsTable.createdAt));
  } else {
    rows = await db.select().from(emailDraftsTable)
      .where(eq(emailDraftsTable.tenantId, tid as any))
      .orderBy(desc(emailDraftsTable.createdAt));
  }
  res.json(rows);
});

// ── GET /api/anetta/drafts/pending-count ──────────────────────────────────────
// Any employee can call this; non-admins simply see 0 (no approval queue for them)
router.get("/anetta/drafts/pending-count", async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const rows = await db.select().from(emailDraftsTable)
    .where(and(eq(emailDraftsTable.tenantId, tid as any), eq(emailDraftsTable.status, "pending_approval")));
  res.json({ count: rows.length });
});

// ── POST /api/anetta/drafts/:id/approve ──────────────────────────────────────
router.post("/anetta/drafts/:id/approve", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const s   = getSession(req);
  const id  = Number(req.params.id);

  const [draft] = await db.select().from(emailDraftsTable)
    .where(and(eq(emailDraftsTable.id, id), eq(emailDraftsTable.tenantId, tid as any)));

  if (!draft) { res.status(404).json({ error: "Draft not found" }); return; }
  if (draft.status !== "pending_approval" && draft.status !== "approved") {
    res.status(409).json({ error: `Draft is already ${draft.status}` }); return;
  }

  const ownerEmail = process.env.ANETTA_OWNER_EMAIL ?? "";
  const isOwnerAlias = (e: string) =>
    /^anthony/i.test(e.split("@")[0]) && e.toLowerCase().endsWith("@aexperiences.studio");
  const rewriteAddr = (e: string) => (ownerEmail && isOwnerAlias(e) ? ownerEmail : e);

  const toList = draft.toAddresses.split(",").map(e => rewriteAddr(e.trim())).filter(Boolean);
  const ccList = draft.ccAddresses ? draft.ccAddresses.split(",").map(e => rewriteAddr(e.trim())).filter(Boolean) : [];

  const _eid = parseInt(String(s?.employeeId ?? ""), 10);
  const approvedById = isNaN(_eid) ? null : _eid;

  if (!isAnettaEmailConfigured()) {
    await db.update(emailDraftsTable).set({
      status:         "sent",
      approvedById,
      approvedByName: s.employeeName ?? "Admin",
      approvedAt:     new Date(),
      sentAt:         null,
    }).where(eq(emailDraftsTable.id, id));
    res.json({ success: true, smtpMissing: true, sentTo: toList });
    return;
  }

  const result = await sendAnettaEmail({
    to:       toList,
    cc:       ccList.length > 0 ? ccList : undefined,
    subject:  draft.subject,
    bodyText: draft.bodyText,
    bodyHtml: draft.bodyHtml && draft.bodyHtml.trim().length > 0
      ? draft.bodyHtml
      : draft.bodyText.replace(/\n/g, "<br>"),
  });

  if (result.success) {
    await db.update(emailDraftsTable).set({
      status:         "sent",
      approvedById,
      approvedByName: s.employeeName ?? "Admin",
      approvedAt:     new Date(),
      sentAt:         new Date(),
    }).where(eq(emailDraftsTable.id, id));
    logger.info({ draftId: id, to: toList }, "Anetta email approved and sent");
    res.json({ success: true, sentTo: toList });
  } else {
    res.status(500).json({ error: result.error ?? "Failed to send" });
  }
});

// ── POST /api/anetta/drafts/:id/reject ───────────────────────────────────────
router.post("/anetta/drafts/:id/reject", requireAdminAuth, async (req, res): Promise<void> => {
  const tid    = getTenantId(req);
  const s      = getSession(req);
  const id     = Number(req.params.id);
  const reason = (req.body.reason as string | undefined) ?? "";

  const [draft] = await db.select().from(emailDraftsTable)
    .where(and(eq(emailDraftsTable.id, id), eq(emailDraftsTable.tenantId, tid as any)));

  if (!draft) { res.status(404).json({ error: "Draft not found" }); return; }

  const _reid = parseInt(String(s?.employeeId ?? ""), 10);
  await db.update(emailDraftsTable).set({
    status:         "rejected",
    approvedById:   isNaN(_reid) ? null : _reid,
    approvedByName: s.employeeName ?? "Admin",
    rejectedReason: reason,
    approvedAt:     new Date(),
  }).where(eq(emailDraftsTable.id, id));

  res.json({ success: true });
});

// ── POST /api/anetta/manual ───────────────────────────────────────────────────
// AI-powered system manual — answers any question about AEHub instantly
router.post("/anetta/manual", requireAdminAuth, async (req, res): Promise<void> => {
  const { question, model: requestedModel } = req.body as { question: string; model?: string };

  if (!question?.trim()) {
    res.status(400).json({ error: "question is required" });
    return;
  }

  try {
    const OPENROUTER_MODELS: Record<string, string> = {
      "deepseek/deepseek-chat": "deepseek/deepseek-chat",
      "deepseek/deepseek-r1":   "deepseek/deepseek-r1",
      "meta-llama/llama-3.3-70b-instruct": "meta-llama/llama-3.3-70b-instruct",
    };
    const model = (requestedModel && OPENROUTER_MODELS[requestedModel])
      ? requestedModel
      : "deepseek/deepseek-chat";

    const completion = await openrouter.chat.completions.create({
      model,
      messages: [
        { role: "system", content: AEHUB_SYSTEM_MANUAL },
        { role: "user", content: question.trim() },
      ],
      max_tokens: 1200,
    });

    const answer = completion.choices[0]?.message?.content ?? "I couldn't find an answer to that. Please try rephrasing your question.";
    res.json({ answer });
  } catch (err: any) {
    logger.error({ err }, "Anetta manual query failed");
    res.status(500).json({ error: err?.message ?? "Manual query failed" });
  }
});

// ── FILING SYSTEM ────────────────────────────────────────────────────────────

router.get("/anetta/filing-system", requireEmployeeAuth, async (_req, res): Promise<void> => {
  res.json({ system: AE_FILING_SYSTEM });
});

router.post("/anetta/file", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const {
    fromAgent, originalFilename, fileType, contentSummary,
    contextType, contextId, contextLabel,
  } = (req.body ?? {}) as {
    fromAgent?: string; originalFilename?: string; fileType?: string; contentSummary?: string;
    contextType?: string; contextId?: number; contextLabel?: string;
  };
  if (!fromAgent || !contentSummary) {
    res.status(400).json({ error: "fromAgent and contentSummary are required" });
    return;
  }
  const result = await requestFiling({
    tenantId: tid,
    fromAgent,
    originalFilename: originalFilename ?? null,
    fileType: fileType ?? null,
    contentSummary,
    contextType: contextType ?? null,
    contextId: contextId ?? null,
    contextLabel: contextLabel ?? null,
  });
  if (!result) { res.status(500).json({ error: "Anetta filing failed" }); return; }
  res.status(201).json({ id: result.id, ...result.decision });
});

router.get("/anetta/filing-requests", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const status = (req.query.status as string | undefined);
  const rows = status && status !== "all"
    ? await db.select().from(filingRequestsTable)
        .where(and(eq(filingRequestsTable.tenantId, tid as any), eq(filingRequestsTable.status, status)))
        .orderBy(desc(filingRequestsTable.createdAt))
    : await db.select().from(filingRequestsTable)
        .where(eq(filingRequestsTable.tenantId, tid as any))
        .orderBy(desc(filingRequestsTable.createdAt));
  res.json(rows);
});

router.get("/anetta/filing-requests/pending-count", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const rows = await db.select().from(filingRequestsTable)
    .where(and(eq(filingRequestsTable.tenantId, tid as any), eq(filingRequestsTable.status, "pending")));
  res.json({ count: rows.length });
});

// ── GET /api/anetta/files ─────────────────────────────────────────────────
// The Filing Cabinet — every approved or overridden filing, scoped by role.
router.get("/anetta/files", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const s = getSession(req);
  const scope = scopeForRole(s?.employeeRole);
  if (scope === "none") { res.json({ scope, files: [] }); return; }
  const rows = await db.select().from(filingRequestsTable)
    .where(and(eq(filingRequestsTable.tenantId, tid as any)))
    .orderBy(desc(filingRequestsTable.createdAt));
  const visible = rows
    .filter(r => r.status === "approved" || r.status === "overridden")
    .map(r => ({
      id: r.id,
      folder: r.adminFolder ?? r.suggestedFolder,
      filename: r.adminFilename ?? r.suggestedFilename,
      fileType: r.fileType,
      fromAgent: r.fromAgent,
      contextType: r.contextType,
      contextLabel: r.contextLabel,
      contextId: r.contextId,
      status: r.status,
      decidedAt: r.decidedAt,
      createdAt: r.createdAt,
    }))
    .filter(f => pathAllowed(f.folder, scope));
  res.json({ scope, files: visible });
});

router.patch("/anetta/filing-requests/:id", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const s = getSession(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const { status, adminFolder, adminFilename, adminNotes } = (req.body ?? {}) as {
    status?: string; adminFolder?: string; adminFilename?: string; adminNotes?: string;
  };
  if (!status || !["approved", "denied", "overridden"].includes(status)) {
    res.status(400).json({ error: "status must be approved, denied, or overridden" });
    return;
  }
  const _eid = parseInt(String(s?.employeeId ?? ""), 10);
  const [row] = await db.update(filingRequestsTable)
    .set({
      status,
      adminFolder: adminFolder ?? null,
      adminFilename: adminFilename ?? null,
      adminNotes: adminNotes ?? null,
      decidedById: isNaN(_eid) ? null : _eid,
      decidedByName: s.employeeName ?? "Admin",
      decidedAt: new Date(),
    })
    .where(and(eq(filingRequestsTable.id, id), eq(filingRequestsTable.tenantId, tid as any)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

export default router;
