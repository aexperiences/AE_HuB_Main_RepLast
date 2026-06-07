import { requireEmployeeAuth, getTenantId } from "../middlewares/authMiddleware";
import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, socialMediaQueueTable, socialAccountsTable } from "@workspace/db";
import { z } from "zod/v4";

const router: IRouter = Router();

/* ── Queue helpers ─────────────────────────────────────────────── */
const toItem = (i: typeof socialMediaQueueTable.$inferSelect) => ({
  ...i,
  createdAt: i.createdAt.toISOString(),
  updatedAt: i.updatedAt.toISOString(),
  scheduledAt: i.scheduledAt ? i.scheduledAt.toISOString() : null,
});

const VALID_PLATFORMS = ["youtube", "instagram", "facebook", "tiktok", "twitter", "linkedin"] as const;
const VALID_STATUSES  = ["draft", "review", "approved", "scheduled", "published", "rejected", "ready"] as const;

const QueueBody = z.object({
  title:           z.string().min(1),
  platform:        z.string().min(1),
  client:          z.string().min(1),
  status:          z.enum(VALID_STATUSES).optional(),
  dueDate:         z.string().optional().nullable(),
  publishedDate:   z.string().optional().nullable(),
  url:             z.string().optional().nullable(),
  createdBy:       z.string().optional().nullable(),
  caption:         z.string().optional().nullable(),
  hashtags:        z.string().optional().nullable(),
  platforms:       z.string().optional().nullable(), // JSON array string
  contentVariants: z.string().optional().nullable(), // JSON object string
  scheduledAt:     z.string().optional().nullable(), // ISO datetime string
  assignedTo:      z.string().optional().nullable(),
  reviewNotes:     z.string().optional().nullable(),
});

const PatchBody = z.object({
  status:          z.enum(VALID_STATUSES).optional(),
  title:           z.string().min(1).optional(),
  platform:        z.string().optional(),
  client:          z.string().min(1).optional(),
  dueDate:         z.string().optional().nullable(),
  publishedDate:   z.string().optional().nullable(),
  url:             z.string().optional().nullable(),
  caption:         z.string().optional().nullable(),
  hashtags:        z.string().optional().nullable(),
  platforms:       z.string().optional().nullable(),
  contentVariants: z.string().optional().nullable(),
  scheduledAt:     z.string().optional().nullable(),
  assignedTo:      z.string().optional().nullable(),
  reviewNotes:     z.string().optional().nullable(),
});

/* ── Queue routes ──────────────────────────────────────────────── */
router.get("/social-media/queue", requireEmployeeAuth, async (req, res) => {
  const tenantId = getTenantId(req);
  const rows = await db
    .select()
    .from(socialMediaQueueTable)
    .where(eq(socialMediaQueueTable.tenantId, tenantId))
    .orderBy(desc(socialMediaQueueTable.createdAt));
  res.json(rows.map(toItem));
});

router.post("/social-media/queue", requireEmployeeAuth, async (req, res) => {
  const parsed = QueueBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }
  const tenantId = getTenantId(req);
  const data = parsed.data;
  const [row] = await db
    .insert(socialMediaQueueTable)
    .values({
      tenantId,
      title:           data.title,
      platform:        data.platform,
      client:          data.client,
      status:          data.status ?? "draft",
      dueDate:         data.dueDate ?? null,
      publishedDate:   data.publishedDate ?? null,
      url:             data.url ?? null,
      createdBy:       data.createdBy ?? null,
      caption:         data.caption ?? null,
      hashtags:        data.hashtags ?? null,
      platforms:       data.platforms ?? null,
      contentVariants: data.contentVariants ?? null,
      scheduledAt:     data.scheduledAt ? new Date(data.scheduledAt) : null,
      assignedTo:      data.assignedTo ?? null,
      reviewNotes:     data.reviewNotes ?? null,
    })
    .returning();
  res.status(201).json(toItem(row));
});

router.patch("/social-media/queue/:id", requireEmployeeAuth, async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = PatchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }
  const tenantId = getTenantId(req);
  const data = parsed.data;

  const updateData: Record<string, unknown> = {};
  if (data.status          !== undefined) updateData.status          = data.status;
  if (data.title           !== undefined) updateData.title           = data.title;
  if (data.platform        !== undefined) updateData.platform        = data.platform;
  if (data.client          !== undefined) updateData.client          = data.client;
  if (data.dueDate         !== undefined) updateData.dueDate         = data.dueDate;
  if (data.publishedDate   !== undefined) updateData.publishedDate   = data.publishedDate;
  if (data.url             !== undefined) updateData.url             = data.url;
  if (data.caption         !== undefined) updateData.caption         = data.caption;
  if (data.hashtags        !== undefined) updateData.hashtags        = data.hashtags;
  if (data.platforms       !== undefined) updateData.platforms       = data.platforms;
  if (data.contentVariants !== undefined) updateData.contentVariants = data.contentVariants;
  if (data.scheduledAt     !== undefined) updateData.scheduledAt     = data.scheduledAt ? new Date(data.scheduledAt) : null;
  if (data.assignedTo      !== undefined) updateData.assignedTo      = data.assignedTo;
  if (data.reviewNotes     !== undefined) updateData.reviewNotes     = data.reviewNotes;

  const [row] = await db
    .update(socialMediaQueueTable)
    .set(updateData)
    .where(and(eq(socialMediaQueueTable.id, id), eq(socialMediaQueueTable.tenantId, tenantId)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(toItem(row));
});

router.delete("/social-media/queue/:id", requireEmployeeAuth, async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const tenantId = getTenantId(req);
  await db
    .delete(socialMediaQueueTable)
    .where(and(eq(socialMediaQueueTable.id, id), eq(socialMediaQueueTable.tenantId, tenantId)));
  res.status(204).end();
});

/* ── Social Accounts routes ────────────────────────────────────── */
const toAccount = (a: typeof socialAccountsTable.$inferSelect) => ({
  ...a,
  createdAt: a.createdAt.toISOString(),
  updatedAt: a.updatedAt.toISOString(),
});

const AccountBody = z.object({
  clientName:    z.string().min(1),
  platform:      z.string().min(1),
  accountName:   z.string().min(1),
  accountHandle: z.string().min(1),
  accountType:   z.enum(["personal", "business", "creator"]).optional(),
  loginEmail:    z.string().optional().nullable(),
  notes:         z.string().optional().nullable(),
  isActive:      z.boolean().optional(),
});

const AccountPatch = z.object({
  clientName:    z.string().min(1).optional(),
  platform:      z.string().min(1).optional(),
  accountName:   z.string().min(1).optional(),
  accountHandle: z.string().min(1).optional(),
  accountType:   z.enum(["personal", "business", "creator"]).optional(),
  loginEmail:    z.string().optional().nullable(),
  notes:         z.string().optional().nullable(),
  isActive:      z.boolean().optional(),
});

router.get("/social-media/accounts", requireEmployeeAuth, async (req, res) => {
  const tenantId = getTenantId(req);
  const rows = await db
    .select()
    .from(socialAccountsTable)
    .where(eq(socialAccountsTable.tenantId, tenantId))
    .orderBy(socialAccountsTable.clientName, socialAccountsTable.platform);
  res.json(rows.map(toAccount));
});

router.post("/social-media/accounts", requireEmployeeAuth, async (req, res) => {
  const parsed = AccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }
  const tenantId = getTenantId(req);
  const [row] = await db
    .insert(socialAccountsTable)
    .values({ tenantId, ...parsed.data })
    .returning();
  res.status(201).json(toAccount(row));
});

router.patch("/social-media/accounts/:id", requireEmployeeAuth, async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = AccountPatch.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }
  const tenantId = getTenantId(req);
  const [row] = await db
    .update(socialAccountsTable)
    .set(parsed.data)
    .where(and(eq(socialAccountsTable.id, id), eq(socialAccountsTable.tenantId, tenantId)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(toAccount(row));
});

router.delete("/social-media/accounts/:id", requireEmployeeAuth, async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const tenantId = getTenantId(req);
  await db
    .delete(socialAccountsTable)
    .where(and(eq(socialAccountsTable.id, id), eq(socialAccountsTable.tenantId, tenantId)));
  res.status(204).end();
});

export default router;
