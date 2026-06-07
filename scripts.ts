import { Router } from "express";
import { db } from "@workspace/db";
import { creativeScriptsTable } from "@workspace/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { requireEmployeeAuth } from "../middlewares/authMiddleware";

const router = Router();
const TENANT = "00000000-0000-0000-0000-000000000001";

router.get("/scripts", requireEmployeeAuth, async (req, res) => {
  try {
    const where = req.query["projectId"]
      ? and(eq(creativeScriptsTable.tenantId, TENANT), eq(creativeScriptsTable.projectId, Number(req.query["projectId"])))
      : eq(creativeScriptsTable.tenantId, TENANT);
    const rows = await db.select().from(creativeScriptsTable).where(where).orderBy(desc(creativeScriptsTable.updatedAt));
    res.json(rows);
  } catch (err) {
    req.log.error(err, "scripts list error");
    res.status(500).json({ error: "Failed to fetch scripts" });
  }
});

router.post("/scripts", requireEmployeeAuth, async (req, res) => {
  try {
    const { title, projectId, scriptType, targetLength, tone, content, notes } = req.body as Record<string, string>;
    if (!title?.trim()) { res.status(400).json({ error: "Title required" }); return; }
    const employeeId = (req.session as any)?.employeeId as string | undefined;
    const employeeName = (req.session as any)?.employeeName as string | undefined;
    const [row] = await db.insert(creativeScriptsTable).values({
      tenantId: TENANT,
      projectId: projectId ? Number(projectId) : null,
      title: title.trim(),
      scriptType: scriptType ?? "video",
      targetLength: targetLength ?? "2min",
      tone: tone ?? "professional",
      content: content ?? null,
      notes: notes ?? null,
      status: "draft",
      createdBy: employeeId ?? null,
      createdByName: employeeName ?? null,
    }).returning();
    res.json(row);
  } catch (err) {
    req.log.error(err, "scripts create error");
    res.status(500).json({ error: "Failed to create script" });
  }
});

router.get("/scripts/:id", requireEmployeeAuth, async (req, res) => {
  try {
    const [row] = await db.select().from(creativeScriptsTable)
      .where(and(eq(creativeScriptsTable.id, Number(req.params["id"])), eq(creativeScriptsTable.tenantId, TENANT)));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);
  } catch (err) {
    req.log.error(err, "scripts get error");
    res.status(500).json({ error: "Failed to fetch script" });
  }
});

router.put("/scripts/:id", requireEmployeeAuth, async (req, res) => {
  try {
    const { title, scriptType, targetLength, tone, content, notes, status } = req.body as Record<string, string>;
    const [row] = await db.update(creativeScriptsTable)
      .set({ title, scriptType, targetLength, tone, content, notes, status })
      .where(and(eq(creativeScriptsTable.id, Number(req.params["id"])), eq(creativeScriptsTable.tenantId, TENANT)))
      .returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);
  } catch (err) {
    req.log.error(err, "scripts update error");
    res.status(500).json({ error: "Failed to update script" });
  }
});

router.delete("/scripts/:id", requireEmployeeAuth, async (req, res) => {
  try {
    await db.delete(creativeScriptsTable)
      .where(and(eq(creativeScriptsTable.id, Number(req.params["id"])), eq(creativeScriptsTable.tenantId, TENANT)));
    res.json({ ok: true });
  } catch (err) {
    req.log.error(err, "scripts delete error");
    res.status(500).json({ error: "Failed to delete script" });
  }
});

export default router;
