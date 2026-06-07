import { Router, type IRouter } from "express";
import { eq, desc, or, and } from "drizzle-orm";
import { db, crmLeadsTable, crmActivitiesTable } from "@workspace/db";
import { requireEmployeeAuth, getTenantId } from "../middlewares/authMiddleware";
import { syncContact, pushToContact, splitName } from "../lib/syncContact";
import { onCrmLeadWon } from "../lib/automation-triggers";

const router: IRouter = Router();

const getSession = (req: any) => ({
  employeeId: req.session?.employeeId as string | undefined,
  employeeName: (req.session as any)?.employeeName as string | undefined,
  role: req.session?.employeeRole as string | undefined,
});

const isCrmRole = (role: string | undefined) =>
  ["admin", "account_representative"].includes(role ?? "");

const serializeLead = (l: typeof crmLeadsTable.$inferSelect) => ({
  ...l,
  value: l.value ? String(l.value) : null,
  handoffAt: l.handoffAt ? l.handoffAt.toISOString() : null,
  lastContactedAt: l.lastContactedAt ? l.lastContactedAt.toISOString() : null,
  nextFollowUpAt: l.nextFollowUpAt ? l.nextFollowUpAt.toISOString() : null,
  createdAt: l.createdAt.toISOString(),
  updatedAt: l.updatedAt.toISOString(),
});

const serializeActivity = (a: typeof crmActivitiesTable.$inferSelect) => ({
  ...a,
  createdAt: a.createdAt.toISOString(),
});

// ── Access helpers ────────────────────────────────────────────────

function canAccessLead(
  lead: typeof crmLeadsTable.$inferSelect,
  role: string | undefined,
  employeeId: string | undefined,
): boolean {
  if (role === "admin") return true;
  if (role === "project_manager" || role === "employee") return lead.stage === "won";
  if (role === "account_representative") {
    return lead.assignedTo === employeeId || lead.createdBy === employeeId;
  }
  return false;
}

// ── Leads ────────────────────────────────────────────────────────

router.get("/crm/leads", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const { role, employeeId } = getSession(req);
  const isAdmin = role === "admin";
  const isPM = role === "project_manager" || role === "employee";

  const campaignType = req.query.campaignType as string | undefined;

  let leads = isAdmin
    ? await db.select().from(crmLeadsTable).where(eq(crmLeadsTable.tenantId, tid)).orderBy(desc(crmLeadsTable.createdAt))
    : isPM
    ? await db.select().from(crmLeadsTable)
        .where(and(eq(crmLeadsTable.tenantId, tid), eq(crmLeadsTable.stage, "won")))
        .orderBy(desc(crmLeadsTable.handoffAt))
    : await db.select().from(crmLeadsTable)
        .where(and(eq(crmLeadsTable.tenantId, tid), eq(crmLeadsTable.assignedTo, employeeId!)))
        .orderBy(desc(crmLeadsTable.createdAt));

  if (campaignType) {
    leads = leads.filter(l => l.campaignType === campaignType);
  }

  res.json(leads.map(serializeLead));
});

router.post("/crm/leads", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const { role, employeeId } = getSession(req);
  if (!isCrmRole(role) && role !== "project_manager" && role !== "employee") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const { contactName, company, email, phone, city, source, stage, value, notes, assignedTo, campaignType, campaignStatus } = req.body;
  if (!contactName) { res.status(400).json({ error: "contactName is required" }); return; }

  const [lead] = await db.insert(crmLeadsTable).values({
    tenantId: tid,
    contactName,
    company: company ?? null,
    email: email ?? null,
    phone: phone ?? null,
    city: city ?? null,
    source: source ?? null,
    stage: (stage ?? "new") as "new" | "qualified" | "proposal_sent" | "won" | "lost",
    value: value ? String(value) : null,
    notes: notes ?? null,
    assignedTo: assignedTo ?? employeeId ?? null,
    createdBy: employeeId ?? null,
    campaignType: campaignType ?? null,
    campaignStatus: campaignStatus ?? "not_contacted",
  }).returning();

  await db.insert(crmActivitiesTable).values({
    leadId: lead.id,
    type: "note",
    note: "Lead created",
    authorId: employeeId ?? null,
    authorName: (req.session as any)?.employeeName ?? null,
  });

  // Auto-sync to contacts and store the link
  const { firstName, lastName } = splitName(contactName);
  const contactId = await syncContact({
    tenantId: tid,
    firstName,
    lastName,
    company:  company ?? "",
    email:    email ?? "",
    phone:    phone ?? "",
    city:     city ?? "",
    role:     "prospect",
    category: source ? `CRM / ${source}` : "CRM Lead",
    notes:    notes ?? "",
  });
  await db.update(crmLeadsTable).set({ contactId }).where(eq(crmLeadsTable.id, lead.id));

  res.status(201).json(serializeLead({ ...lead, contactId }));
});

router.get("/crm/leads/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { role, employeeId } = getSession(req);
  const [lead] = await db.select().from(crmLeadsTable).where(and(eq(crmLeadsTable.id, id), eq(crmLeadsTable.tenantId, tid)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  if (!canAccessLead(lead, role, employeeId)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const activities = await db.select().from(crmActivitiesTable)
    .where(eq(crmActivitiesTable.leadId, id))
    .orderBy(desc(crmActivitiesTable.createdAt));

  res.json({ ...serializeLead(lead), activities: activities.map(serializeActivity) });
});

router.patch("/crm/leads/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { role, employeeId } = getSession(req);
  const [existing] = await db.select().from(crmLeadsTable).where(and(eq(crmLeadsTable.id, id), eq(crmLeadsTable.tenantId, tid)));
  if (!existing) { res.status(404).json({ error: "Lead not found" }); return; }

  if (role !== "admin" && existing.assignedTo !== employeeId) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const VALID_STAGES = ["new", "qualified", "proposal_sent", "won", "lost"] as const;
  if (req.body.stage !== undefined && !VALID_STAGES.includes(req.body.stage)) {
    res.status(400).json({ error: `Invalid stage. Must be one of: ${VALID_STAGES.join(", ")}` });
    return;
  }

  const VALID_CAMPAIGN_STATUSES = ["not_contacted", "contacted", "replied", "meeting_booked", "proposal_sent", "won", "lost"];
  if (req.body.campaignStatus !== undefined && !VALID_CAMPAIGN_STATUSES.includes(req.body.campaignStatus)) {
    res.status(400).json({ error: `Invalid campaignStatus` });
    return;
  }

  const allowed = [
    "contactName","company","email","phone","city","source","stage","value","notes",
    "assignedTo","assignedPm","proposalId","projectId",
    "campaignType","campaignStatus","lastContactedAt","nextFollowUpAt",
  ];
  const patch: Record<string, any> = {};
  for (const key of allowed) {
    if (key in req.body) patch[key] = req.body[key];
  }
  if (patch.value !== undefined) patch.value = patch.value ? String(patch.value) : null;
  if (patch.lastContactedAt !== undefined) patch.lastContactedAt = patch.lastContactedAt ? new Date(patch.lastContactedAt) : null;
  if (patch.nextFollowUpAt !== undefined) patch.nextFollowUpAt = patch.nextFollowUpAt ? new Date(patch.nextFollowUpAt) : null;

  const [updated] = await db.update(crmLeadsTable).set(patch).where(and(eq(crmLeadsTable.id, id), eq(crmLeadsTable.tenantId, tid))).returning();

  if (updated.contactId) {
    const { firstName, lastName } = splitName(updated.contactName);
    await pushToContact(updated.contactId, {
      firstName,
      lastName,
      company: updated.company ?? "",
      email:   updated.email   ?? "",
      phone:   updated.phone   ?? "",
      city:    updated.city    ?? "",
      notes:   updated.notes   ?? "",
    });
  }

  // Automation: lead just moved to "won" → auto-create project
  if (patch.stage === "won" && existing.stage !== "won") {
    onCrmLeadWon({
      id:          updated.id,
      contactName: updated.contactName,
      company:     updated.company,
      email:       updated.email,
      value:       updated.value,
    }, tid).catch(() => {});
  }

  res.json(serializeLead(updated));
});

router.delete("/crm/leads/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { role, employeeId } = getSession(req);
  const [existing] = await db.select().from(crmLeadsTable).where(and(eq(crmLeadsTable.id, id), eq(crmLeadsTable.tenantId, tid)));
  if (!existing) { res.status(404).json({ error: "Lead not found" }); return; }
  if (role !== "admin" && existing.assignedTo !== employeeId) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  await db.delete(crmLeadsTable).where(and(eq(crmLeadsTable.id, id), eq(crmLeadsTable.tenantId, tid)));
  res.sendStatus(204);
});

// ── Activities ────────────────────────────────────────────────────

router.get("/crm/leads/:id/activities", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { role, employeeId } = getSession(req);
  const [lead] = await db.select().from(crmLeadsTable).where(and(eq(crmLeadsTable.id, id), eq(crmLeadsTable.tenantId, tid)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  if (!canAccessLead(lead, role, employeeId)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const activities = await db.select().from(crmActivitiesTable)
    .where(eq(crmActivitiesTable.leadId, id))
    .orderBy(desc(crmActivitiesTable.createdAt));

  res.json(activities.map(serializeActivity));
});

router.post("/crm/leads/:id/activities", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { role, employeeId, employeeName } = getSession(req);
  const [lead] = await db.select().from(crmLeadsTable).where(and(eq(crmLeadsTable.id, id), eq(crmLeadsTable.tenantId, tid)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  if (!canAccessLead(lead, role, employeeId)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const { type, note } = req.body;
  if (!note) { res.status(400).json({ error: "note is required" }); return; }

  const validTypes = ["note","call","email","meeting","follow_up","proposal_sent","proposal_accepted","handoff"];
  const activityType = validTypes.includes(type) ? type : "note";

  const [activity] = await db.insert(crmActivitiesTable).values({
    leadId: id,
    type: activityType as any,
    note,
    authorId: employeeId ?? null,
    authorName: employeeName ?? null,
  }).returning();

  res.status(201).json(serializeActivity(activity));
});

// ── Handoff ──────────────────────────────────────────────────────

router.post("/crm/leads/:id/handoff", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { role, employeeId, employeeName } = getSession(req);
  if (!["admin", "account_representative", "project_manager"].includes(role ?? "")) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const [lead] = await db.select().from(crmLeadsTable).where(and(eq(crmLeadsTable.id, id), eq(crmLeadsTable.tenantId, tid)));
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }

  const { assignedPm, proposalId, projectId } = req.body;
  const patch: Record<string, any> = { stage: "won", handoffAt: new Date() };
  if (assignedPm) patch.assignedPm = assignedPm;
  if (proposalId) patch.proposalId = proposalId;
  if (projectId) patch.projectId = projectId;

  const [updated] = await db.update(crmLeadsTable).set(patch).where(and(eq(crmLeadsTable.id, id), eq(crmLeadsTable.tenantId, tid))).returning();

  await db.insert(crmActivitiesTable).values({
    leadId: id,
    type: "handoff",
    note: `Proposal accepted — handed off to PM${assignedPm ? ` (${assignedPm})` : ""}`,
    authorId: employeeId ?? null,
    authorName: employeeName ?? null,
  });

  res.json(serializeLead(updated));
});

// ── Pipeline summary ──────────────────────────────────────────────

router.get("/crm/pipeline", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const { role, employeeId } = getSession(req);
  const isAdmin = role === "admin";
  const isPM = role === "project_manager" || role === "employee";

  const leads = isAdmin
    ? await db.select().from(crmLeadsTable).where(eq(crmLeadsTable.tenantId, tid)).orderBy(desc(crmLeadsTable.createdAt))
    : isPM
    ? await db.select().from(crmLeadsTable)
        .where(and(eq(crmLeadsTable.tenantId, tid), eq(crmLeadsTable.stage, "won")))
        .orderBy(desc(crmLeadsTable.handoffAt))
    : await db.select().from(crmLeadsTable)
        .where(and(eq(crmLeadsTable.tenantId, tid), or(
          eq(crmLeadsTable.assignedTo, employeeId!),
          eq(crmLeadsTable.createdBy, employeeId!),
        )))
        .orderBy(desc(crmLeadsTable.createdAt));

  const stages = ["new", "qualified", "proposal_sent", "won", "lost"] as const;
  const pipeline = stages.map(stage => ({
    stage,
    count: leads.filter(l => l.stage === stage).length,
    value: leads
      .filter(l => l.stage === stage && l.value)
      .reduce((sum, l) => sum + parseFloat(l.value ?? "0"), 0),
    leads: leads.filter(l => l.stage === stage).map(serializeLead),
  }));

  res.json(pipeline);
});

export default router;
