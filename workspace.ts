import { Router } from "express";
import { db } from "@workspace/db";
import { creativeProjectsTable, creativeSavesTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireEmployeeAuth } from "../middlewares/authMiddleware";
import { z } from "zod/v4";

const router = Router();

const TENANT = "00000000-0000-0000-0000-000000000001";

function sess(req: any): { tenantId?: string; employeeId?: number | null; employeeName?: string | null } {
  return req.session ?? {};
}
function pid(req: any): string {
  const v = req.params.id;
  return Array.isArray(v) ? v[0] : v;
}

/* ── List projects ─────────────────────────────────────────────── */
router.get("/creative/workspace", requireEmployeeAuth, async (req, res): Promise<void> => {
  const empId = sess(req).employeeId ?? null;
  const rows = await db
    .select()
    .from(creativeProjectsTable)
    .where(
      empId !== null
        ? and(
            eq(creativeProjectsTable.tenantId, sess(req).tenantId ?? TENANT),
            eq(creativeProjectsTable.employeeId, empId),
          )
        : eq(creativeProjectsTable.tenantId, sess(req).tenantId ?? TENANT)
    )
    .orderBy(desc(creativeProjectsTable.updatedAt));
  res.json(rows);
});

/* ── Create project ────────────────────────────────────────────── */
const createProjectSchema = z.object({
  name:        z.string().min(1),
  description: z.string().optional(),
  color:       z.string().optional(),
});

router.post("/creative/workspace", requireEmployeeAuth, async (req, res): Promise<void> => {
  const parsed = createProjectSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }

  const [row] = await db.insert(creativeProjectsTable).values({
    tenantId:    sess(req).tenantId ?? TENANT,
    employeeId:  sess(req).employeeId ?? null,
    name:        parsed.data.name,
    description: parsed.data.description ?? null,
    color:       parsed.data.color ?? "#0ea5e9",
    createdBy:   sess(req).employeeName ?? null,
  }).returning();

  res.status(201).json(row);
});

/* ── Get single project ────────────────────────────────────────── */
router.get("/creative/workspace/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const id = parseInt(pid(req), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const empId = sess(req).employeeId ?? null;
  const [project] = await db
    .select()
    .from(creativeProjectsTable)
    .where(and(
      eq(creativeProjectsTable.id, id),
      eq(creativeProjectsTable.tenantId, sess(req).tenantId ?? TENANT),
      ...(empId !== null ? [eq(creativeProjectsTable.employeeId, empId)] : []),
    ));

  if (!project) { res.status(404).json({ error: "Not found" }); return; }
  res.json(project);
});

/* ── Update project ────────────────────────────────────────────── */
router.patch("/creative/workspace/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const id = parseInt(pid(req), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const empId = sess(req).employeeId ?? null;
  const { name, description, color } = req.body as Record<string, string>;
  const updates: Partial<typeof creativeProjectsTable.$inferInsert> = {};
  if (name        !== undefined) updates.name        = name;
  if (description !== undefined) updates.description = description;
  if (color       !== undefined) updates.color       = color;

  const [row] = await db
    .update(creativeProjectsTable)
    .set(updates)
    .where(and(
      eq(creativeProjectsTable.id, id),
      eq(creativeProjectsTable.tenantId, sess(req).tenantId ?? TENANT),
      ...(empId !== null ? [eq(creativeProjectsTable.employeeId, empId)] : []),
    ))
    .returning();

  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

/* ── Delete project ────────────────────────────────────────────── */
router.delete("/creative/workspace/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const id = parseInt(pid(req), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const empId = sess(req).employeeId ?? null;
  await db
    .delete(creativeProjectsTable)
    .where(and(
      eq(creativeProjectsTable.id, id),
      eq(creativeProjectsTable.tenantId, sess(req).tenantId ?? TENANT),
      ...(empId !== null ? [eq(creativeProjectsTable.employeeId, empId)] : []),
    ));

  res.json({ ok: true });
});

/* ── List saves for a project ──────────────────────────────────── */
router.get("/creative/workspace/:id/saves", requireEmployeeAuth, async (req, res): Promise<void> => {
  const projectId = parseInt(pid(req), 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const empId = sess(req).employeeId ?? null;
  const [project] = await db
    .select()
    .from(creativeProjectsTable)
    .where(and(
      eq(creativeProjectsTable.id, projectId),
      eq(creativeProjectsTable.tenantId, sess(req).tenantId ?? TENANT),
      ...(empId !== null ? [eq(creativeProjectsTable.employeeId, empId)] : []),
    ));
  if (!project) { res.status(404).json({ error: "Not found" }); return; }

  const saves = await db
    .select()
    .from(creativeSavesTable)
    .where(eq(creativeSavesTable.creativeProjectId, projectId))
    .orderBy(desc(creativeSavesTable.createdAt));

  res.json(saves);
});

/* ── Create save ───────────────────────────────────────────────── */
const createSaveSchema = z.object({
  toolType:    z.string().min(1),
  title:       z.string().min(1),
  contentText: z.string().optional(),
  contentUrl:  z.string().optional(),
  contentJson: z.string().optional(),
  fileName:    z.string().optional(),
});

router.post("/creative/workspace/:id/saves", requireEmployeeAuth, async (req, res): Promise<void> => {
  const projectId = parseInt(pid(req), 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [project] = await db
    .select()
    .from(creativeProjectsTable)
    .where(and(
      eq(creativeProjectsTable.id, projectId),
      eq(creativeProjectsTable.tenantId, sess(req).tenantId ?? TENANT),
    ));
  if (!project) { res.status(404).json({ error: "Not found" }); return; }

  const parsed = createSaveSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }

  const [row] = await db.insert(creativeSavesTable).values({
    creativeProjectId: projectId,
    toolType:          parsed.data.toolType,
    title:             parsed.data.title,
    contentText:       parsed.data.contentText ?? null,
    contentUrl:        parsed.data.contentUrl  ?? null,
    contentJson:       parsed.data.contentJson ?? null,
    fileName:          parsed.data.fileName    ?? null,
  }).returning();

  await db
    .update(creativeProjectsTable)
    .set({ updatedAt: new Date() })
    .where(eq(creativeProjectsTable.id, projectId));

  res.status(201).json(row);
});

/* ── Delete save ───────────────────────────────────────────────── */
router.delete("/creative/saves/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const id = parseInt(pid(req), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(creativeSavesTable).where(eq(creativeSavesTable.id, id));
  res.json({ ok: true });
});

export default router;
