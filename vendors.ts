import { requireEmployeeAuth, getTenantId } from "../middlewares/authMiddleware";
import { Router, type IRouter } from "express";
import { eq, desc, sql, and } from "drizzle-orm";
import { db, vendorsTable } from "@workspace/db";
import { firstAvailable } from "../lib/nextNum";
import { syncContact, pushToContact, splitName } from "../lib/syncContact";

const router: IRouter = Router();

function toVendor(v: typeof vendorsTable.$inferSelect) {
  return {
    ...v,
    defaultMarkupPct: v.defaultMarkupPct != null ? Number(v.defaultMarkupPct) : null,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

router.get("/vendors", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const includeInactive = req.query.all === "true";
  const rows = includeInactive
    ? await db.select().from(vendorsTable).where(eq(vendorsTable.tenantId, tid)).orderBy(vendorsTable.vendorNumber)
    : await db.select().from(vendorsTable).where(and(eq(vendorsTable.tenantId, tid), eq(vendorsTable.status, "active"))).orderBy(vendorsTable.vendorNumber);
  res.json(rows.map(toVendor));
});

router.get("/vendors/next-number", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(vendorsTable)
    .where(eq(vendorsTable.tenantId, tid));
  const next = (Number(row?.count ?? 0) + 1).toString().padStart(3, "0");
  res.json({ nextNumber: `V-${next}` });
});

router.get("/vendors/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const [row] = await db.select().from(vendorsTable).where(and(eq(vendorsTable.id, id), eq(vendorsTable.tenantId, tid)));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(toVendor(row));
});

router.post("/vendors", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const { vendorNumber: rawVendorNumber, name, category, contactName, email, phone, website, defaultMarkupPct, notes } = req.body;
  if (!name?.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const vendorNumber = rawVendorNumber?.trim()
    ? rawVendorNumber.trim()
    : await firstAvailable("V", "vendors", "vendor_number");
  try {
    const [row] = await db.insert(vendorsTable).values({
      tenantId: tid,
      vendorNumber,
      name: name.trim(),
      category: category?.trim() || null,
      contactName: contactName?.trim() || null,
      email: email?.trim() || null,
      phone: phone?.trim() || null,
      website: website?.trim() || null,
      defaultMarkupPct: defaultMarkupPct != null ? String(defaultMarkupPct) : null,
      notes: notes?.trim() || null,
    }).returning();

    // Auto-sync to contacts and store the link
    const { firstName, lastName } = contactName?.trim()
      ? splitName(contactName.trim())
      : { firstName: name.trim(), lastName: "" };
    const contactId = await syncContact({
      tenantId: tid,
      firstName,
      lastName,
      company:  name.trim(),
      email:    email?.trim() ?? "",
      phone:    phone?.trim() ?? "",
      role:     "vendor",
      category: category?.trim() ? `Vendor / ${category.trim()}` : "Vendor",
      notes:    notes?.trim() ?? "",
    });
    await db.update(vendorsTable).set({ contactId }).where(eq(vendorsTable.id, row.id));

    res.status(201).json(toVendor({ ...row, contactId }));
  } catch (err: any) {
    if (err?.code === "23505") {
      res.status(409).json({ error: "Vendor number already exists" });
    } else {
      throw err;
    }
  }
});

router.patch("/vendors/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const update: Record<string, unknown> = {};
  if (req.body.vendorNumber !== undefined) update.vendorNumber = req.body.vendorNumber;
  if (req.body.name !== undefined) update.name = req.body.name;
  if (req.body.category !== undefined) update.category = req.body.category || null;
  if (req.body.contactName !== undefined) update.contactName = req.body.contactName || null;
  if (req.body.email !== undefined) update.email = req.body.email || null;
  if (req.body.phone !== undefined) update.phone = req.body.phone || null;
  if (req.body.website !== undefined) update.website = req.body.website || null;
  if (req.body.defaultMarkupPct !== undefined) update.defaultMarkupPct = req.body.defaultMarkupPct != null ? String(req.body.defaultMarkupPct) : null;
  if (req.body.notes !== undefined) update.notes = req.body.notes || null;
  if (req.body.status !== undefined) update.status = req.body.status;
  try {
    const [row] = await db.update(vendorsTable).set(update).where(and(eq(vendorsTable.id, id), eq(vendorsTable.tenantId, tid))).returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }

    // Sync changes to the linked contact
    if (row.contactId) {
      const { firstName, lastName } = row.contactName?.trim()
        ? splitName(row.contactName.trim())
        : { firstName: row.name, lastName: "" };
      await pushToContact(row.contactId, {
        firstName,
        lastName,
        company: row.name,
        email:   row.email   ?? "",
        phone:   row.phone   ?? "",
        notes:   row.notes   ?? "",
      });
    }

    res.json(toVendor(row));
  } catch (err: any) {
    if (err?.code === "23505") {
      res.status(409).json({ error: "Vendor number already exists" });
    } else {
      throw err;
    }
  }
});

router.delete("/vendors/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const [row] = await db.delete(vendorsTable).where(and(eq(vendorsTable.id, id), eq(vendorsTable.tenantId, tid))).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.sendStatus(204);
});

export default router;
