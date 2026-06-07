import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, projectMockupsTable, mockupCommentsTable, projectsTable } from "@workspace/db";
import { requireEmployeeAuth, getTenantId, getSession } from "../middlewares/authMiddleware";
import { z } from "zod/v4";

const router: IRouter = Router();

const CreateMockupBody = z.object({
  projectId:    z.coerce.number().int().positive(),
  title:        z.string().min(1).max(200),
  description:  z.string().optional(),
  canvasPreset: z.string().optional(),
});

const UpdateMockupBody = z.object({
  title:        z.string().min(1).max(200).optional(),
  description:  z.string().nullable().optional(),
  canvasJson:   z.string().nullable().optional(),
  canvasPreset: z.string().optional(),
  status:       z.enum(["draft", "review", "approved", "revisions"]).optional(),
});

const CreateCommentBody = z.object({
  content: z.string().min(1).max(4000),
});

function serializeMockup(m: typeof projectMockupsTable.$inferSelect) {
  return {
    ...m,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

function serializeComment(c: typeof mockupCommentsTable.$inferSelect) {
  return {
    ...c,
    createdAt: c.createdAt.toISOString(),
  };
}

// ── List mockups (all or filtered by projectId) ─────────────────────
router.get("/mockups", requireEmployeeAuth, async (req: Request, res: Response) => {
  const tid = getTenantId(req);
  const projectId = req.query.projectId ? Number(req.query.projectId) : undefined;
  const status = req.query.status as string | undefined;

  const conditions = [eq(projectMockupsTable.tenantId, tid)];
  if (projectId) conditions.push(eq(projectMockupsTable.projectId, projectId));
  if (status && ["draft","review","approved","revisions"].includes(status)) {
    conditions.push(eq(projectMockupsTable.status, status as "draft"|"review"|"approved"|"revisions"));
  }

  const mockups = await db
    .select({ mockup: projectMockupsTable, projectName: projectsTable.name })
    .from(projectMockupsTable)
    .leftJoin(projectsTable, eq(projectMockupsTable.projectId, projectsTable.id))
    .where(and(...conditions))
    .orderBy(desc(projectMockupsTable.updatedAt));

  res.json(mockups.map(({ mockup, projectName }) => ({
    ...serializeMockup(mockup),
    projectName: projectName ?? null,
  })));
});

// ── Create mockup ───────────────────────────────────────────────────
router.post("/mockups", requireEmployeeAuth, async (req: Request, res: Response) => {
  const tid = getTenantId(req);
  const sess = getSession(req);
  const body = CreateMockupBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  // Verify project belongs to tenant
  const [project] = await db.select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, body.data.projectId), eq(projectsTable.tenantId, tid)));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const [mockup] = await db.insert(projectMockupsTable).values({
    tenantId:       tid,
    projectId:      body.data.projectId,
    title:          body.data.title,
    description:    body.data.description ?? null,
    canvasPreset:   body.data.canvasPreset ?? "Presentation",
    status:         "draft",
    createdBy:      sess.employeeId ?? null,
    createdByName:  sess.employeeName ?? null,
  }).returning();

  res.status(201).json(serializeMockup(mockup));
});

// ── Get single mockup ───────────────────────────────────────────────
router.get("/mockups/:id", requireEmployeeAuth, async (req: Request, res: Response) => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  const [row] = await db
    .select({ mockup: projectMockupsTable, projectName: projectsTable.name })
    .from(projectMockupsTable)
    .leftJoin(projectsTable, eq(projectMockupsTable.projectId, projectsTable.id))
    .where(and(eq(projectMockupsTable.id, id), eq(projectMockupsTable.tenantId, tid)));

  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...serializeMockup(row.mockup), projectName: row.projectName ?? null });
});

// ── Update mockup ───────────────────────────────────────────────────
router.put("/mockups/:id", requireEmployeeAuth, async (req: Request, res: Response) => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  const body = UpdateMockupBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const updates: Partial<typeof projectMockupsTable.$inferInsert> = {};
  if (body.data.title       !== undefined) updates.title        = body.data.title;
  if (body.data.description !== undefined) updates.description  = body.data.description;
  if (body.data.canvasJson  !== undefined) updates.canvasJson   = body.data.canvasJson;
  if (body.data.canvasPreset !== undefined) updates.canvasPreset = body.data.canvasPreset;
  if (body.data.status      !== undefined) updates.status       = body.data.status;

  const [updated] = await db.update(projectMockupsTable)
    .set(updates)
    .where(and(eq(projectMockupsTable.id, id), eq(projectMockupsTable.tenantId, tid)))
    .returning();

  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(serializeMockup(updated));
});

// ── Delete mockup ───────────────────────────────────────────────────
router.delete("/mockups/:id", requireEmployeeAuth, async (req: Request, res: Response) => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  await db.delete(projectMockupsTable)
    .where(and(eq(projectMockupsTable.id, id), eq(projectMockupsTable.tenantId, tid)));
  res.status(204).end();
});

// ── List comments ───────────────────────────────────────────────────
router.get("/mockups/:id/comments", requireEmployeeAuth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const comments = await db.select().from(mockupCommentsTable)
    .where(eq(mockupCommentsTable.mockupId, id))
    .orderBy(mockupCommentsTable.createdAt);
  res.json(comments.map(serializeComment));
});

// ── Add comment ─────────────────────────────────────────────────────
router.post("/mockups/:id/comments", requireEmployeeAuth, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const sess = getSession(req);
  const body = CreateCommentBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const [comment] = await db.insert(mockupCommentsTable).values({
    mockupId:   id,
    authorId:   sess.employeeId ?? "unknown",
    authorName: sess.employeeName ?? "Team Member",
    authorRole: sess.employeeRole ?? null,
    content:    body.data.content,
  }).returning();

  res.status(201).json(serializeComment(comment));
});

// ── Delete comment ──────────────────────────────────────────────────
router.delete("/mockups/:id/comments/:commentId", requireEmployeeAuth, async (req: Request, res: Response) => {
  const sess = getSession(req);
  const commentId = Number(req.params.commentId);
  const [comment] = await db.select().from(mockupCommentsTable).where(eq(mockupCommentsTable.id, commentId));
  if (!comment) { res.status(404).json({ error: "Not found" }); return; }
  // Only author or admin can delete
  if (comment.authorId !== sess.employeeId && sess.employeeRole !== "admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  await db.delete(mockupCommentsTable).where(eq(mockupCommentsTable.id, commentId));
  res.status(204).end();
});

export default router;
