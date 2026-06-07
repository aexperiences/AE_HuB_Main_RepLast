import { Router } from "express";
import { eq, inArray, and } from "drizzle-orm";
import {
  db,
  emailDraftsTable,
  deliverablesTable,
  grantProposalsTable,
  invoicesTable,
  proposalsTable,
  contractsTable,
} from "@workspace/db";
import {
  requireAdminAuth,
  getTenantId,
  getSession,
} from "../middlewares/authMiddleware";
import { sendAnettaEmail, isAnettaEmailConfigured } from "../lib/anetta-email";
import { logger } from "../lib/logger";

const router = Router();

export interface ApprovalItem {
  id: number;
  type: "email" | "deliverable" | "grant" | "invoice" | "proposal" | "contract";
  title: string;
  subtitle: string;
  status: string;
  createdAt: string;
  // email-only preview fields
  body?: string;
  bodyHtml?: string;
  toAddresses?: string;
  fromAgent?: string;
  contextNote?: string;
}

// ── GET /api/approvals/count ──────────────────────────────────────────────────
router.get("/approvals/count", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    const tid = getTenantId(req);
    const [emails, delivs, grants, invs, props, cons] = await Promise.all([
      db.select({ id: emailDraftsTable.id }).from(emailDraftsTable)
        .where(and(eq(emailDraftsTable.status, "pending_approval"), eq(emailDraftsTable.tenantId, tid as any))),
      db.select({ id: deliverablesTable.id }).from(deliverablesTable)
        .where(and(inArray(deliverablesTable.status, ["pending_review", "pending_approval", "pm_review"]), eq(deliverablesTable.tenantId, tid as any))),
      db.select({ id: grantProposalsTable.id }).from(grantProposalsTable)
        .where(and(inArray(grantProposalsTable.status as any, ["plan_pending", "pending"]), eq(grantProposalsTable.tenantId as any, tid))),
      db.select({ id: invoicesTable.id }).from(invoicesTable)
        .where(and(eq(invoicesTable.status, "draft"), eq(invoicesTable.tenantId, tid as any))),
      db.select({ id: proposalsTable.id }).from(proposalsTable)
        .where(and(eq(proposalsTable.status, "draft"), eq(proposalsTable.tenantId, tid as any))),
      db.select({ id: contractsTable.id }).from(contractsTable)
        .where(and(eq(contractsTable.status, "draft"), eq(contractsTable.tenantId, tid as any))),
    ]);
    res.json({
      count: emails.length + delivs.length + grants.length + invs.length + props.length + cons.length,
      breakdown: {
        email: emails.length,
        deliverable: delivs.length,
        grant: grants.length,
        invoice: invs.length,
        proposal: props.length,
        contract: cons.length,
      },
    });
  } catch (err) {
    req.log.error({ err }, "approvals/count failed");
    res.status(500).json({ error: "Failed to fetch approval count" });
  }
});

// ── GET /api/approvals/pending ────────────────────────────────────────────────
router.get("/approvals/pending", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    const tid = getTenantId(req);

    const [emails, delivs, grants, invs, props, cons] = await Promise.all([
      db.select({
        id:          emailDraftsTable.id,
        subject:     emailDraftsTable.subject,
        toAddresses: emailDraftsTable.toAddresses,
        bodyText:    emailDraftsTable.bodyText,
        bodyHtml:    emailDraftsTable.bodyHtml,
        fromAgent:   emailDraftsTable.fromAgent,
        contextNote: emailDraftsTable.contextNote,
        status:      emailDraftsTable.status,
        createdAt:   emailDraftsTable.createdAt,
      }).from(emailDraftsTable)
        .where(and(eq(emailDraftsTable.status, "pending_approval"), eq(emailDraftsTable.tenantId, tid as any))),

      db.select({
        id: deliverablesTable.id,
        title: deliverablesTable.title,
        projectName: deliverablesTable.projectName,
        submittedByName: deliverablesTable.submittedByName,
        status: deliverablesTable.status,
        createdAt: deliverablesTable.createdAt,
      }).from(deliverablesTable)
        .where(and(inArray(deliverablesTable.status, ["pending_review", "pending_approval", "pm_review"]), eq(deliverablesTable.tenantId, tid as any))),

      db.select({
        id: grantProposalsTable.id,
        organizationName: grantProposalsTable.organizationName,
        grantType: grantProposalsTable.grantType,
        status: grantProposalsTable.status,
        createdAt: grantProposalsTable.createdAt,
      }).from(grantProposalsTable)
        .where(and(inArray(grantProposalsTable.status as any, ["plan_pending", "pending"]), eq(grantProposalsTable.tenantId as any, tid))),

      db.select({
        id: invoicesTable.id,
        invoiceNumber: invoicesTable.invoiceNumber,
        client: invoicesTable.client,
        projectName: invoicesTable.projectName,
        status: invoicesTable.status,
        createdAt: invoicesTable.createdAt,
      }).from(invoicesTable)
        .where(and(eq(invoicesTable.status, "draft"), eq(invoicesTable.tenantId, tid as any))),

      db.select({
        id: proposalsTable.id,
        title: proposalsTable.title,
        clientName: proposalsTable.clientName,
        status: proposalsTable.status,
        createdAt: proposalsTable.createdAt,
      }).from(proposalsTable)
        .where(and(eq(proposalsTable.status, "draft"), eq(proposalsTable.tenantId, tid as any))),

      db.select({
        id: contractsTable.id,
        title: contractsTable.title,
        clientName: contractsTable.clientName,
        status: contractsTable.status,
        createdAt: contractsTable.createdAt,
      }).from(contractsTable)
        .where(and(eq(contractsTable.status, "draft"), eq(contractsTable.tenantId, tid as any))),
    ]);

    const items: ApprovalItem[] = [
      ...emails.map(e => ({
        id:          e.id,
        type:        "email" as const,
        title:       e.subject,
        subtitle:    `To: ${e.toAddresses}`,
        status:      e.status,
        createdAt:   e.createdAt?.toISOString() ?? "",
        body:        e.bodyText ?? undefined,
        bodyHtml:    e.bodyHtml ?? undefined,
        toAddresses: e.toAddresses,
        fromAgent:   e.fromAgent ?? undefined,
        contextNote: e.contextNote ?? undefined,
      })),
      ...delivs.map(d => ({
        id: d.id,
        type: "deliverable" as const,
        title: d.title,
        subtitle: [d.projectName && `Project: ${d.projectName}`, d.submittedByName && `By: ${d.submittedByName}`].filter(Boolean).join(" · ") || "Awaiting review",
        status: d.status,
        createdAt: d.createdAt?.toISOString() ?? "",
      })),
      ...grants.map(g => ({
        id: g.id,
        type: "grant" as const,
        title: `${g.organizationName} — ${g.grantType}`,
        subtitle: g.status === "plan_pending" ? "Grant plan awaiting approval" : "Final submission awaiting review",
        status: g.status,
        createdAt: g.createdAt?.toISOString() ?? "",
      })),
      ...invs.map(i => ({
        id: i.id,
        type: "invoice" as const,
        title: `Invoice ${i.invoiceNumber}`,
        subtitle: `${i.client}${i.projectName ? ` — ${i.projectName}` : ""}`,
        status: i.status,
        createdAt: i.createdAt?.toISOString() ?? "",
      })),
      ...props.map(p => ({
        id: p.id,
        type: "proposal" as const,
        title: p.title,
        subtitle: `Client: ${p.clientName}`,
        status: p.status,
        createdAt: p.createdAt?.toISOString() ?? "",
      })),
      ...cons.map(c => ({
        id: c.id,
        type: "contract" as const,
        title: c.title,
        subtitle: `Client: ${c.clientName}`,
        status: c.status,
        createdAt: c.createdAt?.toISOString() ?? "",
      })),
    ].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

    res.json({
      items,
      total: items.length,
      breakdown: {
        email: emails.length,
        deliverable: delivs.length,
        grant: grants.length,
        invoice: invs.length,
        proposal: props.length,
        contract: cons.length,
      },
    });
  } catch (err) {
    req.log.error({ err }, "approvals/pending failed");
    res.status(500).json({ error: "Failed to fetch pending approvals" });
  }
});

// ── POST /api/approvals/:type/:id/approve ─────────────────────────────────────
router.post("/approvals/:type/:id/approve", requireAdminAuth, async (req, res): Promise<void> => {
  const { type, id: idStr } = req.params;
  const id = Number(idStr);
  const tid = getTenantId(req);
  const s = getSession(req);

  try {
    switch (type) {
      case "email": {
        const [draft] = await db.select().from(emailDraftsTable)
          .where(and(eq(emailDraftsTable.id, id), eq(emailDraftsTable.tenantId, tid as any)));
        if (!draft) { res.status(404).json({ error: "Draft not found" }); return; }

        const toList = draft.toAddresses.split(",").map(e => e.trim()).filter(Boolean);
        const ccList = draft.ccAddresses ? draft.ccAddresses.split(",").map(e => e.trim()).filter(Boolean) : [];
        const approvedById = parseInt(String(s?.employeeId ?? ""), 10);

        if (!isAnettaEmailConfigured()) {
          await db.update(emailDraftsTable).set({ status: "sent", approvedById: isNaN(approvedById) ? null : approvedById, approvedByName: s?.employeeName ?? "Admin", approvedAt: new Date(), sentAt: null }).where(eq(emailDraftsTable.id, id));
          res.json({ success: true, smtpMissing: true });
          return;
        }

        const result = await sendAnettaEmail({
          to: toList,
          cc: ccList.length > 0 ? ccList : undefined,
          subject: draft.subject,
          bodyText: draft.bodyText,
          bodyHtml: draft.bodyHtml && draft.bodyHtml.trim().length > 0 ? draft.bodyHtml : draft.bodyText.replace(/\n/g, "<br>"),
        });

        if (result.success) {
          await db.update(emailDraftsTable).set({ status: "sent", approvedById: isNaN(approvedById) ? null : approvedById, approvedByName: s?.employeeName ?? "Admin", approvedAt: new Date(), sentAt: new Date() }).where(eq(emailDraftsTable.id, id));
          logger.info({ draftId: id, to: toList }, "email approved and sent via approvals queue");
          res.json({ success: true, sentTo: toList });
        } else {
          res.status(500).json({ error: result.error ?? "Failed to send email" });
        }
        return;
      }

      case "deliverable": {
        await db.update(deliverablesTable)
          .set({ status: "approved" })
          .where(eq(deliverablesTable.id, id));
        res.json({ success: true });
        return;
      }

      case "grant": {
        const [grant] = await db.select({ status: grantProposalsTable.status }).from(grantProposalsTable).where(eq(grantProposalsTable.id, id));
        if (!grant) { res.status(404).json({ error: "Grant not found" }); return; }
        const newStatus = grant.status === "plan_pending" ? "plan_approved" : "approved";
        await db.update(grantProposalsTable).set({ status: newStatus, respondedAt: new Date(), adminNotes: "Approved" }).where(eq(grantProposalsTable.id, id));
        res.json({ success: true });
        return;
      }

      case "invoice": {
        await db.update(invoicesTable).set({ status: "sent" }).where(eq(invoicesTable.id, id));
        res.json({ success: true });
        return;
      }

      case "proposal": {
        await db.update(proposalsTable).set({ status: "sent" }).where(eq(proposalsTable.id, id));
        res.json({ success: true });
        return;
      }

      case "contract": {
        await db.update(contractsTable).set({ status: "sent", sentAt: new Date().toISOString() }).where(eq(contractsTable.id, id));
        res.json({ success: true });
        return;
      }

      default:
        res.status(400).json({ error: "Unknown approval type" });
    }
  } catch (err) {
    req.log.error({ err }, `approve ${type}/${id} failed`);
    res.status(500).json({ error: "Approval action failed" });
  }
});

// ── POST /api/approvals/:type/:id/reject ──────────────────────────────────────
router.post("/approvals/:type/:id/reject", requireAdminAuth, async (req, res): Promise<void> => {
  const { type, id: idStr } = req.params;
  const id = Number(idStr);
  const reason: string = (req.body?.reason as string) ?? "";

  try {
    switch (type) {
      case "email": {
        const s = getSession(req);
        const _reid = parseInt(String(s?.employeeId ?? ""), 10);
        await db.update(emailDraftsTable).set({
          status: "rejected",
          approvedById: isNaN(_reid) ? null : _reid,
          approvedByName: s?.employeeName ?? "Admin",
          rejectedReason: reason,
        }).where(eq(emailDraftsTable.id, id));
        res.json({ success: true });
        return;
      }

      case "deliverable": {
        await db.update(deliverablesTable).set({ status: "revision_requested", adminNotes: reason || "Rejected" }).where(eq(deliverablesTable.id, id));
        res.json({ success: true });
        return;
      }

      case "grant": {
        const [grant] = await db.select({ status: grantProposalsTable.status }).from(grantProposalsTable).where(eq(grantProposalsTable.id, id));
        if (!grant) { res.status(404).json({ error: "Grant not found" }); return; }
        const newStatus = grant.status === "plan_pending" ? "plan_denied" : "denied";
        await db.update(grantProposalsTable).set({ status: newStatus, respondedAt: new Date(), adminNotes: reason || "Rejected" }).where(eq(grantProposalsTable.id, id));
        res.json({ success: true });
        return;
      }

      case "invoice": {
        await db.update(invoicesTable).set({ status: "cancelled" }).where(eq(invoicesTable.id, id));
        res.json({ success: true });
        return;
      }

      case "proposal": {
        await db.update(proposalsTable).set({ status: "rejected" }).where(eq(proposalsTable.id, id));
        res.json({ success: true });
        return;
      }

      case "contract": {
        await db.update(contractsTable).set({ status: "cancelled" }).where(eq(contractsTable.id, id));
        res.json({ success: true });
        return;
      }

      default:
        res.status(400).json({ error: "Unknown approval type" });
    }
  } catch (err) {
    req.log.error({ err }, `reject ${type}/${id} failed`);
    res.status(500).json({ error: "Reject action failed" });
  }
});

// ── POST /api/approvals/:type/:id/request-changes ────────────────────────────
router.post("/approvals/:type/:id/request-changes", requireAdminAuth, async (req, res): Promise<void> => {
  const { type, id: idStr } = req.params;
  const id = Number(idStr);
  const notes: string = (req.body?.notes as string) ?? "";

  try {
    switch (type) {
      case "email": {
        await db.update(emailDraftsTable).set({ status: "rejected", rejectedReason: notes || "Changes requested" }).where(eq(emailDraftsTable.id, id));
        res.json({ success: true });
        return;
      }

      case "deliverable": {
        await db.update(deliverablesTable).set({ status: "revision_requested", adminNotes: notes || "Changes requested" }).where(eq(deliverablesTable.id, id));
        res.json({ success: true });
        return;
      }

      case "grant": {
        await db.update(grantProposalsTable).set({ adminNotes: notes || "Changes requested", respondedAt: new Date() }).where(eq(grantProposalsTable.id, id));
        res.json({ success: true });
        return;
      }

      case "invoice":
      case "proposal":
      case "contract": {
        res.json({ success: true, note: "Item kept as draft — changes requested noted." });
        return;
      }

      default:
        res.status(400).json({ error: "Unknown approval type" });
    }
  } catch (err) {
    req.log.error({ err }, `request-changes ${type}/${id} failed`);
    res.status(500).json({ error: "Request-changes action failed" });
  }
});

// ── GET /api/approvals/:type/:id/detail ──────────────────────────────────────
// Returns full record content for inline preview in the approval queue.
router.get("/approvals/:type/:id/detail", requireAdminAuth, async (req, res): Promise<void> => {
  const { type, id: idStr } = req.params;
  const id = Number(idStr);
  const tid = getTenantId(req);

  try {
    switch (type) {
      case "invoice": {
        const [row] = await db.select().from(invoicesTable)
          .where(and(eq(invoicesTable.id, id), eq(invoicesTable.tenantId, tid as any)));
        if (!row) { res.status(404).json({ error: "Not found" }); return; }
        res.json(row);
        return;
      }
      case "proposal": {
        const [row] = await db.select().from(proposalsTable)
          .where(and(eq(proposalsTable.id, id), eq(proposalsTable.tenantId, tid as any)));
        if (!row) { res.status(404).json({ error: "Not found" }); return; }
        res.json(row);
        return;
      }
      case "contract": {
        const [row] = await db.select().from(contractsTable)
          .where(and(eq(contractsTable.id, id), eq(contractsTable.tenantId, tid as any)));
        if (!row) { res.status(404).json({ error: "Not found" }); return; }
        res.json(row);
        return;
      }
      case "deliverable": {
        const [row] = await db.select().from(deliverablesTable)
          .where(and(eq(deliverablesTable.id, id), eq(deliverablesTable.tenantId, tid as any)));
        if (!row) { res.status(404).json({ error: "Not found" }); return; }
        res.json(row);
        return;
      }
      default:
        res.status(400).json({ error: "Detail not available for this type" });
    }
  } catch (err) {
    req.log.error({ err }, `detail ${type}/${id} failed`);
    res.status(500).json({ error: "Failed to load detail" });
  }
});

export default router;
