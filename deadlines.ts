import { requireEmployeeAuth, getTenantId } from "../middlewares/authMiddleware";
import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, deadlinesTable } from "@workspace/db";
import {
  CreateDeadlineBody,
  UpdateDeadlineParams,
  UpdateDeadlineBody,
  UpdateDeadlineResponse,
  DeleteDeadlineParams,
  ListDeadlinesResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function formatDeadline(d: typeof deadlinesTable.$inferSelect) {
  return {
    ...d,
    createdAt: d.createdAt.toISOString(),
  };
}

router.get("/deadlines", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const deadlines = await db.select().from(deadlinesTable).where(eq(deadlinesTable.tenantId, tid)).orderBy(desc(deadlinesTable.createdAt));
  res.json(ListDeadlinesResponse.parse(deadlines.map(formatDeadline)));
});

router.post("/deadlines", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const parsed = CreateDeadlineBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [deadline] = await db.insert(deadlinesTable).values({
    tenantId: tid,
    title: parsed.data.title,
    description: parsed.data.description ?? null,
    projectId: parsed.data.projectId ?? null,
    projectName: null,
    dueDate: parsed.data.dueDate,
    priority: parsed.data.priority as "low" | "medium" | "high" | "urgent",
    completed: parsed.data.completed ?? false,
  }).returning();
  res.status(201).json(formatDeadline(deadline));
});

router.patch("/deadlines/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = UpdateDeadlineParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateDeadlineBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updateData: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) updateData.title = parsed.data.title;
  if (parsed.data.description !== undefined) updateData.description = parsed.data.description;
  if (parsed.data.dueDate !== undefined) updateData.dueDate = parsed.data.dueDate;
  if (parsed.data.priority !== undefined) updateData.priority = parsed.data.priority;
  if (parsed.data.completed !== undefined) updateData.completed = parsed.data.completed;

  const [deadline] = await db.update(deadlinesTable).set(updateData).where(and(eq(deadlinesTable.id, params.data.id), eq(deadlinesTable.tenantId, tid))).returning();
  if (!deadline) {
    res.status(404).json({ error: "Deadline not found" });
    return;
  }
  res.json(UpdateDeadlineResponse.parse(formatDeadline(deadline)));
});

router.delete("/deadlines/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = DeleteDeadlineParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deadline] = await db.delete(deadlinesTable).where(and(eq(deadlinesTable.id, params.data.id), eq(deadlinesTable.tenantId, tid))).returning();
  if (!deadline) {
    res.status(404).json({ error: "Deadline not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
