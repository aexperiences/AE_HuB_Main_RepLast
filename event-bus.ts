import { Router } from "express";
import { eq, and, desc, gte, sql } from "drizzle-orm";
import { db, eventsTable, eventSubscriptionsTable } from "@workspace/db";
import { requireAdminAuth, getTenantId } from "../middlewares/authMiddleware";
import { publishEvent, getRegisteredHandlers, reprocessFailedEvents } from "../lib/event-bus";

const router = Router();

// ── GET /api/event-bus/stats ──────────────────────────────────────────────────
router.get("/event-bus/stats", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    const tid = getTenantId(req);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const [totalRow] = await db.select({ count: sql<number>`count(*)::int` }).from(eventsTable)
      .where(eq(eventsTable.tenantId, tid));
    const [hourRow] = await db.select({ count: sql<number>`count(*)::int` }).from(eventsTable)
      .where(and(eq(eventsTable.tenantId, tid), gte(eventsTable.publishedAt, oneHourAgo)));
    const [failedRow] = await db.select({ count: sql<number>`count(*)::int` }).from(eventsTable)
      .where(and(eq(eventsTable.tenantId, tid), eq(eventsTable.status, "failed")));
    const [pendingRow] = await db.select({ count: sql<number>`count(*)::int` }).from(eventsTable)
      .where(and(eq(eventsTable.tenantId, tid), eq(eventsTable.status, "pending")));

    const subscriptions = await db.select().from(eventSubscriptionsTable).where(eq(eventSubscriptionsTable.enabled, true));

    const inProcessHandlers = getRegisteredHandlers();
    const handlerSummary: Record<string, number> = {};
    for (const [type, list] of inProcessHandlers.entries()) {
      handlerSummary[type] = list.length;
    }

    res.json({
      totalEvents:       totalRow?.count ?? 0,
      eventsLastHour:    hourRow?.count ?? 0,
      failedEvents:      failedRow?.count ?? 0,
      pendingEvents:     pendingRow?.count ?? 0,
      activeSubscriptions: subscriptions.length,
      registeredHandlers: handlerSummary,
    });
  } catch (err) {
    req.log.error({ err }, "event-bus/stats failed");
    res.status(500).json({ error: "Failed to load stats" });
  }
});

// ── GET /api/event-bus/events ─────────────────────────────────────────────────
router.get("/event-bus/events", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    const tid = getTenantId(req);
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const status = req.query.status as string | undefined;
    const eventType = req.query.eventType as string | undefined;

    let query = db.select().from(eventsTable).where(eq(eventsTable.tenantId, tid));

    if (status && status !== "all") {
      query = db.select().from(eventsTable).where(and(
        eq(eventsTable.tenantId, tid),
        eq(eventsTable.status, status as "pending" | "processing" | "completed" | "failed"),
      ));
    }
    if (eventType) {
      query = db.select().from(eventsTable).where(and(
        eq(eventsTable.tenantId, tid),
        eq(eventsTable.eventType, eventType),
      ));
    }

    const events = await query.orderBy(desc(eventsTable.publishedAt)).limit(limit);
    res.json(events);
  } catch (err) {
    req.log.error({ err }, "event-bus/events failed");
    res.status(500).json({ error: "Failed to load events" });
  }
});

// ── GET /api/event-bus/subscriptions ─────────────────────────────────────────
router.get("/event-bus/subscriptions", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    const subs = await db.select().from(eventSubscriptionsTable).orderBy(eventSubscriptionsTable.agentId);
    res.json(subs);
  } catch (err) {
    req.log.error({ err }, "event-bus/subscriptions failed");
    res.status(500).json({ error: "Failed to load subscriptions" });
  }
});

// ── PATCH /api/event-bus/subscriptions/:id/toggle ────────────────────────────
router.patch("/event-bus/subscriptions/:id/toggle", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    const [sub] = await db.select().from(eventSubscriptionsTable).where(eq(eventSubscriptionsTable.id, id));
    if (!sub) { res.status(404).json({ error: "Not found" }); return; }
    const [updated] = await db.update(eventSubscriptionsTable)
      .set({ enabled: !sub.enabled })
      .where(eq(eventSubscriptionsTable.id, id))
      .returning();
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "event-bus/subscriptions toggle failed");
    res.status(500).json({ error: "Failed to toggle subscription" });
  }
});

// ── POST /api/event-bus/publish (test/manual publish) ────────────────────────
router.post("/event-bus/publish", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    const tid = getTenantId(req);
    const { eventType, payload, metadata } = req.body as {
      eventType?: string;
      payload?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };
    if (!eventType) { res.status(400).json({ error: "eventType is required" }); return; }

    const id = await publishEvent(eventType, payload ?? {}, { ...metadata, source: "manual-admin" }, tid);
    res.json({ success: true, eventId: id });
  } catch (err) {
    req.log.error({ err }, "event-bus/publish failed");
    res.status(500).json({ error: "Failed to publish event" });
  }
});

// ── POST /api/event-bus/reprocess-failed ─────────────────────────────────────
router.post("/event-bus/reprocess-failed", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    await reprocessFailedEvents();
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "event-bus/reprocess-failed failed");
    res.status(500).json({ error: "Failed to reprocess events" });
  }
});

// ── DELETE /api/event-bus/events/:id (dismiss a dead-letter event) ────────────
router.delete("/event-bus/events/:id", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    await db.update(eventsTable)
      .set({ status: "completed", errorMessage: "Dismissed by admin" })
      .where(eq(eventsTable.id, id));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "event-bus/dismiss failed");
    res.status(500).json({ error: "Failed to dismiss event" });
  }
});

export default router;
