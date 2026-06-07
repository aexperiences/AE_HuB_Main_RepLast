import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, reportEmailSettingsTable } from "@workspace/db";
import { requireAccountingAuth, getTenantId } from "../middlewares/authMiddleware";
import { sendEmail, isEmailConfigured } from "../lib/email";
import { getWeeklySnapshot, buildReportEmail } from "../lib/financial-report-email";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";

async function getOrCreateSettings(tenantId: string) {
  const [existing] = await db.select().from(reportEmailSettingsTable)
    .where(eq(reportEmailSettingsTable.tenantId, tenantId as any));
  if (existing) return existing;

  const [created] = await db.insert(reportEmailSettingsTable).values({
    tenantId: tenantId as any,
    enabled: false,
    recipientEmails: "",
    timezone: "America/New_York",
  }).returning();
  return created;
}

// ── GET /api/report-email-settings ────────────────────────────────────────────
router.get("/report-email-settings", requireAccountingAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const settings = await getOrCreateSettings(tid);
  res.json({ ...settings, smtpConfigured: isEmailConfigured() });
});

// ── PUT /api/report-email-settings ────────────────────────────────────────────
router.put("/report-email-settings", requireAccountingAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  await getOrCreateSettings(tid);

  const { enabled, recipientEmails, timezone } = req.body;
  const update: Record<string, unknown> = {};
  if (typeof enabled === "boolean") update.enabled = enabled;
  if (typeof recipientEmails === "string") update.recipientEmails = recipientEmails.trim();
  if (typeof timezone === "string") update.timezone = timezone;

  const [updated] = await db.update(reportEmailSettingsTable)
    .set(update)
    .where(eq(reportEmailSettingsTable.tenantId, tid as any))
    .returning();

  res.json({ ...updated, smtpConfigured: isEmailConfigured() });
});

// ── POST /api/report-email-settings/test ─────────────────────────────────────
router.post("/report-email-settings/test", requireAccountingAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const settings = await getOrCreateSettings(tid);

  if (!isEmailConfigured()) {
    res.status(503).json({ error: "SMTP not configured", smtpRequired: true }); return;
  }

  const recipients = (settings.recipientEmails || "").split(",").map((e: string) => e.trim()).filter(Boolean);
  if (recipients.length === 0) {
    res.status(400).json({ error: "No recipient emails configured" }); return;
  }

  try {
    const snapshot = await getWeeklySnapshot(tid);
    const appUrl   = `https://${process.env.REPLIT_DOMAINS?.split(",")[0] ?? "localhost"}`;
    const { subject, html, text } = buildReportEmail({
      snapshot,
      summary: "This is a test email from Geoffrey. Your weekly financial reports are set up correctly and will be delivered every Monday at 9 AM.",
      reportUrl: `${appUrl}/reports`,
      period: new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    });

    const result = await sendEmail({ to: recipients, subject: `[TEST] ${subject}`, html, text });
    if (result.success) {
      res.json({ success: true, sentTo: recipients });
    } else {
      res.status(500).json({ error: result.error ?? "Send failed" });
    }
  } catch (err: any) {
    logger.error({ err }, "Test email failed");
    res.status(500).json({ error: err?.message ?? "Failed to send test email" });
  }
});

export { getOrCreateSettings };
export default router;
