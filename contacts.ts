import { Router } from "express";
import { eq, and, or, ilike } from "drizzle-orm";
import { db, contactsTable, vendorsTable, crmLeadsTable } from "@workspace/db";
import { requireAdminAuth, getTenantId } from "../middlewares/authMiddleware";

const router: Router = Router();

router.get("/contacts", requireAdminAuth, async (req, res): Promise<void> => {
  const tid   = getTenantId(req);
  const q     = req.query.q as string | undefined;
  const limit = Math.min(Number(req.query.limit ?? 500), 1000);

  const rows = await db.select().from(contactsTable)
    .where(
      q
        ? and(
            eq(contactsTable.tenantId, tid as any),
            or(
              ilike(contactsTable.firstName, `%${q}%`),
              ilike(contactsTable.lastName,  `%${q}%`),
              ilike(contactsTable.company,   `%${q}%`),
              ilike(contactsTable.email,     `%${q}%`),
              ilike(contactsTable.category,  `%${q}%`),
            )
          )
        : eq(contactsTable.tenantId, tid as any)
    )
    .orderBy(contactsTable.firstName, contactsTable.lastName)
    .limit(limit);

  res.json(rows);
});

router.post("/contacts", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const { firstName, lastName, company, email, phone, city, role, category, notes, isCrmClient } = req.body as {
    firstName: string; lastName?: string; company?: string; email: string;
    phone?: string; city?: string; role?: string; category?: string; notes?: string; isCrmClient?: boolean;
  };

  if (!firstName?.trim() || !email?.trim()) {
    res.status(400).json({ error: "firstName and email are required" });
    return;
  }

  const [row] = await db.insert(contactsTable).values({
    tenantId:    tid as any,
    firstName:   firstName.trim(),
    lastName:    lastName?.trim()  ?? "",
    company:     company?.trim()   ?? "",
    email:       email.trim().toLowerCase(),
    phone:       phone?.trim()     ?? "",
    city:        city?.trim()      ?? "",
    role:        role?.trim()      ?? "other",
    category:    category?.trim()  ?? "",
    notes:       notes?.trim()     ?? "",
    isCrmClient: !!isCrmClient,
  }).returning();

  res.status(201).json(row);
});

router.put("/contacts/:id", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id  = Number(req.params.id);
  const { firstName, lastName, company, email, phone, city, role, category, notes, isCrmClient } = req.body as {
    firstName?: string; lastName?: string; company?: string; email?: string;
    phone?: string; city?: string; role?: string; category?: string; notes?: string; isCrmClient?: boolean;
  };

  const updates: Partial<typeof contactsTable.$inferInsert> = {};
  if (firstName   !== undefined) updates.firstName   = firstName.trim();
  if (lastName    !== undefined) updates.lastName    = lastName.trim();
  if (company     !== undefined) updates.company     = company.trim();
  if (email       !== undefined) updates.email       = email.trim().toLowerCase();
  if (phone       !== undefined) updates.phone       = phone.trim();
  if (city        !== undefined) updates.city        = city.trim();
  if (role        !== undefined) updates.role        = role.trim();
  if (category    !== undefined) updates.category    = category.trim();
  if (notes       !== undefined) updates.notes       = notes.trim();
  if (isCrmClient !== undefined) updates.isCrmClient = !!isCrmClient;

  const [row] = await db.update(contactsTable)
    .set(updates)
    .where(and(eq(contactsTable.id, id), eq(contactsTable.tenantId, tid as any)))
    .returning();

  if (!row) { res.status(404).json({ error: "Contact not found" }); return; }

  // Push name/email/phone/notes changes back to any linked vendor
  const vendorPatch: Record<string, unknown> = {};
  if (updates.firstName !== undefined || updates.lastName !== undefined) {
    const fullName = [row.firstName, row.lastName].filter(Boolean).join(" ");
    vendorPatch.contactName = fullName || null;
  }
  if (updates.email   !== undefined) vendorPatch.email = row.email   || null;
  if (updates.phone   !== undefined) vendorPatch.phone = row.phone   || null;
  if (updates.notes   !== undefined) vendorPatch.notes = row.notes   || null;
  if (updates.company !== undefined) vendorPatch.name  = row.company || null;

  if (Object.keys(vendorPatch).length > 0) {
    await db.update(vendorsTable)
      .set(vendorPatch)
      .where(eq(vendorsTable.contactId, id));
  }

  // Push name/email/phone/notes/company changes back to any linked CRM lead
  const leadPatch: Record<string, unknown> = {};
  if (updates.firstName !== undefined || updates.lastName !== undefined) {
    leadPatch.contactName = [row.firstName, row.lastName].filter(Boolean).join(" ");
  }
  if (updates.email   !== undefined) leadPatch.email   = row.email   || null;
  if (updates.phone   !== undefined) leadPatch.phone   = row.phone   || null;
  if (updates.notes   !== undefined) leadPatch.notes   = row.notes   || null;
  if (updates.company !== undefined) leadPatch.company = row.company || null;

  if (Object.keys(leadPatch).length > 0) {
    await db.update(crmLeadsTable)
      .set(leadPatch)
      .where(eq(crmLeadsTable.contactId, id));
  }

  res.json(row);
});

router.delete("/contacts/:id", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id  = Number(req.params.id);

  await db.delete(contactsTable)
    .where(and(eq(contactsTable.id, id), eq(contactsTable.tenantId, tid as any)));

  res.json({ success: true });
});

export { router as contactsRouter };
