import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  calendarEventsTable,
  calendarEventAttendeesTable,
  calendarRecurringRulesTable,
  calendarNotificationsQueueTable,
  calendarRemindersSentTable,
  deadlinesTable,
  projectTasksTable,
} from "@workspace/db";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import { requireEmployeeAuth } from "../middlewares/authMiddleware";

const router: IRouter = Router();

const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";

// ── Schemas ────────────────────────────────────────────────────────────────────

const attendeeSchema = z.object({
  employeeId: z.string().uuid().optional(),
  employeeName: z.string().min(1),
  email: z.string().email().optional(),
});

const recurringRuleSchema = z.object({
  frequency: z.enum(["daily", "weekly", "biweekly", "monthly", "yearly"]),
  interval: z.number().int().min(1).optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  endDate: z.string().optional(),
  occurrences: z.number().int().min(1).optional(),
});

const createEventSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  eventType: z.enum(["meeting", "deadline", "shoot", "recording", "delivery", "call", "task", "milestone", "personal", "other"]),
  startDate: z.string().min(1),
  endDate: z.string().optional(),
  allDay: z.boolean().optional(),
  location: z.string().optional(),
  meetingLink: z.string().optional(),
  projectId: z.number().int().optional(),
  projectName: z.string().optional(),
  taskId: z.number().int().optional(),
  deadlineId: z.number().int().optional(),
  clientId: z.number().int().optional(),
  clientName: z.string().optional(),
  crmLeadId: z.number().int().optional(),
  color: z.string().optional(),
  reminderEnabled: z.boolean().optional(),
  reminderMinutes: z.number().int().min(0).optional(),
  attendees: z.array(attendeeSchema).optional(),
  recurringRule: recurringRuleSchema.optional(),
});

const patchEventSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  allDay: z.boolean().optional(),
  location: z.string().optional(),
  meetingLink: z.string().optional(),
  status: z.enum(["scheduled", "completed", "cancelled", "rescheduled"]).optional(),
  color: z.string().optional(),
  reminderEnabled: z.boolean().optional(),
  reminderMinutes: z.number().int().min(0).optional(),
});

// ── Helpers ────────────────────────────────────────────────────────────────────

async function getEventWithAttendees(id: number, tenantId: string) {
  const [event] = await db
    .select()
    .from(calendarEventsTable)
    .where(and(eq(calendarEventsTable.id, id), eq(calendarEventsTable.tenantId, tenantId as any)));
  if (!event) return null;

  const attendees = await db
    .select()
    .from(calendarEventAttendeesTable)
    .where(eq(calendarEventAttendeesTable.eventId, id));

  const [rule] = await db
    .select()
    .from(calendarRecurringRulesTable)
    .where(eq(calendarRecurringRulesTable.eventId, id));

  return { ...event, attendees, recurringRule: rule ?? null };
}

async function scheduleNotifications(
  eventId: number,
  startDate: Date,
  reminderMinutes: number,
  attendees: Array<{ employeeId?: string | null | undefined }>,
) {
  const scheduled = new Date(startDate.getTime() - reminderMinutes * 60 * 1000);
  const rows = attendees
    .filter((a) => a.employeeId)
    .map((a) => ({
      eventId,
      employeeId: a.employeeId as string,
      notificationType: "in_app" as const,
      scheduledFor: scheduled,
    }));
  if (rows.length > 0) {
    await db.insert(calendarNotificationsQueueTable).values(rows);
  }
}

// ── GET /api/calendar/events ───────────────────────────────────────────────────

router.get("/calendar/events", requireEmployeeAuth, async (req, res): Promise<void> => {
  const session = (req as any).session;
  const tenantId = session.tenantId ?? DEFAULT_TENANT;
  const { startDate, endDate, employeeId, projectId, eventType } = req.query as Record<string, string>;

  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;

  const conditions: any[] = [eq(calendarEventsTable.tenantId, tenantId)];
  if (start) conditions.push(gte(calendarEventsTable.startDate, start));
  if (end) conditions.push(lte(calendarEventsTable.startDate, end));
  if (eventType) conditions.push(eq(calendarEventsTable.eventType, eventType as any));
  if (projectId) conditions.push(eq(calendarEventsTable.projectId, Number(projectId)));

  let events = await db
    .select()
    .from(calendarEventsTable)
    .where(and(...conditions))
    .orderBy(calendarEventsTable.startDate);

  if (employeeId) {
    const attendeeRows = await db
      .select()
      .from(calendarEventAttendeesTable)
      .where(eq(calendarEventAttendeesTable.employeeId, employeeId));
    const attendeeEventIds = new Set(attendeeRows.map((a) => a.eventId));
    events = events.filter((e) => attendeeEventIds.has(e.id));
  }

  const eventIds = events.map((e) => e.id);
  const allAttendees =
    eventIds.length > 0
      ? await db
          .select()
          .from(calendarEventAttendeesTable)
          .where(inArray(calendarEventAttendeesTable.eventId, eventIds))
      : [];

  const attendeeMap: Record<number, typeof allAttendees> = {};
  for (const a of allAttendees) {
    if (!attendeeMap[a.eventId]) attendeeMap[a.eventId] = [];
    attendeeMap[a.eventId]!.push(a);
  }

  res.json(events.map((e) => ({ ...e, attendees: attendeeMap[e.id] ?? [] })));
});

// ── GET /api/calendar/upcoming ─────────────────────────────────────────────────

router.get("/calendar/upcoming", requireEmployeeAuth, async (req, res): Promise<void> => {
  const session = (req as any).session;
  const tenantId = session.tenantId ?? DEFAULT_TENANT;
  const employeeId: string | undefined = session.employeeId;

  const now = new Date();
  const plus7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const events = await db
    .select()
    .from(calendarEventsTable)
    .where(
      and(
        eq(calendarEventsTable.tenantId, tenantId),
        eq(calendarEventsTable.status, "scheduled"),
        gte(calendarEventsTable.startDate, now),
        lte(calendarEventsTable.startDate, plus7),
      ),
    )
    .orderBy(calendarEventsTable.startDate);

  if (!employeeId) {
    res.json(events);
    return;
  }

  const attendeeRows = await db
    .select()
    .from(calendarEventAttendeesTable)
    .where(eq(calendarEventAttendeesTable.employeeId, employeeId));
  const attendeeEventIds = new Set(attendeeRows.map((a) => a.eventId));

  res.json(events.filter((e) => attendeeEventIds.has(e.id)));
});

// ── GET /api/calendar/events/:id ──────────────────────────────────────────────

router.get("/calendar/events/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const session = (req as any).session;
  const tenantId = session.tenantId ?? DEFAULT_TENANT;
  const id = Number(String(req.params["id"]));

  const event = await getEventWithAttendees(id, tenantId);
  if (!event) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  res.json(event);
});

// ── POST /api/calendar/events ─────────────────────────────────────────────────

router.post("/calendar/events", requireEmployeeAuth, async (req, res): Promise<void> => {
  const session = (req as any).session;
  const tenantId = session.tenantId ?? DEFAULT_TENANT;
  const employeeId: string | undefined = session.employeeId;
  const employeeName: string = session.employeeName ?? "Team Member";

  const parsed = createEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }

  const body = parsed.data;
  const startDate = new Date(body.startDate);

  const [created] = await db
    .insert(calendarEventsTable)
    .values({
      tenantId: tenantId as any,
      title: body.title,
      description: body.description,
      eventType: body.eventType,
      startDate,
      endDate: body.endDate ? new Date(body.endDate) : undefined,
      allDay: body.allDay ?? false,
      location: body.location,
      meetingLink: body.meetingLink,
      projectId: body.projectId,
      projectName: body.projectName,
      taskId: body.taskId,
      deadlineId: body.deadlineId,
      clientId: body.clientId,
      clientName: body.clientName,
      crmLeadId: body.crmLeadId,
      color: body.color,
      reminderEnabled: body.reminderEnabled ?? true,
      reminderMinutes: body.reminderMinutes ?? 60,
      createdBy: employeeId as any,
      createdByName: employeeName,
    })
    .returning();

  const attendeesList = body.attendees ?? [];
  const organizerIncluded = attendeesList.some((a) => a.employeeId === employeeId);
  const finalAttendees = organizerIncluded
    ? attendeesList
    : [{ employeeId, employeeName, email: session.email as string | undefined }, ...attendeesList];

  if (finalAttendees.length > 0) {
    await db.insert(calendarEventAttendeesTable).values(
      finalAttendees.map((a, i) => ({
        eventId: created.id,
        employeeId: a.employeeId as any,
        employeeName: a.employeeName,
        email: a.email,
        isOrganizer: !organizerIncluded && i === 0 ? true : a.employeeId === employeeId,
        status: "invited" as const,
      })),
    );
  }

  if (body.recurringRule) {
    const rule = body.recurringRule;
    await db.insert(calendarRecurringRulesTable).values({
      eventId: created.id,
      frequency: rule.frequency,
      interval: rule.interval ?? 1,
      daysOfWeek: rule.daysOfWeek,
      dayOfMonth: rule.dayOfMonth,
      endDate: rule.endDate ? new Date(rule.endDate) : undefined,
      occurrences: rule.occurrences,
    });
  }

  if (created.reminderEnabled) {
    await scheduleNotifications(created.id, startDate, created.reminderMinutes, finalAttendees);
  }

  const full = await getEventWithAttendees(created.id, tenantId);
  res.status(201).json(full);
});

// ── PATCH /api/calendar/events/:id ────────────────────────────────────────────

router.patch("/calendar/events/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const session = (req as any).session;
  const tenantId = session.tenantId ?? DEFAULT_TENANT;
  const id = Number(String(req.params["id"]));

  const parsed = patchEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }

  const existing = await getEventWithAttendees(id, tenantId);
  if (!existing) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const body = parsed.data;
  const updates: Record<string, any> = {};
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.startDate !== undefined) updates.startDate = new Date(body.startDate);
  if (body.endDate !== undefined) updates.endDate = new Date(body.endDate);
  if (body.allDay !== undefined) updates.allDay = body.allDay;
  if (body.location !== undefined) updates.location = body.location;
  if (body.meetingLink !== undefined) updates.meetingLink = body.meetingLink;
  if (body.status !== undefined) updates.status = body.status;
  if (body.color !== undefined) updates.color = body.color;
  if (body.reminderEnabled !== undefined) updates.reminderEnabled = body.reminderEnabled;
  if (body.reminderMinutes !== undefined) updates.reminderMinutes = body.reminderMinutes;

  if (body.startDate && existing.reminderEnabled) {
    await db
      .update(calendarNotificationsQueueTable)
      .set({ status: "failed" })
      .where(
        and(
          eq(calendarNotificationsQueueTable.eventId, id),
          eq(calendarNotificationsQueueTable.status, "pending"),
        ),
      );
    const newStart = new Date(body.startDate);
    const minutes = body.reminderMinutes ?? existing.reminderMinutes;
    await scheduleNotifications(id, newStart, minutes, existing.attendees);
  }

  const [updated] = await db
    .update(calendarEventsTable)
    .set(updates)
    .where(and(eq(calendarEventsTable.id, id), eq(calendarEventsTable.tenantId, tenantId as any)))
    .returning();

  res.json(updated);
});

// ── DELETE /api/calendar/events/:id ───────────────────────────────────────────

router.delete("/calendar/events/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const session = (req as any).session;
  const tenantId = session.tenantId ?? DEFAULT_TENANT;
  const id = Number(String(req.params["id"]));

  await db
    .update(calendarEventsTable)
    .set({ status: "cancelled" })
    .where(and(eq(calendarEventsTable.id, id), eq(calendarEventsTable.tenantId, tenantId as any)));

  await db
    .update(calendarNotificationsQueueTable)
    .set({ status: "failed" })
    .where(
      and(
        eq(calendarNotificationsQueueTable.eventId, id),
        eq(calendarNotificationsQueueTable.status, "pending"),
      ),
    );

  res.json({ success: true });
});

// ── POST /api/calendar/events/:id/attendees ───────────────────────────────────

router.post("/calendar/events/:id/attendees", requireEmployeeAuth, async (req, res): Promise<void> => {
  const session = (req as any).session;
  const tenantId = session.tenantId ?? DEFAULT_TENANT;
  const id = Number(String(req.params["id"]));

  const parsed = z.object({ attendees: z.array(attendeeSchema).min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }

  const existing = await getEventWithAttendees(id, tenantId);
  if (!existing) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  await db.insert(calendarEventAttendeesTable).values(
    parsed.data.attendees.map((a) => ({
      eventId: id,
      employeeId: a.employeeId as any,
      employeeName: a.employeeName,
      email: a.email,
      status: "invited" as const,
    })),
  );

  if (existing.reminderEnabled) {
    await scheduleNotifications(id, existing.startDate, existing.reminderMinutes, parsed.data.attendees);
  }

  const attendees = await db
    .select()
    .from(calendarEventAttendeesTable)
    .where(eq(calendarEventAttendeesTable.eventId, id));

  res.json(attendees);
});

// ── PATCH /api/calendar/events/:id/attendees/:attendeeId ─────────────────────

router.patch("/calendar/events/:id/attendees/:attendeeId", requireEmployeeAuth, async (req, res): Promise<void> => {
  const attendeeId = Number(String(req.params["attendeeId"]));

  const parsed = z.object({ status: z.enum(["accepted", "declined", "tentative"]) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }

  const [updated] = await db
    .update(calendarEventAttendeesTable)
    .set({ status: parsed.data.status, respondedAt: new Date() })
    .where(eq(calendarEventAttendeesTable.id, attendeeId))
    .returning();

  res.json(updated);
});

// ── POST /api/calendar/events/sync-deadlines ──────────────────────────────────

router.post("/calendar/events/sync-deadlines", requireEmployeeAuth, async (req, res): Promise<void> => {
  const session = (req as any).session;
  const tenantId = session.tenantId ?? DEFAULT_TENANT;

  const todayStr = new Date().toISOString().split("T")[0]!;

  const allDeadlines = await db
    .select()
    .from(deadlinesTable)
    .where(eq(deadlinesTable.tenantId, tenantId as any));

  const upcomingDeadlines = allDeadlines.filter((d) => d.dueDate >= todayStr);

  const existingEvents = await db
    .select({ deadlineId: calendarEventsTable.deadlineId })
    .from(calendarEventsTable)
    .where(eq(calendarEventsTable.tenantId, tenantId as any));
  const syncedDeadlineIds = new Set(existingEvents.map((e) => e.deadlineId).filter(Boolean));

  let synced = 0;
  for (const d of upcomingDeadlines) {
    if (syncedDeadlineIds.has(d.id)) continue;
    await db.insert(calendarEventsTable).values({
      tenantId: tenantId as any,
      title: d.title,
      description: d.description ?? undefined,
      eventType: "deadline",
      startDate: new Date(d.dueDate),
      deadlineId: d.id,
      projectId: d.projectId ?? undefined,
      color: "#ef4444",
    });
    synced++;
  }

  res.json({ synced });
});

// ── POST /api/calendar/events/sync-tasks ──────────────────────────────────────

router.post("/calendar/events/sync-tasks", requireEmployeeAuth, async (req, res): Promise<void> => {
  const session = (req as any).session;
  const tenantId = session.tenantId ?? DEFAULT_TENANT;

  const todayStr = new Date().toISOString().split("T")[0]!;

  const allTasks = await db
    .select()
    .from(projectTasksTable)
    .where(eq(projectTasksTable.tenantId, tenantId as any));

  const upcomingTasks = allTasks.filter(
    (t) => t.dueDate && (t.dueDate as string) >= todayStr && t.status !== "done",
  );

  const existingEvents = await db
    .select({ taskId: calendarEventsTable.taskId })
    .from(calendarEventsTable)
    .where(eq(calendarEventsTable.tenantId, tenantId as any));
  const syncedTaskIds = new Set(existingEvents.map((e) => e.taskId).filter(Boolean));

  let synced = 0;
  for (const t of upcomingTasks) {
    if (syncedTaskIds.has(t.id)) continue;
    await db.insert(calendarEventsTable).values({
      tenantId: tenantId as any,
      title: t.title,
      description: t.description ?? undefined,
      eventType: "task",
      startDate: new Date(t.dueDate as string),
      taskId: t.id,
      projectId: t.projectId ?? undefined,
      color: "#f59e0b",
    });
    synced++;
  }

  res.json({ synced });
});

export default router;
