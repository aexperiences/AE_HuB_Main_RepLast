import { Router } from "express";
import { z } from "zod/v4";
import { eq, and, count, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  phoneNumbers,
  phoneCalls,
  smsMessages,
} from "@workspace/db/schema";
import { twilioService } from "@workspace/integrations-twilio";
import { requireEmployeeAuth, requireAdminAuth } from "../middlewares/authMiddleware.js";

const router = Router();

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

function getWebhookBase(): string {
  const domains = process.env.REPLIT_DOMAINS ?? "";
  const primary = domains.split(",")[0]?.trim();
  if (primary) return `https://${primary}`;
  return process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "https://localhost";
}

// GET /api/pbx/numbers
router.get("/numbers", requireEmployeeAuth, async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(phoneNumbers)
      .where(eq(phoneNumbers.tenantId, TENANT_ID))
      .orderBy(desc(phoneNumbers.createdAt));

    const withStats = await Promise.all(
      rows.map(async num => {
        const [callCount] = await db
          .select({ value: count() })
          .from(phoneCalls)
          .where(and(eq(phoneCalls.tenantId, TENANT_ID), eq(phoneCalls.toNumber, num.phoneNumber)));
        const [smsCount] = await db
          .select({ value: count() })
          .from(smsMessages)
          .where(and(eq(smsMessages.tenantId, TENANT_ID), eq(smsMessages.fromNumber, num.phoneNumber)));
        return { ...num, callCount: callCount?.value ?? 0, smsCount: smsCount?.value ?? 0 };
      })
    );

    return res.json(withStats);
  } catch (err) {
    req.log.error(err, "pbx.numbers.list failed");
    return res.status(500).json({ error: "Failed to fetch phone numbers" });
  }
});

// POST /api/pbx/numbers/search
const searchSchema = z.object({
  areaCode: z.string().optional(),
  contains: z.string().optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

router.post("/numbers/search", requireEmployeeAuth, async (req, res) => {
  const body = searchSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  if (!twilioService.isConfigured()) {
    return res.status(503).json({
      error: "Twilio is not configured. Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to secrets.",
    });
  }

  try {
    const numbers = await twilioService.searchPhoneNumbers(body.data);
    return res.json(numbers);
  } catch (err) {
    req.log.error(err, "pbx.numbers.search failed");
    return res.status(500).json({ error: "Failed to search phone numbers" });
  }
});

// POST /api/pbx/numbers/purchase
const purchaseSchema = z.object({
  phoneNumber: z.string().min(1),
  friendlyName: z.string().min(1),
});

router.post("/numbers/purchase", requireAdminAuth, async (req, res) => {
  const body = purchaseSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  if (!twilioService.isConfigured()) {
    return res.status(503).json({
      error: "Twilio is not configured. Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to secrets.",
    });
  }

  try {
    const base = getWebhookBase();
    const result = await twilioService.purchasePhoneNumber(body.data.phoneNumber, {
      voiceUrl: `${base}/api/pbx/webhooks/voice`,
      smsUrl: `${base}/api/pbx/webhooks/sms`,
      statusCallbackUrl: `${base}/api/pbx/webhooks/call-status`,
      friendlyName: body.data.friendlyName,
    });

    const [created] = await db
      .insert(phoneNumbers)
      .values({
        tenantId: TENANT_ID,
        phoneNumber: result.phoneNumber,
        friendlyName: body.data.friendlyName,
        twilioSid: result.sid,
      })
      .returning();

    return res.status(201).json(created);
  } catch (err) {
    req.log.error(err, "pbx.numbers.purchase failed");
    return res.status(500).json({ error: "Failed to purchase phone number" });
  }
});

// PATCH /api/pbx/numbers/:id
const patchSchema = z.object({
  friendlyName: z.string().min(1).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  voicemailEnabled: z.boolean().optional(),
  voicemailGreeting: z.string().optional(),
});

router.patch("/numbers/:id", requireAdminAuth, async (req, res) => {
  const id = parseInt(String(req.params["id"]), 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const body = patchSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  try {
    const [existing] = await db
      .select()
      .from(phoneNumbers)
      .where(and(eq(phoneNumbers.id, id), eq(phoneNumbers.tenantId, TENANT_ID)));

    if (!existing) return res.status(404).json({ error: "Phone number not found" });

    if (body.data.friendlyName && twilioService.isConfigured()) {
      await twilioService.updatePhoneNumber(existing.twilioSid, {
        friendlyName: body.data.friendlyName,
      });
    }

    const [updated] = await db
      .update(phoneNumbers)
      .set({ ...body.data, updatedAt: new Date() })
      .where(eq(phoneNumbers.id, id))
      .returning();

    return res.json(updated);
  } catch (err) {
    req.log.error(err, "pbx.numbers.patch failed");
    return res.status(500).json({ error: "Failed to update phone number" });
  }
});

// DELETE /api/pbx/numbers/:id  (soft delete)
router.delete("/numbers/:id", requireAdminAuth, async (req, res) => {
  const id = parseInt(String(req.params["id"]), 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const [existing] = await db
      .select()
      .from(phoneNumbers)
      .where(and(eq(phoneNumbers.id, id), eq(phoneNumbers.tenantId, TENANT_ID)));

    if (!existing) return res.status(404).json({ error: "Phone number not found" });

    await db
      .update(phoneNumbers)
      .set({ status: "inactive", updatedAt: new Date() })
      .where(eq(phoneNumbers.id, id));

    return res.json({ success: true, message: "Phone number deactivated" });
  } catch (err) {
    req.log.error(err, "pbx.numbers.delete failed");
    return res.status(500).json({ error: "Failed to deactivate phone number" });
  }
});

export default router;
