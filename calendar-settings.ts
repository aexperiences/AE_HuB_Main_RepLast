import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  userCalendarSettingsTable,
  calendarNotificationsQueueTable,
  calendarEventsTable,
  calendarRemindersSentTable,
} from "@workspace/db";
import { eq, and, lte } from "drizzle-orm";
import { z } from "zod/v4";
import { requireEmployeeAuth } from "../middlewares/authMiddleware";

const router: IRouter = Router();
const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";

const defaultSettings = {
  defaultView: "week" as const,
  startDayOfWeek: 0,
  workingHoursStart: "09:00",
  workingHoursEnd: "17:00",
  timezone: "America/Los_Angeles",
  emailRemindersEnabled: true,
  smsRemindersEnabled: false,
  inAppRemindersEnabled: true,
  dailyDigestEnabled: true,
  dailyDigestTime: "08:00",
};

const settingsPatchSchema = z.object({
  defaultView: z.enum(["month", "week", "day", "agenda"]).optional(),
  startDayOfWeek: z.number().int().min(0).max(6).optional(),
  workingHoursStart: z.string().optional(),
  workingHoursEnd: z.string().optional(),
  timezone: z.string().optional(),
  emailRemindersEnabled: z.boolean().optional(),
  smsRemindersEnabled: z.boolean().optional(),
  inAppRemindersEnabled: z.boolean().optional(),
  dailyDigestEnabled: z.boolean().optional(),
  dailyDigestTime: z.string().optional(),
});

// ── GET /api/calendar/settings ────────────────────────────────────────────────

router.get("/calendar/settings", requireEmployeeAuth, async (req, res): Promise<void> => {
  const session = (req as any).session;
  const tenantId = session.tenantId ?? DEFAULT_TENANT;
  const employeeId: string = session.employeeId;

  const [settings] = await db
    .select()
    .from(userCalendarSettingsTable)
    .where(
      and(
        eq(userCalendarSettingsTable.tenantId, tenantId as any),
        eq(userCalendarSettingsTable.employeeId, employeeId),
      ),
    );

  res.json(settings ?? { ...defaultSettings, tenantId, employeeId });
});

// ── PATCH /api/calendar/settings ──────────────────────────────────────────────

router.patch("/calendar/settings", requireEmployeeAuth, async (req, res): Promise<void> => {
  const session = (req as any).session;
  const tenantId = session.tenantId ?? DEFAULT_TENANT;
  const employeeId: string = session.employeeId;

  const parsed = settingsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }

  const upsertData = {
    tenantId: tenantId as any,
    employeeId: employeeId as any,
    ...defaultSettings,
    ...parsed.data,
  };

  const [result] = await db
    .insert(userCalendarSettingsTable)
    .values(upsertData)
    .onConflictDoUpdate({
      target: [userCalendarSettingsTable.tenantId, userCalendarSettingsTable.employeeId],
      set: parsed.data,
    })
    .returning();

  res.json(result);
});

// ── GET /api/calendar/notifications ───────────────────────────────────────────

router.get("/calendar/notifications", requireEmployeeAuth, async (req, res): Promise<void> => {
  const session = (req as any).session;
  const employeeId: string = session.employeeId;

  const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);

  const notifications = await db
    .select({
      id: calendarNotificationsQueueTable.id,
      eventId: calendarNotificationsQueueTable.eventId,
      notificationType: calendarNotificationsQueueTable.notificationType,
      scheduledFor: calendarNotificationsQueueTable.scheduledFor,
      status: calendarNotificationsQueueTable.status,
      eventTitle: calendarEventsTable.title,
      eventStartDate: calendarEventsTable.startDate,
      eventLocation: calendarEventsTable.location,
      eventMeetingLink: calendarEventsTable.meetingLink,
      eventType: calendarEventsTable.eventType,
    })
    .from(calendarNotificationsQueueTable)
    .innerJoin(calendarEventsTable, eq(calendarEventsTable.id, calendarNotificationsQueueTable.eventId))
    .where(
      and(
        eq(calendarNotificationsQueueTable.employeeId, employeeId),
        eq(calendarNotificationsQueueTable.status, "pending"),
        lte(calendarNotificationsQueueTable.scheduledFor, oneHourFromNow),
      ),
    )
    .orderBy(calendarNotificationsQueueTable.scheduledFor);

  const inAppIds = notifications
    .filter((n) => n.notificationType === "in_app")
    .map((n) => n.id);

  for (const notifId of inAppIds) {
    const notif = notifications.find((n) => n.id === notifId);
    if (!notif) continue;
    await db
      .update(calendarNotificationsQueueTable)
      .set({ status: "sent", sentAt: new Date() })
      .where(eq(calendarNotificationsQueueTable.id, notifId));
    await db
      .insert(calendarRemindersSentTable)
      .values({
        eventId: notif.eventId,
        employeeId,
        reminderType: "in_app",
        acknowledged: false,
      })
      .onConflictDoNothing();
  }

  res.json(notifications);
});

// ── PATCH /api/calendar/notifications/:id/acknowledge ─────────────────────────

router.patch("/calendar/notifications/:id/acknowledge", requireEmployeeAuth, async (req, res): Promise<void> => {
  const id = Number(String(req.params["id"]));

  await db
    .update(calendarRemindersSentTable)
    .set({ acknowledged: true })
    .where(eq(calendarRemindersSentTable.id, id));

  res.json({ success: true });
});

export default router;
