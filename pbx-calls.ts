import { Router } from "express";
import { z } from "zod/v4";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { phoneCalls, phoneNumbers } from "@workspace/db/schema";
import { twilioService } from "@workspace/integrations-twilio";
import { requireEmployeeAuth } from "../middlewares/authMiddleware.js";

const router = Router();

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

// GET /api/pbx/calls
router.get("/calls", requireEmployeeAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query["limit"] ?? "50"), 10), 200);
    const offset = parseInt(String(req.query["offset"] ?? "0"), 10);
    const direction = req.query["direction"] as string | undefined;
    const status = req.query["status"] as string | undefined;

    const conditions = [eq(phoneCalls.tenantId, TENANT_ID)];
    if (direction === "inbound" || direction === "outbound") {
      conditions.push(eq(phoneCalls.direction, direction));
    }
    if (status) {
      conditions.push(eq(phoneCalls.status, status));
    }

    const rows = await db
      .select()
      .from(phoneCalls)
      .where(and(...conditions))
      .orderBy(desc(phoneCalls.createdAt))
      .limit(limit)
      .offset(offset);

    return res.json(rows);
  } catch (err) {
    req.log.error(err, "pbx.calls.list failed");
    return res.status(500).json({ error: "Failed to fetch calls" });
  }
});

// GET /api/pbx/calls/stats/summary — must be before /:id
router.get("/calls/stats/summary", requireEmployeeAuth, async (req, res) => {
  try {
    const [stats] = await db
      .select({
        total: sql<number>`count(*)::int`,
        inbound: sql<number>`count(*) filter (where direction = 'inbound')::int`,
        outbound: sql<number>`count(*) filter (where direction = 'outbound')::int`,
        completed: sql<number>`count(*) filter (where status = 'completed')::int`,
        avgDuration: sql<number>`coalesce(round(avg(duration)), 0)::int`,
        totalDuration: sql<number>`coalesce(sum(duration), 0)::int`,
      })
      .from(phoneCalls)
      .where(eq(phoneCalls.tenantId, TENANT_ID));

    return res.json(stats);
  } catch (err) {
    req.log.error(err, "pbx.calls.stats failed");
    return res.status(500).json({ error: "Failed to fetch call stats" });
  }
});

// GET /api/pbx/calls/:id
router.get("/calls/:id", requireEmployeeAuth, async (req, res) => {
  const id = parseInt(String(req.params["id"]), 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const [call] = await db
      .select()
      .from(phoneCalls)
      .where(and(eq(phoneCalls.id, id), eq(phoneCalls.tenantId, TENANT_ID)));

    if (!call) return res.status(404).json({ error: "Call not found" });
    return res.json(call);
  } catch (err) {
    req.log.error(err, "pbx.calls.get failed");
    return res.status(500).json({ error: "Failed to fetch call" });
  }
});

// POST /api/pbx/calls/outbound
const outboundSchema = z.object({
  fromNumberId: z.number().int(),
  to: z.string().min(1),
});

router.post("/calls/outbound", requireEmployeeAuth, async (req, res) => {
  const body = outboundSchema.safeParse(req.body);
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

    const domains = process.env.REPLIT_DOMAINS ?? "";
    const host = domains.split(",")[0]?.trim() ?? process.env.REPLIT_DEV_DOMAIN ?? "localhost";
    const callbackUrl = `https://${host}/api/pbx/webhooks/voice`;

    const result = await twilioService.makeCall(num.phoneNumber, body.data.to, callbackUrl);

    const session = req.session as { employeeId?: string; employeeName?: string };
    const [call] = await db.insert(phoneCalls).values({
      tenantId: TENANT_ID,
      twilioCallSid: result.callSid,
      direction: "outbound",
      fromNumber: result.from,
      toNumber: result.to,
      status: result.status,
      employeeId: session.employeeId,
      employeeName: session.employeeName,
      startedAt: new Date(),
    }).returning();

    return res.status(201).json(call);
  } catch (err) {
    req.log.error(err, "pbx.calls.outbound failed");
    return res.status(500).json({ error: "Failed to initiate call" });
  }
});

// PATCH /api/pbx/calls/:id
const patchCallSchema = z.object({
  notes: z.string().optional(),
  crmLeadId: z.number().int().nullable().optional(),
  clientId: z.number().int().nullable().optional(),
  projectId: z.number().int().nullable().optional(),
});

router.patch("/calls/:id", requireEmployeeAuth, async (req, res) => {
  const id = parseInt(String(req.params["id"]), 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const body = patchCallSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.message });

  try {
    const [updated] = await db
      .update(phoneCalls)
      .set(body.data)
      .where(and(eq(phoneCalls.id, id), eq(phoneCalls.tenantId, TENANT_ID)))
      .returning();

    if (!updated) return res.status(404).json({ error: "Call not found" });
    return res.json(updated);
  } catch (err) {
    req.log.error(err, "pbx.calls.patch failed");
    return res.status(500).json({ error: "Failed to update call" });
  }
});

export default router;
