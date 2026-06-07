import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, dollyApprovalRequests, projectsTable, vendorsTable, expensesTable, employeeAccounts } from "@workspace/db";
import { requireAdminAuth, getTenantId, getSession } from "../middlewares/authMiddleware";
import { openai } from "@workspace/integrations-openai-ai-server";
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { resolveModel, extractJSON } from "../lib/ai-models";
import { nowBlock } from "../lib/agent-roster";

const router: IRouter = Router();

function requireAdminOrPm(req: any, res: any, next: any): void {
  const session = (req as any).session;
  if (!session?.employeeId || session.isPreview) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (session.employeeRole !== "admin" && session.employeeRole !== "project_manager") {
    res.status(403).json({ error: "Forbidden — Admin or PM access required" }); return;
  }
  next();
}

function serializeRequest(r: typeof dollyApprovalRequests.$inferSelect) {
  return {
    ...r,
    amount: r.amount != null ? Number(r.amount) : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    responseAt: r.responseAt ? r.responseAt.toISOString() : null,
  };
}

router.get("/dolly/approval-requests", requireAdminOrPm, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const statusFilter = req.query.status as string | undefined;
  let rows;
  if (statusFilter && statusFilter !== "all") {
    rows = await db.select().from(dollyApprovalRequests)
      .where(and(eq(dollyApprovalRequests.tenantId, tid), eq(dollyApprovalRequests.status, statusFilter)))
      .orderBy(desc(dollyApprovalRequests.createdAt));
  } else {
    rows = await db.select().from(dollyApprovalRequests)
      .where(eq(dollyApprovalRequests.tenantId, tid))
      .orderBy(desc(dollyApprovalRequests.createdAt));
  }
  res.json(rows.map(serializeRequest));
});

router.post("/dolly/approval-requests", requireAdminOrPm, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const { projectId, projectName, title, description, vendor, vendorId, amount, category } = req.body;
  if (!title?.trim()) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  const [row] = await db.insert(dollyApprovalRequests).values({
    tenantId: tid,
    projectId: projectId ? Number(projectId) : null,
    projectName: projectName ?? null,
    title: title.trim(),
    description: description ?? null,
    vendor: vendor ?? null,
    vendorId: vendorId ? Number(vendorId) : null,
    amount: amount != null ? String(amount) : null,
    category: category ?? null,
    status: "pending",
  }).returning();
  res.status(201).json(serializeRequest(row));
});

router.patch("/dolly/approval-requests/:id", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const { status, adminNotes } = req.body;
  if (!status || !["approved", "denied"].includes(status)) {
    res.status(400).json({ error: "status must be 'approved' or 'denied'" });
    return;
  }
  const [row] = await db.update(dollyApprovalRequests)
    .set({ status, adminNotes: adminNotes ?? null, responseAt: new Date(), updatedAt: new Date() })
    .where(and(eq(dollyApprovalRequests.id, id), eq(dollyApprovalRequests.tenantId, tid)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  if (status === "approved" && row.projectId && row.amount) {
    const session = getSession(req);
    const validCategories = ["equipment", "software", "talent", "location", "travel", "food", "supplies", "marketing", "other"] as const;
    type ExpenseCategory = typeof validCategories[number];
    const rawCat = (row.category ?? "other").toLowerCase();
    const category: ExpenseCategory = (validCategories as readonly string[]).includes(rawCat)
      ? rawCat as ExpenseCategory
      : "other";
    await db.insert(expensesTable).values({
      tenantId: tid as string,
      projectId: row.projectId,
      title: row.title,
      amount: row.amount,
      category,
      date: new Date().toISOString().split("T")[0],
      vendor: row.vendor ?? null,
      notes: `Dolly purchase — approved by ${session.employeeName ?? "admin"}${row.description ? `. ${row.description}` : ""}`,
      isBillable: true,
    }).catch(() => {});
  }

  res.json(serializeRequest(row));
});

router.post("/dolly/analyze", requireAdminOrPm, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const { projectId, model: requestedModel } = req.body;
  if (!projectId) { res.status(400).json({ error: "projectId is required" }); return; }

  const [project] = await db.select().from(projectsTable)
    .where(and(eq(projectsTable.id, Number(projectId)), eq(projectsTable.tenantId, tid)));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const vendors = await db.select().from(vendorsTable)
    .where(and(eq(vendorsTable.tenantId, tid), eq(vendorsTable.status, "active")));

  const existingExpenses = await db.select().from(expensesTable)
    .where(and(eq(expensesTable.projectId, Number(projectId)), eq(expensesTable.tenantId, tid)));

  const totalSpent = existingExpenses.reduce((s, e) => s + Number(e.amount), 0);
  const remainingBudget = project.budget ? Number(project.budget) - totalSpent : null;

  const systemPrompt = `${nowBlock()}

You are Dolly, senior AI Project Manager at Accelerated Experiences LLC — a full-service creative production company producing video, photography, branding, YouTube channels, social media, and digital experiences. You have managed hundreds of creative productions and know exactly how to scope, budget, staff, and deliver projects on time and under budget.

You report directly to Anetta (Admin & Operations Director). Every project assignment reaches you through her. You keep her informed on all milestones, risks, and blockers — she decides what escalates to Anthony. Together, you and Anetta are the operational backbone of AE.

YOUR EXPERTISE:
- Production planning for video shoots, photography days, animation projects, digital campaigns
- Budget optimization: finding the most cost-effective path without compromising output quality
- Risk identification: catching scope creep, timeline gaps, under-budgeted line items before they become problems
- Vendor strategy: matching the right vendor to each need, negotiating value, flagging markup implications
- Role allocation: knowing which tasks need a creative director, which need a coordinator, which can be handled internally
- Timeline building: sequencing tasks with realistic dependencies and buffer time

HOW YOU THINK:
- You read the full project brief before making any decisions
- You flag risks proactively and specifically (not vague warnings — real risks with dollar or day implications)
- You always recommend the most cost-effective vendor for each need, with a clear reason
- You build budgets with real line items, not round numbers
- You know what requires admin approval before you commit anything

CRITICAL RULE: You NEVER purchase, commit, or act on behalf of the company. Every purchase request must go through admin approval first. You recommend and queue up requests — admins decide.

Respond in structured JSON matching this exact shape:
{
  "summary": "2-3 sentence project overview: scope, approach, and primary success factors",
  "tasks": [{ "title": string, "role": string, "priority": "high"|"medium"|"low", "notes": string }],
  "vendorRecommendations": [{ "need": string, "vendorName": string, "vendorId": number|null, "estimatedCost": number, "reason": string }],
  "budgetBreakdown": [{ "category": string, "amount": number, "notes": string }],
  "approvalRequests": [{ "title": string, "vendor": string, "vendorId": number|null, "amount": number, "category": string, "description": string }],
  "flags": [string]
}`;

  const vendorContext = vendors.length > 0
    ? vendors.map(v => `• ${v.name} (ID:${v.id}) — ${v.category}${v.defaultMarkupPct ? `, markup: ${v.defaultMarkupPct}%` : ""}${v.notes ? `, notes: ${v.notes}` : ""}`).join("\n")
    : "No vendors currently in the system.";

  const userMessage = `PROJECT DETAILS:
Name: ${project.name}
Type: ${project.jobType ?? project.projectType} | Service: ${project.serviceType ?? "general"}
Client: ${project.client ?? "Internal"}
Budget: ${project.budget ? `$${Number(project.budget).toLocaleString()}` : "Not set"}
Budget Spent: $${totalSpent.toLocaleString()}${remainingBudget !== null ? ` (remaining: $${remainingBudget.toLocaleString()})` : ""}
Start: ${project.startDate ?? "TBD"} | End: ${project.endDate ?? "TBD"}
PM Notes from Admin: ${project.pmNotes ?? "None"}
Description/Brief: ${project.description ?? "No brief provided"}

AVAILABLE VENDORS:
${vendorContext}

EXISTING EXPENSES (${existingExpenses.length}):
${existingExpenses.length > 0 ? existingExpenses.map(e => `• ${e.title}: $${Number(e.amount).toLocaleString()} (${e.category})`).join("\n") : "None yet"}

Please analyze this project and produce a complete production plan.`;

  const completion = await openrouter.chat.completions.create({
    model: resolveModel("dolly", requestedModel as string),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    max_tokens: 8192,
  });

  const raw = extractJSON(completion.choices[0]?.message?.content ?? "{}");
  let plan: Record<string, unknown>;
  try {
    plan = JSON.parse(raw);
  } catch {
    plan = { summary: raw, tasks: [], vendorRecommendations: [], budgetBreakdown: [], approvalRequests: [], flags: [] };
  }

  res.json({ project: { id: project.id, name: project.name, budget: project.budget ? Number(project.budget) : null, totalSpent, remainingBudget }, plan });
});

router.post("/dolly/submit-requests", requireAdminOrPm, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const { projectId, projectName, requests } = req.body;
  if (!Array.isArray(requests) || requests.length === 0) {
    res.status(400).json({ error: "requests array is required" });
    return;
  }
  const inserted = await Promise.all(
    requests.map((r: any) =>
      db.insert(dollyApprovalRequests).values({
        tenantId: tid,
        projectId: projectId ? Number(projectId) : null,
        projectName: projectName ?? null,
        title: r.title,
        description: r.description ?? null,
        vendor: r.vendor ?? null,
        vendorId: r.vendorId ? Number(r.vendorId) : null,
        amount: r.amount != null ? String(r.amount) : null,
        category: r.category ?? null,
        status: "pending",
      }).returning().then(rows => rows[0])
    )
  );
  res.status(201).json(inserted.map(serializeRequest));
});

export default router;
