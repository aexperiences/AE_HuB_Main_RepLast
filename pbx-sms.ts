import { Router } from "express";
import { z } from "zod/v4";
import { eq, and, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  smsMessages,
  smsCampaigns,
  smsTemplates,
  phoneNumbers,
  crmLeadsTable,
} from "@workspace/db/schema";
import { twilioService } from "@workspace/integrations-twilio";
import { requireEmployeeAuth, requireAdminAuth } from "../middlewares/authMiddleware.js";

const router = Router();

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

// ── SMS Messages ──────────────────────────────────────────────────────────────

router.get("/sms", requireEmployeeAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query["limit"] ?? "50"), 10), 200);
    const offset = parseInt(String(req.query["offset"] ?? "0"), 10);

    const rows = await db
      .select()
      .from(smsMessages)
      .where(eq(smsMessages.tenantId, TENANT_ID))
      .orderBy(desc(smsMessages.createdAt))
      .limit(limit)
      .offset(offset);

    return res.json(rows);
  } catch (err) {
    req.log.error(err, "pbx.sms.list failed");
    return res.status(500).json({ error: "Failed to fetch SMS messages" });
  }
});

const sendSmsSchema = z.object({
  fromNumberId: z.number().int(),
  to: z.string().min(1),
  body: z.string().min(1).max(1600),
  crmLeadId: z.number().int().optional(),
  clientId: z.number().int().optional(),
});

router.post("/sms/send", requireEmployeeAuth, async (req, res) => {
  const body = sendSmsSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  if (!twilioService.isConfigured()) {
    return res.status(503).json({ error: "Twilio is not configured" });
  }

  try {
    const [num] = await db
      .select()
      .from(phoneNumbers)
      .where(and(eq(phoneNumbers.id, body.data.fromNumberId), eq(phoneNumbers.tenantId, TENANT_ID)));

    if (!num) return res.status(404).json({ error: "Phone number not found" });

    const result = await twilioService.sendSMS(num.phoneNumber, body.data.to, body.data.body);

    const session = req.session as { employeeId?: string; employeeName?: string };
    const [message] = await db.insert(smsMessages).values({
      tenantId: TENANT_ID,
      twilioMessageSid: result.messageSid,
      direction: "outbound",
      fromNumber: result.from,
      toNumber: result.to,
      body: result.body,
      status: result.status,
      price: result.price ?? null,
      priceUnit: result.priceUnit ?? null,
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage ?? null,
      employeeId: session.employeeId,
      employeeName: session.employeeName,
      crmLeadId: body.data.crmLeadId ?? null,
      clientId: body.data.clientId ?? null,
      sentAt: new Date(),
    }).returning();

    return res.status(201).json(message);
  } catch (err) {
    req.log.error(err, "pbx.sms.send failed");
    return res.status(500).json({ error: "Failed to send SMS" });
  }
});

// ── SMS Templates ─────────────────────────────────────────────────────────────

router.get("/sms/templates", requireEmployeeAuth, async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(smsTemplates)
      .where(eq(smsTemplates.tenantId, TENANT_ID))
      .orderBy(desc(smsTemplates.useCount));
    return res.json(rows);
  } catch (err) {
    req.log.error(err, "pbx.sms.templates.list failed");
    return res.status(500).json({ error: "Failed to fetch templates" });
  }
});

const templateSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional(),
  body: z.string().min(1),
  variables: z.array(z.string()).optional(),
});

router.post("/sms/templates", requireEmployeeAuth, async (req, res) => {
  const body = templateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  try {
    const session = req.session as { employeeId?: string; employeeName?: string };
    const vars = body.data.variables ?? extractVariables(body.data.body);
    const [created] = await db.insert(smsTemplates).values({
      tenantId: TENANT_ID,
      name: body.data.name,
      category: body.data.category,
      body: body.data.body,
      variables: vars,
      createdBy: session.employeeId,
      createdByName: session.employeeName,
    }).returning();
    return res.status(201).json(created);
  } catch (err) {
    req.log.error(err, "pbx.sms.templates.create failed");
    return res.status(500).json({ error: "Failed to create template" });
  }
});

router.patch("/sms/templates/:id", requireEmployeeAuth, async (req, res) => {
  const id = parseInt(String(req.params["id"]), 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const body = templateSchema.partial().safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  try {
    const updates: Record<string, unknown> = { ...body.data, updatedAt: new Date() };
    if (body.data.body && !body.data.variables) {
      updates["variables"] = extractVariables(body.data.body);
    }
    const [updated] = await db
      .update(smsTemplates)
      .set(updates)
      .where(and(eq(smsTemplates.id, id), eq(smsTemplates.tenantId, TENANT_ID)))
      .returning();
    if (!updated) return res.status(404).json({ error: "Template not found" });
    return res.json(updated);
  } catch (err) {
    req.log.error(err, "pbx.sms.templates.patch failed");
    return res.status(500).json({ error: "Failed to update template" });
  }
});

router.delete("/sms/templates/:id", requireAdminAuth, async (req, res) => {
  const id = parseInt(String(req.params["id"]), 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    await db.delete(smsTemplates).where(and(eq(smsTemplates.id, id), eq(smsTemplates.tenantId, TENANT_ID)));
    return res.json({ success: true });
  } catch (err) {
    req.log.error(err, "pbx.sms.templates.delete failed");
    return res.status(500).json({ error: "Failed to delete template" });
  }
});

// ── SMS Campaigns ─────────────────────────────────────────────────────────────

router.get("/sms/campaigns", requireEmployeeAuth, async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(smsCampaigns)
      .where(eq(smsCampaigns.tenantId, TENANT_ID))
      .orderBy(desc(smsCampaigns.createdAt));
    return res.json(rows);
  } catch (err) {
    req.log.error(err, "pbx.sms.campaigns.list failed");
    return res.status(500).json({ error: "Failed to fetch campaigns" });
  }
});

const campaignSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  fromNumberId: z.number().int(),
  messageTemplate: z.string().min(1),
  targetType: z.enum(["all_leads", "filtered_leads", "custom_list"]),
  targetFilter: z.unknown().optional(),
  targetPhoneNumbers: z.array(z.string()).optional(),
  scheduledAt: z.string().optional(),
});

router.post("/sms/campaigns", requireAdminAuth, async (req, res) => {
  const body = campaignSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  try {
    const session = req.session as { employeeId?: string; employeeName?: string };
    const [created] = await db.insert(smsCampaigns).values({
      tenantId: TENANT_ID,
      name: body.data.name,
      description: body.data.description,
      fromNumberId: body.data.fromNumberId,
      messageTemplate: body.data.messageTemplate,
      targetType: body.data.targetType,
      targetFilter: body.data.targetFilter ?? null,
      targetPhoneNumbers: body.data.targetPhoneNumbers ?? null,
      scheduledAt: body.data.scheduledAt ? new Date(body.data.scheduledAt) : null,
      createdBy: session.employeeId,
      createdByName: session.employeeName,
    }).returning();
    return res.status(201).json(created);
  } catch (err) {
    req.log.error(err, "pbx.sms.campaigns.create failed");
    return res.status(500).json({ error: "Failed to create campaign" });
  }
});

router.post("/sms/campaigns/:id/send", requireAdminAuth, async (req, res) => {
  const id = parseInt(String(req.params["id"]), 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  if (!twilioService.isConfigured()) {
    return res.status(503).json({ error: "Twilio is not configured" });
  }

  try {
    const [campaign] = await db
      .select()
      .from(smsCampaigns)
      .where(and(eq(smsCampaigns.id, id), eq(smsCampaigns.tenantId, TENANT_ID)));

    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (campaign.status !== "draft" && campaign.status !== "scheduled") {
      return res.status(400).json({ error: "Campaign cannot be sent in its current state" });
    }

    const [fromNum] = await db
      .select()
      .from(phoneNumbers)
      .where(eq(phoneNumbers.id, campaign.fromNumberId));

    if (!fromNum) return res.status(400).json({ error: "From number not found" });

    let recipients: { phone: string; firstName?: string; company?: string }[] = [];

    if (campaign.targetType === "custom_list" && campaign.targetPhoneNumbers?.length) {
      recipients = campaign.targetPhoneNumbers.map(p => ({ phone: p }));
    } else {
      const leads = await db
        .select({ phone: crmLeadsTable.phone, name: crmLeadsTable.contactName, company: crmLeadsTable.company })
        .from(crmLeadsTable)
        .where(eq(crmLeadsTable.tenantId, TENANT_ID));

      recipients = leads
        .filter(l => l.phone)
        .map(l => ({
          phone: l.phone!,
          firstName: l.name?.split(" ")[0],
          company: l.company ?? undefined,
        }));
    }

    await db.update(smsCampaigns).set({
      status: "sending",
      startedAt: new Date(),
      totalRecipients: recipients.length,
    }).where(eq(smsCampaigns.id, id));

    res.json({ message: "Campaign sending started", totalRecipients: recipients.length });

    let sent = 0, failed = 0;
    for (const r of recipients) {
      try {
        const msgBody = interpolateTemplate(campaign.messageTemplate, {
          firstName: r.firstName ?? "",
          company: r.company ?? "",
          phone: r.phone,
        });
        const result = await twilioService.sendSMS(fromNum.phoneNumber, r.phone, msgBody);
        await db.insert(smsMessages).values({
          tenantId: TENANT_ID,
          twilioMessageSid: result.messageSid,
          direction: "outbound",
          fromNumber: fromNum.phoneNumber,
          toNumber: r.phone,
          body: msgBody,
          status: result.status,
          campaignId: id,
          sentAt: new Date(),
        }).onConflictDoNothing();
        sent++;
      } catch (_) {
        failed++;
      }
    }

    await db.update(smsCampaigns).set({
      status: "completed",
      completedAt: new Date(),
      sentCount: sent,
      failedCount: failed,
    }).where(eq(smsCampaigns.id, id));

    return;
  } catch (err) {
    req.log.error(err, "pbx.sms.campaigns.send failed");
    await db.update(smsCampaigns).set({ status: "paused" }).where(eq(smsCampaigns.id, id));
    return;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractVariables(template: string): string[] {
  const matches = template.match(/\{\{(\w+)\}\}/g) ?? [];
  return [...new Set(matches.map(m => m.slice(2, -2)))];
}

function interpolateTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

export default router;
