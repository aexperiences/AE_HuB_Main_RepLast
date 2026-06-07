import { Router, type IRouter, type Request, type Response } from "express";
import { db, crmLeadsTable, outreachQueueTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { requireAdminAuth } from "../middlewares/authMiddleware";
import { enqueueLeadOutreach, processOutreachQueue, verifyUnsubToken } from "../lib/outreach";

const router: IRouter = Router();

// ── GET /api/outreach/queue ──────────────────────────────────────────────────
router.get("/outreach/queue", requireAdminAuth, async (req: Request, res: Response) => {
  const rows = await db.execute(sql`
    SELECT
      q.id, q.lead_id, q.email_sequence, q.status,
      q.scheduled_for, q.sent_at, q.subject, q.error_message, q.created_at,
      l.contact_name, l.company, l.email, l.campaign_type
    FROM outreach_queue q
    JOIN crm_leads l ON l.id = q.lead_id
    ORDER BY q.created_at DESC
    LIMIT 100
  `);
  res.json((rows as any).rows ?? []);
});

// ── POST /api/outreach/enqueue ───────────────────────────────────────────────
router.post("/outreach/enqueue", requireAdminAuth, async (req: Request, res: Response) => {
  const { leadId, delayMinutes } = req.body ?? {};
  if (!leadId || isNaN(Number(leadId))) {
    res.status(400).json({ error: "leadId required" });
    return;
  }

  const [lead] = await db
    .select({ id: crmLeadsTable.id, email: crmLeadsTable.email, contactName: crmLeadsTable.contactName })
    .from(crmLeadsTable)
    .where(eq(crmLeadsTable.id, Number(leadId)))
    .limit(1);

  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
  if (!lead.email) { res.status(422).json({ error: "Lead has no email address" }); return; }

  const result = await enqueueLeadOutreach(Number(leadId), undefined, Number(delayMinutes ?? 0));
  res.json(result);
});

// ── POST /api/outreach/process ───────────────────────────────────────────────
// Manual trigger — useful for testing without waiting for the cron
router.post("/outreach/process", requireAdminAuth, async (req: Request, res: Response) => {
  const result = await processOutreachQueue();
  res.json(result);
});

// ── DELETE /api/outreach/queue/:id ───────────────────────────────────────────
router.delete("/outreach/queue/:id", requireAdminAuth, async (req: Request, res: Response) => {
  const id = Number(req.params["id"]);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  await db.execute(sql`
    UPDATE outreach_queue SET status = 'cancelled', updated_at = NOW() WHERE id = ${id}
  `);
  res.json({ ok: true });
});

// ── GET /api/outreach/lead/:leadId — current sequence status for one lead ────
router.get("/outreach/lead/:leadId", requireAdminAuth, async (req: Request, res: Response) => {
  const leadId = Number(req.params["leadId"]);
  if (isNaN(leadId)) { res.status(400).json({ error: "Invalid leadId" }); return; }

  const rows = await db.execute(sql`
    SELECT id, email_sequence, status, scheduled_for, sent_at, subject, error_message, created_at
    FROM outreach_queue
    WHERE lead_id = ${leadId}
    ORDER BY email_sequence ASC, created_at DESC
  `);
  res.json((rows as any).rows ?? []);
});

// ── GET /api/outreach/unsubscribe — PUBLIC one-click opt-out ─────────────────
router.get("/outreach/unsubscribe", async (req: Request, res: Response) => {
  const token = String(req.query["token"] ?? "");
  const leadId = verifyUnsubToken(token);

  if (!leadId) {
    res.status(400).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center">
      <h2>Invalid unsubscribe link</h2>
      <p>This link is invalid or has already been used. Please contact us directly if you need help.</p>
    </body></html>`);
    return;
  }

  await db.execute(sql`
    UPDATE outreach_queue SET status = 'unsubscribed', updated_at = NOW()
    WHERE lead_id = ${leadId} AND status IN ('pending', 'sent')
  `);
  await db.execute(sql`
    UPDATE crm_leads SET campaign_status = 'unsubscribed', updated_at = NOW()
    WHERE id = ${leadId}
  `);

  res.send(`<!DOCTYPE html><html><head><title>Unsubscribed</title></head>
    <body style="font-family:sans-serif;padding:60px 40px;text-align:center;max-width:480px;margin:0 auto">
      <h2 style="color:#111">You've been unsubscribed</h2>
      <p style="color:#555">You won't receive any more emails from Accelerated Experiences about this topic.</p>
      <p style="color:#999;font-size:13px;margin-top:24px">If this was a mistake, reply directly to any email you received from us and we'll add you back.</p>
    </body></html>`);
});

export default router;
