import { Router, type IRouter } from "express";
import { eq, and, ne, desc, or, asc, sql } from "drizzle-orm";
import { db, emailsTable } from "@workspace/db";
import { requireAdminAuth, getTenantId } from "../middlewares/authMiddleware";
import { sendAnettaEmail, isAnettaEmailConfigured } from "../lib/anetta-email";
import { sendAnthonyEmail, isAnthonyEmailConfigured } from "../lib/anthony-email";
import { pollInbox } from "../lib/imap-poller";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── GET /api/email/stats ──────────────────────────────────────────────────────
router.get("/email/stats", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const rows = await db.select()
    .from(emailsTable)
    .where(and(
      eq(emailsTable.tenantId, tid as any),
      eq(emailsTable.direction, "inbound"),
      eq(emailsTable.status, "unread"),
    ));
  res.json({ unread: rows.length });
});

// ── GET /api/email/inbox ──────────────────────────────────────────────────────
// Returns threads (grouped) for inbox / sent / archived / starred
router.get("/email/inbox", requireAdminAuth, async (req, res): Promise<void> => {
  const tid    = getTenantId(req);
  const folder = (req.query.folder as string) ?? "inbox";

  let emails;
  if (folder === "sent") {
    emails = await db.select().from(emailsTable)
      .where(and(eq(emailsTable.tenantId, tid as any), eq(emailsTable.direction, "outbound")))
      .orderBy(desc(emailsTable.createdAt));
  } else if (folder === "archived") {
    emails = await db.select().from(emailsTable)
      .where(and(eq(emailsTable.tenantId, tid as any), eq(emailsTable.status, "archived")))
      .orderBy(desc(emailsTable.receivedAt));
  } else if (folder === "starred") {
    emails = await db.select().from(emailsTable)
      .where(and(eq(emailsTable.tenantId, tid as any), eq(emailsTable.isStarred, true)))
      .orderBy(desc(emailsTable.receivedAt));
  } else {
    // inbox: inbound, not archived
    emails = await db.select().from(emailsTable)
      .where(and(
        eq(emailsTable.tenantId, tid as any),
        eq(emailsTable.direction, "inbound"),
        ne(emailsTable.status, "archived"),
      ))
      .orderBy(desc(emailsTable.receivedAt));
  }

  // Group by threadId
  const threadMap = new Map<string, {
    threadId: string;
    latest: typeof emails[0];
    count: number;
    unread: number;
    isStarred: boolean;
  }>();

  for (const email of emails) {
    const key = email.threadId ?? email.messageId ?? String(email.id);
    if (!threadMap.has(key)) {
      threadMap.set(key, { threadId: key, latest: email, count: 0, unread: 0, isStarred: false });
    }
    const t = threadMap.get(key)!;
    t.count++;
    if (email.status === "unread") t.unread++;
    if (email.isStarred) t.isStarred = true;
    const latestTime = t.latest.receivedAt?.getTime() ?? t.latest.createdAt.getTime();
    const emailTime  = email.receivedAt?.getTime() ?? email.createdAt.getTime();
    if (emailTime > latestTime) t.latest = email;
  }

  const threads = [...threadMap.values()]
    .sort((a, b) => {
      const at = a.latest.receivedAt?.getTime() ?? a.latest.createdAt.getTime();
      const bt = b.latest.receivedAt?.getTime() ?? b.latest.createdAt.getTime();
      return bt - at;
    });

  res.json(threads);
});

// ── GET /api/email/thread/:threadId ──────────────────────────────────────────
router.get("/email/thread/:threadId", requireAdminAuth, async (req, res): Promise<void> => {
  const tid      = getTenantId(req);
  const threadId = req.params.threadId;

  const emails = await db.select().from(emailsTable)
    .where(and(
      eq(emailsTable.tenantId, tid as any),
      sql`(${emailsTable.threadId} = ${threadId} OR ${emailsTable.messageId} = ${threadId})`,
    ))
    .orderBy(asc(emailsTable.receivedAt), asc(emailsTable.createdAt));

  // Mark all unread as read
  await db.update(emailsTable)
    .set({ status: "read" })
    .where(and(
      eq(emailsTable.tenantId, tid as any),
      sql`(${emailsTable.threadId} = ${threadId} OR ${emailsTable.messageId} = ${threadId})`,
      eq(emailsTable.status, "unread"),
    ));

  res.json(emails);
});

// ── POST /api/email/:id/archive ───────────────────────────────────────────────
router.post("/email/:id/archive", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id  = Number(req.params.id);
  const [e] = await db.select().from(emailsTable)
    .where(and(eq(emailsTable.id, id), eq(emailsTable.tenantId, tid as any)));
  if (!e) { res.status(404).json({ error: "Not found" }); return; }
  const newStatus = e.status === "archived" ? "read" : "archived";
  await db.update(emailsTable).set({ status: newStatus }).where(eq(emailsTable.id, id));
  res.json({ success: true, status: newStatus });
});

// ── POST /api/email/:id/star ──────────────────────────────────────────────────
router.post("/email/:id/star", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id  = Number(req.params.id);
  const [e] = await db.select().from(emailsTable)
    .where(and(eq(emailsTable.id, id), eq(emailsTable.tenantId, tid as any)));
  if (!e) { res.status(404).json({ error: "Not found" }); return; }
  await db.update(emailsTable).set({ isStarred: !e.isStarred }).where(eq(emailsTable.id, id));
  res.json({ success: true, isStarred: !e.isStarred });
});

// ── PUT /api/email/:id/link ───────────────────────────────────────────────────
router.put("/email/:id/link", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id  = Number(req.params.id);
  const { crmLeadId, clientId, projectId } = req.body as {
    crmLeadId?: number | null;
    clientId?: number | null;
    projectId?: number | null;
  };
  await db.update(emailsTable).set({
    crmLeadId: crmLeadId ?? null,
    clientId:  clientId  ?? null,
    projectId: projectId ?? null,
  }).where(and(eq(emailsTable.id, id), eq(emailsTable.tenantId, tid as any)));
  res.json({ success: true });
});

// ── POST /api/email/send ──────────────────────────────────────────────────────
// Compose and send a new email directly (manual compose, no approval needed)
router.post("/email/send", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const { to, cc, subject, body } = req.body as {
    to: string; cc?: string; subject: string; body: string;
  };
  if (!to || !subject || !body) {
    res.status(400).json({ error: "to, subject, and body are required" }); return;
  }

  const toList = to.split(",").map(e => e.trim()).filter(Boolean);
  const ccList = cc ? cc.split(",").map(e => e.trim()).filter(Boolean) : [];
  const msgId  = `<${Date.now()}.${Math.random().toString(36).slice(2)}@aexperiences.studio>`;

  const fromAddress = isAnthonyEmailConfigured()
    ? "anthonye@aexperiences.studio"
    : "Anettax@aexperiences.studio";
  const fromName = isAnthonyEmailConfigured()
    ? "Anthony Esposito — Accelerated Experiences"
    : "Accelerated Experiences";

  // Store in emails table first
  await db.insert(emailsTable).values({
    tenantId:    tid as any,
    messageId:   msgId,
    threadId:    msgId,
    direction:   "outbound",
    fromAddress,
    fromName,
    toAddresses: to,
    ccAddresses: cc ?? null,
    subject,
    bodyText:    body,
    bodyHtml:    body.replace(/\n/g, "<br>"),
    status:      "read",
    receivedAt:  new Date(),
  });

  if (isAnthonyEmailConfigured()) {
    const result = await sendAnthonyEmail({ to: toList, cc: ccList.length > 0 ? ccList : undefined, subject, bodyText: body });
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: result.error ?? "Send failed" });
    }
    return;
  }

  if (!isAnettaEmailConfigured()) {
    res.json({ success: false, smtpMissing: true, message: "Email stored but SMTP not configured." });
    return;
  }

  const result = await sendAnettaEmail({ to: toList, cc: ccList.length > 0 ? ccList : undefined, subject, bodyText: body, inReplyTo: undefined });
  if (result.success) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: result.error ?? "Send failed" });
  }
});

// ── POST /api/email/:id/reply ─────────────────────────────────────────────────
router.post("/email/:id/reply", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id  = Number(req.params.id);
  const { body, cc } = req.body as { body: string; cc?: string };

  const [original] = await db.select().from(emailsTable)
    .where(and(eq(emailsTable.id, id), eq(emailsTable.tenantId, tid as any)));
  if (!original) { res.status(404).json({ error: "Original email not found" }); return; }

  const replyTo   = original.fromAddress;
  const subject   = original.subject.startsWith("Re:") ? original.subject : `Re: ${original.subject}`;
  const threadId  = original.threadId ?? original.messageId ?? String(original.id);
  const msgId     = `<${Date.now()}.${Math.random().toString(36).slice(2)}@aexperiences.studio>`;
  const ccList    = cc ? cc.split(",").map(e => e.trim()).filter(Boolean) : [];

  const replyFromAddress = isAnthonyEmailConfigured()
    ? "anthonye@aexperiences.studio"
    : "Anettax@aexperiences.studio";
  const replyFromName = isAnthonyEmailConfigured()
    ? "Anthony Esposito — Accelerated Experiences"
    : "Accelerated Experiences";

  await db.insert(emailsTable).values({
    tenantId:    tid as any,
    messageId:   msgId,
    threadId,
    inReplyTo:   original.messageId ?? undefined,
    direction:   "outbound",
    fromAddress: replyFromAddress,
    fromName:    replyFromName,
    toAddresses: replyTo,
    ccAddresses: cc ?? null,
    subject,
    bodyText:    body,
    bodyHtml:    body.replace(/\n/g, "<br>"),
    status:      "read",
    receivedAt:  new Date(),
  });

  if (isAnthonyEmailConfigured()) {
    const result = await sendAnthonyEmail({
      to:         [replyTo],
      cc:         ccList.length > 0 ? ccList : undefined,
      subject,
      bodyText:   body,
      inReplyTo:  original.messageId ?? undefined,
      references: original.messageId ?? undefined,
    });
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: result.error ?? "Send failed" });
    }
    return;
  }

  if (!isAnettaEmailConfigured()) {
    res.json({ success: false, smtpMissing: true, message: "Reply stored but SMTP not configured." });
    return;
  }

  const result = await sendAnettaEmail({
    to:         [replyTo],
    cc:         ccList.length > 0 ? ccList : undefined,
    subject,
    bodyText:   body,
    inReplyTo:  original.messageId ?? undefined,
    references: original.messageId ?? undefined,
  });

  if (result.success) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: result.error ?? "Send failed" });
  }
});

// ── POST /api/email/poll ──────────────────────────────────────────────────────
// Manually trigger an IMAP poll
router.post("/email/poll", requireAdminAuth, async (req, res): Promise<void> => {
  const result = await pollInbox();
  logger.info(result, "Manual IMAP poll triggered");
  res.json({ success: true, ...result });
});

export default router;
