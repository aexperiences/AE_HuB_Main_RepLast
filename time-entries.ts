import { requireEmployeeAuth, getTenantId } from "../middlewares/authMiddleware";
import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, timeEntriesTable } from "@workspace/db";
import {
  CreateTimeEntryBody,
  UpdateTimeEntryParams,
  UpdateTimeEntryBody,
  UpdateTimeEntryResponse,
  DeleteTimeEntryParams,
  ListTimeEntriesResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const toEntry = (e: typeof timeEntriesTable.$inferSelect) => ({
  ...e,
  hours: Number(e.hours),
  createdAt: e.createdAt.toISOString(),
});

router.get("/time-entries", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const entries = await db.select().from(timeEntriesTable).where(eq(timeEntriesTable.tenantId, tid)).orderBy(desc(timeEntriesTable.date));
  res.json(ListTimeEntriesResponse.parse(entries.map(toEntry)));
});

router.post("/time-entries", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const parsed = CreateTimeEntryBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [entry] = await db.insert(timeEntriesTable).values({
    tenantId: tid,
    projectId: parsed.data.projectId ?? null,
    projectName: parsed.data.projectName ?? null,
    teamMemberId: parsed.data.teamMemberId ?? null,
    teamMemberName: parsed.data.teamMemberName ?? null,
    date: parsed.data.date,
    hours: String(parsed.data.hours),
    description: parsed.data.description ?? null,
    billable: parsed.data.billable ?? true,
  }).returning();
  res.status(201).json(toEntry(entry));
});

router.patch("/time-entries/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = UpdateTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateTimeEntryBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const updateData: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.hours !== undefined) updateData.hours = String(parsed.data.hours);
  const [entry] = await db.update(timeEntriesTable).set(updateData).where(and(eq(timeEntriesTable.id, params.data.id), eq(timeEntriesTable.tenantId, tid))).returning();
  if (!entry) { res.status(404).json({ error: "Time entry not found" }); return; }
  res.json(UpdateTimeEntryResponse.parse(toEntry(entry)));
});

router.delete("/time-entries/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = DeleteTimeEntryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [entry] = await db.delete(timeEntriesTable).where(and(eq(timeEntriesTable.id, params.data.id), eq(timeEntriesTable.tenantId, tid))).returning();
  if (!entry) { res.status(404).json({ error: "Time entry not found" }); return; }
  res.sendStatus(204);
});

export default router;
