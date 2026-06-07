import { Router, type IRouter, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db, crmLeadsTable } from "@workspace/db";
import { requireAdminAuth, getTenantId } from "../middlewares/authMiddleware";
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { nowBlock } from "../lib/agent-roster";
import { enqueueLeadOutreach } from "../lib/outreach";

const router: IRouter = Router();

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

function generateToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

function verticalLabel(vertical: string | null | undefined): string {
  const map: Record<string, string> = {
    architecture: "Architecture",
    law: "Law",
    construction: "Construction",
    consulting: "Consulting",
    financial: "Financial Services",
    investor: "Investment",
    partnership: "Strategic Partnership",
  };
  return map[vertical ?? ""] ?? "your industry";
}

interface DemoScriptRow {
  demoFlow: Array<{ step: number; title: string; description: string; duration: string }>;
  keyFeatures: string[];
  commonObjections: Array<{ trigger: string; category: string; response: string }>;
  closingScript: string;
}

function buildDemoSystemPrompt(
  lead: {
    contactName: string;
    company: string | null;
    campaignType: string | null;
    notes: string | null;
  },
  script: DemoScriptRow | null,
  crossVerticalObjections: CrossVerticalObjection[] = []
): string {
  const vertical = verticalLabel(lead.campaignType);
  const company = lead.company ?? "their firm";
  const painHints = lead.notes ? `\nProspect notes: ${lead.notes}` : "";

  const scriptSection = script
    ? `
DEMO FLOW (follow this sequence, adapt based on their questions):
${script.demoFlow.map(s => `  Step ${s.step} (${s.duration}) — ${s.title}: ${s.description}`).join("\n")}

KEY FEATURES TO HIGHLIGHT for ${vertical}:
${script.keyFeatures.map(f => `- ${f}`).join("\n")}

OBJECTION HANDLING — when you detect these triggers, use these responses:
${script.commonObjections.map(o => `• If they mention "${o.trigger.split("|")[0]}..." → ${o.response}`).join("\n")}

CLOSING SCRIPT (use when the time is right, after 4-6 exchanges):
${script.closingScript}
`
    : `
KEY FEATURES TO HIGHLIGHT:
- Projects & task management with client-facing milestone tracking
- Invoicing with Stripe payments (clients pay online)
- Contracts & proposals (e-sign ready)
- Client portal (clients see status, approve deliverables, pay invoices)
- CRM & lead pipeline
- AI team (Dolly for PM, Geoffrey for accounting, Sharon for creative)

CLOSING: When the time is right, invite them to start a free 30-day pilot for ${company} — no credit card, no commitment.
`;

  return `${nowBlock()}

You are Bobert, the AI assistant at Accelerated Experiences LLC (AEHub). You are conducting a LIVE PRODUCT DEMO for a prospect.

PROSPECT CONTEXT:
- Name: ${lead.contactName}
- Company: ${company}
- Industry: ${vertical}${painHints}

YOUR DEMO GOAL:
Guide ${lead.contactName} through a personalized demo of AEHub. Show them how it solves their specific pain points, handle objections, and invite them to start a free 30-day pilot.

DEMO STYLE:
- Warm, enthusiastic, confident — short responses (2-4 sentences)
- Ask discovery questions first, then connect features to their answers
- When they ask about a specific feature, jump to it immediately
- Address objections directly, then bridge back to value
- Use their name occasionally. Make it personal.
${scriptSection}${crossVerticalObjections.length > 0 ? `
UNIVERSAL OBJECTION PLAYBOOK (use these scripted responses when you detect an objection):
${crossVerticalObjections.map(o => `[${o.category.toUpperCase()}] When they say something like "${o.objection}" → respond: "${o.response}"`).join("\n")}

When you handle an objection: (1) validate their concern briefly, (2) deliver the scripted response naturally, (3) ask a follow-up to confirm it's resolved.
` : ""}`;
}

interface CrossVerticalObjection {
  objection: string;
  category: string;
  response: string;
}

async function fetchCrossVerticalObjections(vertical: string | null): Promise<CrossVerticalObjection[]> {
  try {
    const rows = await db.execute(sql`
      SELECT objection, category, response
      FROM objections
      WHERE ${vertical ? sql`(verticals = '{}' OR ${vertical} = ANY(verticals))` : sql`TRUE`}
      ORDER BY success_rate DESC
      LIMIT 10
    `);
    return ((rows as any).rows ?? []).map((r: any) => ({
      objection: r.objection,
      category: r.category,
      response: r.response,
    }));
  } catch {
    return [];
  }
}

async function fetchDemoScript(vertical: string | null): Promise<DemoScriptRow | null> {
  if (!vertical) return null;
  try {
    const rows = await db.execute(sql`
      SELECT demo_flow, key_features, common_objections, closing_script
      FROM demo_scripts
      WHERE vertical = ${vertical}
      LIMIT 1
    `);
    const row = (rows as any).rows?.[0];
    if (!row) return null;
    return {
      demoFlow: row.demo_flow ?? [],
      keyFeatures: row.key_features ?? [],
      commonObjections: row.common_objections ?? [],
      closingScript: row.closing_script ?? "",
    };
  } catch {
    return null;
  }
}

router.post(
  "/crm/leads/:id/generate-demo-link",
  requireAdminAuth,
  async (req: Request, res: Response) => {
    const leadId = Number(req.params.id);
    if (isNaN(leadId)) {
      res.status(400).json({ error: "Invalid lead ID" });
      return;
    }

    const tenantId = getTenantId(req) ?? TENANT_ID;

    const [lead] = await db
      .select({ id: crmLeadsTable.id, tenantId: crmLeadsTable.tenantId })
      .from(crmLeadsTable)
      .where(eq(crmLeadsTable.id, leadId))
      .limit(1);

    if (!lead || lead.tenantId !== tenantId) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    const vertical = (req.body?.vertical as string | undefined) ?? null;

    const token = generateToken();
    await db.execute(sql`
      UPDATE crm_leads
      SET demo_token = ${token},
          demo_token_created_at = NOW()
          ${vertical ? sql`, campaign_type = ${vertical}` : sql``}
      WHERE id = ${leadId}
    `);

    const domain = process.env.REPLIT_DOMAINS?.split(",")[0] ?? "localhost";
    const url = `https://${domain}/demo/${token}`;
    res.json({ url, token });
  }
);

router.get("/demo/:token", async (req: Request, res: Response) => {
  const { token } = req.params;

  const rows = await db.execute(sql`
    SELECT id, contact_name, company, campaign_type, notes,
           demo_started_at, demo_completed_at, demo_interests
    FROM crm_leads
    WHERE demo_token = ${token}
    LIMIT 1
  `);

  const row = (rows as any).rows?.[0];
  if (!row) {
    res.status(404).json({ error: "Demo link not found or expired" });
    return;
  }

  res.json({
    leadId: row.id,
    contactName: row.contact_name,
    company: row.company,
    vertical: row.campaign_type,
    verticalLabel: verticalLabel(row.campaign_type),
    notes: row.notes,
    demoStartedAt: row.demo_started_at,
    demoCompletedAt: row.demo_completed_at,
    demoInterests: row.demo_interests ?? [],
  });
});

router.post("/demo/:token/start", async (req: Request, res: Response) => {
  const { token } = req.params;

  // Check campaign_status before updating so we can detect sequence_complete re-engagements
  const check = await db.execute(sql`
    SELECT id, campaign_status FROM crm_leads WHERE demo_token = ${token} LIMIT 1
  `);
  const row = (check as any).rows?.[0];

  await db.execute(sql`
    UPDATE crm_leads
    SET demo_started_at = COALESCE(demo_started_at, NOW()),
        campaign_status = 'demo_started'
    WHERE demo_token = ${token}
  `);

  // If this lead completed the full outreach sequence without replying and just re-opened
  // the demo, automatically enqueue Prompt 6 (the re-engagement email)
  if (row?.id && row.campaign_status === "sequence_complete") {
    enqueueLeadOutreach(row.id, TENANT_ID, 0, 6).catch((err: any) =>
      req.log?.warn?.({ err, leadId: row.id }, "re-engagement enqueue failed")
    );
  }

  res.json({ ok: true });
});

router.post("/demo/:token/chat", async (req: Request, res: Response) => {
  const { token } = req.params;
  const { message, history } = req.body ?? {};

  if (!message || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const rows = await db.execute(sql`
    SELECT id, contact_name, company, campaign_type, notes
    FROM crm_leads
    WHERE demo_token = ${token}
    LIMIT 1
  `);

  const lead = (rows as any).rows?.[0];

  // Detect vertical from sandbox message prefix e.g. "[SANDBOX MODE — Architecture firm]"
  const sandboxVerticalMatch = message.match(/\[SANDBOX MODE[^\]]*?(\w+)\s+firm\]/i);
  const sandboxVertical = sandboxVerticalMatch
    ? Object.keys({ architecture: 1, law: 1, construction: 1, consulting: 1, financial: 1 })
        .find(v => message.toLowerCase().includes(v)) ?? null
    : null;

  const [script, crossObjections] = await Promise.all([
    fetchDemoScript(lead?.campaign_type ?? sandboxVertical),
    fetchCrossVerticalObjections(lead?.campaign_type ?? sandboxVertical),
  ]);

  const systemPrompt = buildDemoSystemPrompt({
    contactName: lead?.contact_name ?? "there",
    company: lead?.company ?? null,
    campaignType: lead?.campaign_type ?? sandboxVertical,
    notes: lead?.notes ?? null,
  }, script, crossObjections);

  const priorMessages: { role: "user" | "assistant"; content: string }[] = [];
  if (Array.isArray(history)) {
    for (const m of history) {
      if (
        m &&
        typeof m === "object" &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
      ) {
        priorMessages.push({ role: m.role, content: m.content });
      }
    }
  }

  try {
    const aiResp = await openrouter.chat.completions.create({
      model: "anthropic/claude-3.5-sonnet",
      messages: [
        { role: "system", content: systemPrompt },
        ...priorMessages,
        { role: "user", content: message.trim() },
      ],
      max_tokens: 400,
    });

    const reply = aiResp.choices[0]?.message?.content ?? "Let me think about that...";

    if (lead) {
      await db.execute(sql`
        UPDATE crm_leads
        SET demo_started_at = COALESCE(demo_started_at, NOW()),
            campaign_status = 'demo_started'
        WHERE demo_token = ${token}
      `);
    }

    res.json({ reply });
  } catch (err: any) {
    req.log?.error?.({ err }, "Demo chat failed");
    res.status(500).json({ error: "Bobert is unavailable right now. Please try again." });
  }
});

router.post("/demo/:token/log", async (req: Request, res: Response) => {
  const { token } = req.params;
  const { event, feature, completed } = req.body ?? {};

  if (completed) {
    await db.execute(sql`
      UPDATE crm_leads
      SET demo_completed_at = COALESCE(demo_completed_at, NOW()),
          campaign_status = 'demo_completed'
      WHERE demo_token = ${token}
    `);
  }

  if (feature && typeof feature === "string") {
    await db.execute(sql`
      UPDATE crm_leads
      SET demo_interests = COALESCE(demo_interests, '[]'::jsonb) || to_jsonb(${feature}::text)
      WHERE demo_token = ${token}
        AND NOT (COALESCE(demo_interests, '[]'::jsonb) @> to_jsonb(${feature}::text))
    `);
  }

  req.log?.info?.({ token, event, feature, completed }, "demo event logged");
  res.json({ ok: true });
});

router.get("/demo/scripts/:vertical", async (req: Request, res: Response) => {
  const vertical = req.params["vertical"] as string;
  const script = await fetchDemoScript(vertical);
  if (!script) {
    res.status(404).json({ error: "No script found for this vertical" });
    return;
  }
  res.json(script);
});

router.get("/demos/metrics", requireAdminAuth, async (req: Request, res: Response) => {
  const leads = await db.execute(sql`
    SELECT
      id,
      contact_name,
      company,
      campaign_type,
      email,
      demo_token,
      demo_started_at,
      demo_completed_at,
      demo_interests,
      campaign_status
    FROM crm_leads
    WHERE demo_token IS NOT NULL
    ORDER BY COALESCE(demo_started_at, demo_completed_at, created_at) DESC
    LIMIT 200
  `);

  const rows: any[] = (leads as any).rows ?? [];

  const totalDemos       = rows.filter(r => r.demo_started_at).length;
  const completedDemos   = rows.filter(r => r.demo_completed_at).length;
  const pilotActive      = rows.filter(r => r.campaign_status === "pilot_active").length;
  const completionRate   = totalDemos > 0 ? (completedDemos / totalDemos) * 100 : 0;
  const pilotConversionRate = totalDemos > 0 ? (pilotActive / totalDemos) * 100 : 0;

  const byVertical: Record<string, number> = {};
  const interestMap: Record<string, number> = {};
  for (const r of rows) {
    if (r.campaign_type && r.demo_started_at) {
      byVertical[r.campaign_type] = (byVertical[r.campaign_type] ?? 0) + 1;
    }
    if (Array.isArray(r.demo_interests)) {
      for (const f of r.demo_interests) {
        interestMap[f] = (interestMap[f] ?? 0) + 1;
      }
    }
  }

  const topInterests = Object.entries(interestMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([feature, count]) => ({ feature, count }));

  res.json({
    metrics: { totalDemos, completedDemos, completionRate, pilotActive, pilotConversionRate, byVertical, topInterests },
    leads: rows.map(r => ({
      id: r.id,
      contactName: r.contact_name,
      company: r.company,
      campaignType: r.campaign_type,
      email: r.email,
      demoToken: r.demo_token,
      demoStartedAt: r.demo_started_at,
      demoCompletedAt: r.demo_completed_at,
      demoInterests: r.demo_interests,
      campaignStatus: r.campaign_status,
    })),
  });
});

export default router;
