import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, projectTasksTable } from "@workspace/db";
import { requireEmployeeAuth, getTenantId } from "../middlewares/authMiddleware";
import {
  CreateProjectTaskBody,
  UpdateProjectTaskParams,
  UpdateProjectTaskBody,
  UpdateProjectTaskResponse,
  DeleteProjectTaskParams,
  ListProjectTasksResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const toTask = (t: typeof projectTasksTable.$inferSelect) => ({
  ...t,
  createdAt: t.createdAt.toISOString(),
});

router.get("/project-tasks", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const projectId = req.query.projectId ? Number(req.query.projectId) : null;
  const tasks = projectId
    ? await db.select().from(projectTasksTable).where(and(eq(projectTasksTable.tenantId, tid), eq(projectTasksTable.projectId, projectId))).orderBy(desc(projectTasksTable.createdAt))
    : await db.select().from(projectTasksTable).where(eq(projectTasksTable.tenantId, tid)).orderBy(desc(projectTasksTable.createdAt));
  res.json(ListProjectTasksResponse.parse(tasks.map(toTask)));
});

router.post("/project-tasks", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const parsed = CreateProjectTaskBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [task] = await db.insert(projectTasksTable).values({
    tenantId: tid,
    projectId: parsed.data.projectId,
    title: parsed.data.title,
    description: parsed.data.description ?? null,
    assigneeId: parsed.data.assigneeId ?? null,
    assigneeName: parsed.data.assigneeName ?? null,
    status: (parsed.data.status ?? "todo") as "todo" | "in_progress" | "review" | "done",
    priority: (parsed.data.priority ?? "medium") as "low" | "medium" | "high" | "urgent",
    dueDate: parsed.data.dueDate ?? null,
  }).returning();
  res.status(201).json(toTask(task));
});

router.patch("/project-tasks/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = UpdateProjectTaskParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateProjectTaskBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [task] = await db.update(projectTasksTable).set(parsed.data).where(and(eq(projectTasksTable.id, params.data.id), eq(projectTasksTable.tenantId, tid))).returning();
  if (!task) { res.status(404).json({ error: "Task not found" }); return; }
  res.json(UpdateProjectTaskResponse.parse(toTask(task)));
});

router.delete("/project-tasks/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = DeleteProjectTaskParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [task] = await db.delete(projectTasksTable).where(and(eq(projectTasksTable.id, params.data.id), eq(projectTasksTable.tenantId, tid))).returning();
  if (!task) { res.status(404).json({ error: "Task not found" }); return; }
  res.sendStatus(204);
});

export default router;
