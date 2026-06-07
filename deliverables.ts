import { requireEmployeeAuth, getTenantId } from "../middlewares/authMiddleware";
import { Router, type IRouter } from "express";
import { eq, desc, and, inArray } from "drizzle-orm";
import { db, deliverablesTable } from "@workspace/db";
import { onDeliverableApproved } from "../lib/automation-triggers";
import {
  CreateDeliverableBody,
  UpdateDeliverableParams,
  UpdateDeliverableBody,
  UpdateDeliverableResponse,
  DeleteDeliverableParams,
  ListDeliverablesResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const toDeliverable = (d: typeof deliverablesTable.$inferSelect) => ({
  ...d,
  createdAt: d.createdAt.toISOString(),
});

router.get("/deliverables", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const projectId   = req.query.projectId   ? Number(req.query.projectId) : null;
  const clientEmail = req.query.clientEmail as string | undefined;
  const status      = req.query.status      as string | undefined;

  const conditions = [eq(deliverablesTable.tenantId, tid)];
  if (projectId)   conditions.push(eq(deliverablesTable.projectId,   projectId));
  if (clientEmail) conditions.push(eq(deliverablesTable.clientEmail, clientEmail));
  if (status) {
    const statuses = status.split(",").map(s => s.trim()) as any[];
    if (statuses.length === 1) conditions.push(eq(deliverablesTable.status, statuses[0]));
    else                       conditions.push(inArray(deliverablesTable.status, statuses));
  }

  const results = await db.select().from(deliverablesTable)
    .where(and(...conditions))
    .orderBy(desc(deliverablesTable.createdAt));

  res.json(ListDeliverablesResponse.parse(results.map(toDeliverable)));
});

router.post("/deliverables", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const parsed = CreateDeliverableBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [deliverable] = await db.insert(deliverablesTable).values({
    tenantId:        tid,
    projectId:       parsed.data.projectId,
    projectName:     parsed.data.projectName     ?? null,
    title:           parsed.data.title,
    description:     parsed.data.description     ?? null,
    fileUrl:         parsed.data.fileUrl         ?? null,
    clientEmail:     parsed.data.clientEmail     ?? null,
    submittedByName: (req.body.submittedByName)  ?? null,
    pmNotes:         (req.body.pmNotes)          ?? null,
    adminNotes:      (req.body.adminNotes)       ?? null,
    status: (parsed.data.status ?? "pending_review") as any,
  }).returning();
  res.status(201).json(toDeliverable(deliverable));
});

router.patch("/deliverables/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = UpdateDeliverableParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateDeliverableBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const update: Record<string, unknown> = {};
  if (parsed.data.title       !== undefined) update.title       = parsed.data.title;
  if (parsed.data.description !== undefined) update.description = parsed.data.description;
  if (parsed.data.fileUrl     !== undefined) update.fileUrl     = parsed.data.fileUrl;
  if (parsed.data.status      !== undefined) update.status      = parsed.data.status;
  if (parsed.data.clientNotes !== undefined) update.clientNotes = parsed.data.clientNotes;
  if (parsed.data.clientEmail !== undefined) update.clientEmail = parsed.data.clientEmail;
  if (req.body.pmNotes         !== undefined) update.pmNotes         = req.body.pmNotes    || null;
  if (req.body.adminNotes      !== undefined) update.adminNotes      = req.body.adminNotes || null;
  if (req.body.submittedByName !== undefined) update.submittedByName = req.body.submittedByName || null;
  // Read before update so we can detect status transitions
  const [before] = await db.select({ status: deliverablesTable.status })
    .from(deliverablesTable)
    .where(and(eq(deliverablesTable.id, params.data.id), eq(deliverablesTable.tenantId, tid)))
    .limit(1);

  const [deliverable] = await db.update(deliverablesTable).set(update)
    .where(and(eq(deliverablesTable.id, params.data.id), eq(deliverablesTable.tenantId, tid)))
    .returning();
  if (!deliverable) { res.status(404).json({ error: "Deliverable not found" }); return; }

  // Automation: deliverable just approved → notify team
  if (deliverable.status === "approved" && before?.status !== "approved") {
    onDeliverableApproved({
      id:          deliverable.id,
      title:       deliverable.title,
      projectName: deliverable.projectName,
      projectId:   deliverable.projectId,
      clientEmail: deliverable.clientEmail,
      clientNotes: deliverable.clientNotes,
    }, tid).catch(() => {});
  }

  res.json(UpdateDeliverableResponse.parse(toDeliverable(deliverable)));
});

router.delete("/deliverables/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = DeleteDeliverableParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [deliverable] = await db.delete(deliverablesTable)
    .where(and(eq(deliverablesTable.id, params.data.id), eq(deliverablesTable.tenantId, tid)))
    .returning();
  if (!deliverable) { res.status(404).json({ error: "Deliverable not found" }); return; }
  res.sendStatus(204);
});

export default router;
