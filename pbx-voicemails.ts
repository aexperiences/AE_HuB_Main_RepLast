import { Router } from "express";
import { z } from "zod/v4";
import { eq, and, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { voicemails } from "@workspace/db/schema";
import { requireEmployeeAuth } from "../middlewares/authMiddleware.js";

const router = Router();

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

// GET /api/pbx/voicemails
router.get("/voicemails", requireEmployeeAuth, async (req, res) => {
  try {
    const unreadOnly = req.query["unread"] === "true";
    const limit = Math.min(parseInt(String(req.query["limit"] ?? "50"), 10), 200);

    const conditions = [eq(voicemails.tenantId, TENANT_ID)];
    if (unreadOnly) conditions.push(eq(voicemails.isRead, false));

    const rows = await db
      .select()
      .from(voicemails)
      .where(and(...conditions))
      .orderBy(desc(voicemails.createdAt))
      .limit(limit);

    return res.json(rows);
  } catch (err) {
    req.log.error(err, "pbx.voicemails.list failed");
    return res.status(500).json({ error: "Failed to fetch voicemails" });
  }
});

// GET /api/pbx/voicemails/:id
router.get("/voicemails/:id", requireEmployeeAuth, async (req, res) => {
  const id = parseInt(String(req.params["id"]), 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const [vm] = await db
      .select()
      .from(voicemails)
      .where(and(eq(voicemails.id, id), eq(voicemails.tenantId, TENANT_ID)));

    if (!vm) return res.status(404).json({ error: "Voicemail not found" });

    if (!vm.isRead) {
      await db.update(voicemails).set({ isRead: true }).where(eq(voicemails.id, id));
    }

    return res.json({ ...vm, isRead: true });
  } catch (err) {
    req.log.error(err, "pbx.voicemails.get failed");
    return res.status(500).json({ error: "Failed to fetch voicemail" });
  }
});

// PATCH /api/pbx/voicemails/:id
const patchSchema = z.object({
  isRead: z.boolean().optional(),
  summary: z.string().optional(),
  actionItems: z.string().optional(),
  assignedToEmployeeId: z.string().nullable().optional(),
  assignedToEmployeeName: z.string().nullable().optional(),
  crmLeadId: z.number().int().nullable().optional(),
  clientId: z.number().int().nullable().optional(),
});

router.patch("/voicemails/:id", requireEmployeeAuth, async (req, res) => {
  const id = parseInt(String(req.params["id"]), 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const body = patchSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  try {
    const [updated] = await db
      .update(voicemails)
      .set(body.data)
      .where(and(eq(voicemails.id, id), eq(voicemails.tenantId, TENANT_ID)))
      .returning();

    if (!updated) return res.status(404).json({ error: "Voicemail not found" });
    return res.json(updated);
  } catch (err) {
    req.log.error(err, "pbx.voicemails.patch failed");
    return res.status(500).json({ error: "Failed to update voicemail" });
  }
});

// DELETE /api/pbx/voicemails/:id
router.delete("/voicemails/:id", requireEmployeeAuth, async (req, res) => {
  const id = parseInt(String(req.params["id"]), 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    await db
      .delete(voicemails)
      .where(and(eq(voicemails.id, id), eq(voicemails.tenantId, TENANT_ID)));
    return res.json({ success: true });
  } catch (err) {
    req.log.error(err, "pbx.voicemails.delete failed");
    return res.status(500).json({ error: "Failed to delete voicemail" });
  }
});

// POST /api/pbx/voicemails/mark-all-read
router.post("/voicemails/mark-all-read", requireEmployeeAuth, async (req, res) => {
  try {
    await db
      .update(voicemails)
      .set({ isRead: true })
      .where(and(eq(voicemails.tenantId, TENANT_ID), eq(voicemails.isRead, false)));
    return res.json({ success: true });
  } catch (err) {
    req.log.error(err, "pbx.voicemails.markAllRead failed");
    return res.status(500).json({ error: "Failed to mark voicemails read" });
  }
});

export default router;
