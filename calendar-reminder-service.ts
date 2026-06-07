import { db } from "@workspace/db";
import {
  calendarNotificationsQueueTable,
  calendarEventsTable,
  calendarRemindersSentTable,
  userCalendarSettingsTable,
  calendarEventAttendeesTable,
  employeeAccounts,
} from "@workspace/db";
import { eq, and, lte, gte, inArray } from "drizzle-orm";
import { createAnettaTransport } from "../lib/anetta-email";
import { logger } from "../lib/logger";

const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";

// ── processCalendarReminders ───────────────────────────────────────────────────

export async function processCalendarReminders(): Promise<{
  processed: number;
  sent: number;
  failed: number;
}> {
  const now = new Date();

  const pending = await db
    .select({
      id: calendarNotificationsQueueTable.id,
      eventId: calendarNotificationsQueueTable.eventId,
      employeeId: calendarNotificationsQueueTable.employeeId,
      notificationType: calendarNotificationsQueueTable.notificationType,
    })
    .from(calendarNotificationsQueueTable)
    .where(
      and(
        eq(calendarNotificationsQueueTable.status, "pending"),
        lte(calendarNotificationsQueueTable.scheduledFor, now),
      ),
    )
    .limit(200);

  if (pending.length === 0) return { processed: 0, sent: 0, failed: 0 };

  const eventIds = [...new Set(pending.map((p) => p.eventId))];
  const events = await db
    .select()
    .from(calendarEventsTable)
    .where(inArray(calendarEventsTable.id, eventIds));
  const eventMap = Object.fromEntries(events.map((e) => [e.id, e]));

  const employeeIds = [...new Set(pending.map((p) => p.employeeId))];
  const employees = await db
    .select({ id: employeeAccounts.id, name: employeeAccounts.name, email: employeeAccounts.email })
    .from(employeeAccounts)
    .where(inArray(employeeAccounts.id, employeeIds));
  const employeeMap = Object.fromEntries(employees.map((e) => [e.id, e]));

  let sent = 0;
  let failed = 0;

  for (const notif of pending) {
    const event = eventMap[notif.eventId];
    const employee = employeeMap[notif.employeeId];
    if (!event || !employee) {
      await db
        .update(calendarNotificationsQueueTable)
        .set({ status: "failed", sentAt: now, errorMessage: "Event or employee not found" })
        .where(eq(calendarNotificationsQueueTable.id, notif.id));
      failed++;
      continue;
    }

    try {
      const minutesUntil = Math.round((event.startDate.getTime() - Date.now()) / 60000);
      const timeLabel =
        minutesUntil <= 1
          ? "now"
          : minutesUntil < 60
          ? `in ${minutesUntil} minutes`
          : minutesUntil < 120
          ? "in 1 hour"
          : `in ${Math.round(minutesUntil / 60)} hours`;

      if (notif.notificationType === "email" && employee.email) {
        const transport = createAnettaTransport();
        if (transport) {
          await transport.sendMail({
            from: '"Accelerated Experiences" <Anettax@aexperiences.studio>',
            to: employee.email,
            subject: `Reminder: ${event.title} starts ${timeLabel}`,
            html: buildReminderEmail(event, employee.name, timeLabel),
          });
        }
      }

      await db
        .update(calendarNotificationsQueueTable)
        .set({ status: "sent", sentAt: now })
        .where(eq(calendarNotificationsQueueTable.id, notif.id));

      await db.insert(calendarRemindersSentTable).values({
        eventId: notif.eventId,
        employeeId: notif.employeeId,
        reminderType: notif.notificationType,
      });

      sent++;
    } catch (err: any) {
      logger.error({ err, notifId: notif.id }, "Calendar reminder send failed");
      await db
        .update(calendarNotificationsQueueTable)
        .set({ status: "failed", sentAt: now, errorMessage: err?.message ?? "unknown" })
        .where(eq(calendarNotificationsQueueTable.id, notif.id));
      failed++;
    }
  }

  return { processed: pending.length, sent, failed };
}

// ── sendDailyDigests ───────────────────────────────────────────────────────────

export async function sendDailyDigests(): Promise<{ sent: number }> {
  const settings = await db
    .select()
    .from(userCalendarSettingsTable)
    .where(eq(userCalendarSettingsTable.dailyDigestEnabled, true));

  const transport = createAnettaTransport();
  if (!transport) {
    logger.info("Calendar daily digest skipped — SMTP not configured");
    return { sent: 0 };
  }

  let sent = 0;
  const now = new Date();

  for (const s of settings) {
    try {
      const [hh, mm] = (s.dailyDigestTime ?? "08:00").split(":").map(Number);
      const currentHour = now.getUTCHours();
      const currentMin = now.getUTCMinutes();
      if (Math.abs(currentHour * 60 + currentMin - (hh * 60 + mm)) > 30) continue;

      const [employee] = await db
        .select({ id: employeeAccounts.id, name: employeeAccounts.name, email: employeeAccounts.email })
        .from(employeeAccounts)
        .where(eq(employeeAccounts.id, s.employeeId));

      if (!employee?.email) continue;

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const tomorrowEnd = new Date(todayStart.getTime() + 2 * 24 * 60 * 60 * 1000);

      const attendeeRows = await db
        .select({ eventId: calendarEventAttendeesTable.eventId })
        .from(calendarEventAttendeesTable)
        .where(eq(calendarEventAttendeesTable.employeeId, s.employeeId));
      const eventIds = attendeeRows.map((r) => r.eventId);

      if (eventIds.length === 0) continue;

      const events = await db
        .select()
        .from(calendarEventsTable)
        .where(
          and(
            inArray(calendarEventsTable.id, eventIds),
            eq(calendarEventsTable.status, "scheduled"),
            gte(calendarEventsTable.startDate, todayStart),
            lte(calendarEventsTable.startDate, tomorrowEnd),
          ),
        )
        .orderBy(calendarEventsTable.startDate);

      if (events.length === 0) continue;

      await transport.sendMail({
        from: '"Accelerated Experiences" <Anettax@aexperiences.studio>',
        to: employee.email,
        subject: `Your schedule for ${todayStart.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`,
        html: buildDailyDigestEmail(employee.name, events),
      });

      sent++;
    } catch (err: any) {
      logger.error({ err, employeeId: s.employeeId }, "Daily digest send failed");
    }
  }

  return { sent };
}

// ── Email builders ─────────────────────────────────────────────────────────────

function buildReminderEmail(event: { title: string; startDate: Date; location?: string | null; meetingLink?: string | null; eventType: string }, employeeName: string, timeLabel: string): string {
  const time = event.startDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  const date = event.startDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
  <div style="background:linear-gradient(135deg,#0ea5e9,#1d4ed8);padding:24px 28px;">
    <div style="font-size:13px;font-weight:600;color:rgba(255,255,255,0.8);text-transform:uppercase;letter-spacing:0.05em;">Calendar Reminder</div>
    <div style="font-size:22px;font-weight:700;color:#fff;margin-top:4px;">${event.title}</div>
    <div style="font-size:14px;color:rgba(255,255,255,0.9);margin-top:6px;">Starts ${timeLabel}</div>
  </div>
  <div style="padding:24px 28px;">
    <p style="margin:0 0 16px;color:#374151;">Hi ${employeeName},</p>
    <p style="margin:0 0 20px;color:#374151;">This is a reminder that <strong>${event.title}</strong> is coming up ${timeLabel}.</p>
    <table style="width:100%;border-collapse:collapse;">
      <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;width:80px;">When</td><td style="padding:8px 0;color:#111827;font-size:13px;">${date} at ${time}</td></tr>
      ${event.location ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Where</td><td style="padding:8px 0;color:#111827;font-size:13px;">${event.location}</td></tr>` : ""}
      ${event.meetingLink ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Join</td><td style="padding:8px 0;font-size:13px;"><a href="${event.meetingLink}" style="color:#0ea5e9;">Join meeting</a></td></tr>` : ""}
    </table>
  </div>
  <div style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#9ca3af;">Accelerated Experiences — Calendar System</div>
</div>`;
}

function buildDailyDigestEmail(employeeName: string, events: Array<{ title: string; startDate: Date; endDate?: Date | null; location?: string | null; eventType: string }>): string {
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

  const todayEvents = events.filter((e) => e.startDate.toDateString() === today.toDateString());
  const tomorrowEvents = events.filter((e) => e.startDate.toDateString() === tomorrow.toDateString());

  const renderEvent = (e: typeof events[0]) => {
    const time = e.startDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    return `<div style="padding:10px 12px;border-left:3px solid #0ea5e9;margin-bottom:8px;background:#f8fafc;border-radius:0 6px 6px 0;">
      <div style="font-weight:600;color:#111827;font-size:14px;">${e.title}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:2px;">${time}${e.location ? ` · ${e.location}` : ""}</div>
    </div>`;
  };

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
  <div style="background:linear-gradient(135deg,#0a1e3d,#0ea5e9);padding:24px 28px;">
    <div style="font-size:13px;font-weight:600;color:rgba(255,255,255,0.8);text-transform:uppercase;letter-spacing:0.05em;">Daily Schedule</div>
    <div style="font-size:22px;font-weight:700;color:#fff;margin-top:4px;">${today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</div>
  </div>
  <div style="padding:24px 28px;">
    <p style="margin:0 0 20px;color:#374151;">Good morning, ${employeeName}. Here's what's on your calendar.</p>
    ${todayEvents.length > 0 ? `<div style="font-weight:600;color:#111827;margin-bottom:10px;">Today (${todayEvents.length} event${todayEvents.length !== 1 ? "s" : ""})</div>${todayEvents.map(renderEvent).join("")}` : `<p style="color:#6b7280;font-size:14px;">No events today.</p>`}
    ${tomorrowEvents.length > 0 ? `<div style="font-weight:600;color:#111827;margin:20px 0 10px;">Tomorrow</div>${tomorrowEvents.map(renderEvent).join("")}` : ""}
  </div>
  <div style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#9ca3af;">Accelerated Experiences — Calendar System</div>
</div>`;
}
