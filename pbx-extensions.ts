import { Router } from "express";
import { z } from "zod/v4";
import { eq, and } from "drizzle-orm";
import { db } from "@workspace/db";
import { phoneExtensions, employeeAccounts } from "@workspace/db/schema";
import { requireEmployeeAuth, requireAdminAuth } from "../middlewares/authMiddleware.js";

const router = Router();

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

// GET /api/pbx/extensions
router.get("/extensions", requireEmployeeAuth, async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(phoneExtensions)
      .where(eq(phoneExtensions.tenantId, TENANT_ID))
      .orderBy(phoneExtensions.extensionNumber);

    return res.json(rows);
  } catch (err) {
    req.log.error(err, "pbx.extensions.list failed");
    return res.status(500).json({ error: "Failed to fetch extensions" });
  }
});

// POST /api/pbx/extensions
const createExtensionSchema = z.object({
  extensionNumber: z.string().min(1),
  extensionName: z.string().min(1),
  employeeId: z.string().optional(),
  forwardToNumber: z.string().optional(),
  forwardingEnabled: z.boolean().optional(),
});

router.post("/extensions", requireAdminAuth, async (req, res) => {
  const body = createExtensionSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  try {
    const [conflict] = await db
      .select({ id: phoneExtensions.id })
      .from(phoneExtensions)
      .where(
        and(
          eq(phoneExtensions.tenantId, TENANT_ID),
          eq(phoneExtensions.extensionNumber, body.data.extensionNumber)
        )
      );

    if (conflict) {
      return res.status(409).json({ error: `Extension ${body.data.extensionNumber} already exists` });
    }

    let employeeName: string | undefined;
    if (body.data.employeeId) {
      const [emp] = await db
        .select({ name: employeeAccounts.name })
        .from(employeeAccounts)
        .where(eq(employeeAccounts.id, body.data.employeeId));
      employeeName = emp?.name ?? undefined;
    }

    const [created] = await db
      .insert(phoneExtensions)
      .values({
        tenantId: TENANT_ID,
        extensionNumber: body.data.extensionNumber,
        extensionName: body.data.extensionName,
        employeeId: body.data.employeeId,
        employeeName,
        forwardToNumber: body.data.forwardToNumber,
        forwardingEnabled: body.data.forwardingEnabled ?? false,
      })
      .returning();

    return res.status(201).json(created);
  } catch (err) {
    req.log.error(err, "pbx.extensions.create failed");
    return res.status(500).json({ error: "Failed to create extension" });
  }
});

// PATCH /api/pbx/extensions/:id
const patchExtensionSchema = z.object({
  extensionName: z.string().min(1).optional(),
  employeeId: z.string().nullable().optional(),
  forwardToNumber: z.string().nullable().optional(),
  forwardingEnabled: z.boolean().optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

router.patch("/extensions/:id", requireAdminAuth, async (req, res) => {
  const id = parseInt(String(req.params["id"]), 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const body = patchExtensionSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  try {
    const [existing] = await db
      .select()
      .from(phoneExtensions)
      .where(and(eq(phoneExtensions.id, id), eq(phoneExtensions.tenantId, TENANT_ID)));

    if (!existing) return res.status(404).json({ error: "Extension not found" });

    const updates: Partial<typeof phoneExtensions.$inferInsert> = { ...body.data, updatedAt: new Date() };

    if (body.data.employeeId !== undefined) {
      if (body.data.employeeId === null) {
        updates.employeeName = null;
      } else {
        const [emp] = await db
          .select({ name: employeeAccounts.name })
          .from(employeeAccounts)
          .where(eq(employeeAccounts.id, body.data.employeeId));
        updates.employeeName = emp?.name ?? null;
      }
    }

    const [updated] = await db
      .update(phoneExtensions)
      .set(updates)
      .where(eq(phoneExtensions.id, id))
      .returning();

    return res.json(updated);
  } catch (err) {
    req.log.error(err, "pbx.extensions.patch failed");
    return res.status(500).json({ error: "Failed to update extension" });
  }
});

// DELETE /api/pbx/extensions/:id  (soft delete)
router.delete("/extensions/:id", requireAdminAuth, async (req, res) => {
  const id = parseInt(String(req.params["id"]), 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    await db
      .update(phoneExtensions)
      .set({ status: "inactive", updatedAt: new Date() })
      .where(and(eq(phoneExtensions.id, id), eq(phoneExtensions.tenantId, TENANT_ID)));

    return res.json({ success: true });
  } catch (err) {
    req.log.error(err, "pbx.extensions.delete failed");
    return res.status(500).json({ error: "Failed to deactivate extension" });
  }
});

export default router;
