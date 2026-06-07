/**
 * Grant Proposals — Supervisor-enforced, Admin-only routes.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║               CORE SYSTEM RULE — GRANT WRITING                      ║
 * ║                                                                      ║
 * ║  All output from the Planner, Writer, Critic, and Supervisor must    ║
 * ║  be delivered directly to the Admin only.                            ║
 * ║                                                                      ║
 * ║  The Admin has full oversight, editing rights, and final approval    ║
 * ║  authority. No other agents can see or access any grant materials    ║
 * ║  unless the Admin explicitly assigns them.                           ║
 * ║                                                                      ║
 * ║  The grant writing system remains completely isolated until the      ║
 * ║  Admin approves the final proposal.                                  ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * STATUS LIFECYCLE:
 *   plan_pending       → Planner has produced a strategy; Admin reviewing
 *   plan_denied        → Admin rejected the plan; pipeline closed
 *   writing_in_progress→ Admin approved plan; Writer + Critic running
 *   pending            → Final proposal ready; Admin reviewing
 *   approved           → Admin approved final; pipeline complete
 *   denied             → Admin rejected final
 *   revision_requested → Admin wants changes before approval
 *
 * INTERNAL ENDPOINTS (x-grant-agent-secret gated):
 *   POST /grant-proposals/submit-plan   — Phase 1 callback from Planner
 *   POST /grant-proposals/submit-final  — Phase 2 callback from Critic
 *
 * ADMIN-ONLY ENDPOINTS (requireAdminAuth):
 *   GET    /grant-proposals             — list (summary, no full text)
 *   GET    /grant-proposals/:id         — full detail (all pipeline stages)
 *   PATCH  /grant-proposals/:id         — approve/deny plan or final; edit text
 *     When status = plan_approved → Supervisor triggers Phase 2 automatically
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { db, grantProposalsTable } from "@workspace/db";
import { requireAdminAuth, requireEmployeeAuth, getTenantId } from "../middlewares/authMiddleware";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const GRANT_AGENT_SECRET = process.env.GRANT_AGENT_SECRET ?? "grant-agent-dev-secret";
const GRANT_AGENT_URL    = process.env.GRANT_AGENT_URL    ?? "http://localhost:8002";

function serialize(r: typeof grantProposalsTable.$inferSelect) {
  return {
    ...r,
    createdAt:   r.createdAt.toISOString(),
    updatedAt:   r.updatedAt.toISOString(),
    respondedAt: r.respondedAt?.toISOString() ?? null,
    deadline:    r.deadline?.toISOString() ?? null,
  };
}

function assertSecret(req: Request, res: Response): boolean {
  if (req.headers["x-grant-agent-secret"] !== GRANT_AGENT_SECRET) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN — "Request a Grant" front door. Admin-only: kicks off the grant
// pipeline. Planner produces a strategy plan that lands in /grants for review.
// The Admin is the only person who can start, approve, or deny proposals.
// ═════════════════════════════════════════════════════════════════════════════
router.post("/grant-proposals/request", requireAdminAuth, async (req: Request, res: Response): Promise<void> => {
  const tenantId = getTenantId(req);
  const requesterName =
    (req.session as { employeeName?: string } | undefined)?.employeeName ?? "An employee";

  const {
    grantName,
    funder,
    projectDescription,
    budgetRange,
    missionStatement,
    organizationName,
  } = req.body as {
    grantName?:         string;
    funder?:            string;
    projectDescription?: string;
    budgetRange?:       string;
    missionStatement?:  string;
    organizationName?:  string;
  };

  if (!grantName || !String(grantName).trim()) {
    res.status(400).json({ error: "Grant name is required." });
    return;
  }
  if (!projectDescription || !String(projectDescription).trim()) {
    res.status(400).json({ error: "A short project description is required." });
    return;
  }

  const payload = {
    organization_name:   organizationName?.trim() || "Accelerated Experiences LLC",
    grant_type:          String(grantName).trim(),
    target_funder:       funder?.trim() || undefined,
    mission_statement:   missionStatement?.trim() || undefined,
    project_description:
      `${String(projectDescription).trim()}\n\n— Requested by ${requesterName} via the Request a Grant form.`,
    budget_range:        budgetRange?.trim() || undefined,
    tenant_id:           tenantId,
  };

  try {
    const resp = await fetch(`${GRANT_AGENT_URL}/grant-agent/start`, {
      method:  "POST",
      headers: {
        "Content-Type":          "application/json",
        "x-grant-agent-secret":  GRANT_AGENT_SECRET,
      },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logger.error({ status: resp.status, text }, "grant-proposals: grant-agent /start failed");
      res.status(502).json({ error: "The grant writing service is unavailable right now. Please try again in a moment." });
      return;
    }

    logger.info(
      { requesterName, grantName: payload.grant_type, funder: payload.target_funder },
      "Grant request submitted — Planner is drafting the strategy plan",
    );

    res.status(202).json({
      success: true,
      message: "Your grant request was received. The grant writing team is drafting a strategy plan now — it will appear in the Admin's grant queue for review shortly.",
    });
  } catch (err) {
    logger.error({ err }, "grant-proposals: request failed");
    res.status(500).json({ error: "Failed to submit grant request." });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// INTERNAL — Phase 1 callback: Planner has produced the strategy plan.
// Creates the DB row with status plan_pending. Admin must approve before
// the Writer is triggered.
// ═════════════════════════════════════════════════════════════════════════════
router.post("/grant-proposals/submit-plan", async (req: Request, res: Response): Promise<void> => {
  if (!assertSecret(req, res)) return;

  const {
    run_id, tenant_id, organization_name, grant_type,
    target_funder, mission_statement, project_description,
    budget_range, strategy_plan,
  } = req.body;

  if (!run_id || !organization_name || !grant_type || !strategy_plan) {
    res.status(400).json({ error: "run_id, organization_name, grant_type, and strategy_plan are required" });
    return;
  }

  try {
    const [row] = await db.insert(grantProposalsTable).values({
      tenantId:           tenant_id ?? "00000000-0000-0000-0000-000000000001",
      runId:              String(run_id),
      status:             "plan_pending",
      organizationName:   String(organization_name),
      grantType:          String(grant_type),
      targetFunder:       target_funder       ? String(target_funder)       : null,
      missionStatement:   mission_statement   ? String(mission_statement)   : null,
      projectDescription: project_description ? String(project_description) : null,
      budgetRange:        budget_range        ? String(budget_range)        : null,
      strategyPlan:       String(strategy_plan),
    }).returning();

    logger.info(
      { grantProposalId: row.id, runId: row.runId, org: row.organizationName },
      "Grant strategy plan submitted — awaiting Admin approval before Writer proceeds",
    );
    res.status(201).json({ success: true, grantProposalId: row.id });
  } catch (err) {
    logger.error({ err }, "grant-proposals: submit-plan failed");
    res.status(500).json({ error: "Failed to save grant strategy plan" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// INTERNAL — Phase 2 callback: Writer + Critic are complete.
// Updates the existing row (by run_id) with the draft and final proposal.
// Sets status to pending — Admin now reviews the final.
// ═════════════════════════════════════════════════════════════════════════════
router.post("/grant-proposals/submit-final", async (req: Request, res: Response): Promise<void> => {
  if (!assertSecret(req, res)) return;

  const { run_id, draft_proposal, full_proposal_text } = req.body;

  if (!run_id || !full_proposal_text) {
    res.status(400).json({ error: "run_id and full_proposal_text are required" });
    return;
  }

  try {
    const [row] = await db.update(grantProposalsTable)
      .set({
        status:          "pending",
        draftProposal:   draft_proposal     ? String(draft_proposal)    : null,
        fullProposalText: String(full_proposal_text),
        updatedAt:       new Date(),
      })
      .where(eq(grantProposalsTable.runId, String(run_id)))
      .returning();

    if (!row) {
      res.status(404).json({ error: "Grant proposal not found for run_id" });
      return;
    }

    logger.info(
      { grantProposalId: row.id, runId: row.runId },
      "Grant final proposal ready — Admin approval queue",
    );
    res.status(200).json({ success: true, grantProposalId: row.id });
  } catch (err) {
    logger.error({ err }, "grant-proposals: submit-final failed");
    res.status(500).json({ error: "Failed to save final proposal" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN — List grant proposals (summary, no full text for performance)
// ═════════════════════════════════════════════════════════════════════════════
router.get("/grant-proposals/action-count", requireAdminAuth, async (req: Request, res: Response): Promise<void> => {
  const tid = getTenantId(req);
  try {
    const thirtyDaysOut = new Date();
    thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);
    const CLOSED = ["approved", "denied", "plan_denied"];
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(grantProposalsTable)
      .where(and(
        eq(grantProposalsTable.tenantId, tid),
        or(
          inArray(grantProposalsTable.status, ["plan_pending", "pending", "revision_requested"]),
          and(
            isNotNull(grantProposalsTable.deadline),
            lte(grantProposalsTable.deadline, thirtyDaysOut),
            sql`${grantProposalsTable.status} NOT IN (${sql.join(CLOSED.map(s => sql`${s}`), sql`, `)})`,
          ),
        ),
      ));
    res.json({ count: rows[0]?.count ?? 0 });
  } catch (err) {
    logger.error({ err }, "grant-proposals: action-count failed");
    res.status(500).json({ error: "Failed to load count" });
  }
});

router.get("/grant-proposals", requireAdminAuth, async (req: Request, res: Response): Promise<void> => {
  const tid = getTenantId(req);
  const { status } = req.query as { status?: string };

  try {
    const where = status && status !== "all"
      ? and(eq(grantProposalsTable.tenantId, tid), eq(grantProposalsTable.status, status))
      : eq(grantProposalsTable.tenantId, tid);

    const rows = await db.select({
      id:               grantProposalsTable.id,
      runId:            grantProposalsTable.runId,
      status:           grantProposalsTable.status,
      organizationName: grantProposalsTable.organizationName,
      grantType:        grantProposalsTable.grantType,
      targetFunder:     grantProposalsTable.targetFunder,
      budgetRange:      grantProposalsTable.budgetRange,
      adminNotes:       grantProposalsTable.adminNotes,
      deadline:         grantProposalsTable.deadline,
      createdAt:        grantProposalsTable.createdAt,
      respondedAt:      grantProposalsTable.respondedAt,
      updatedAt:        grantProposalsTable.updatedAt,
    }).from(grantProposalsTable)
      .where(where)
      .orderBy(desc(grantProposalsTable.createdAt));

    res.json(rows.map(r => ({
      ...r,
      createdAt:   r.createdAt.toISOString(),
      updatedAt:   r.updatedAt.toISOString(),
      respondedAt: r.respondedAt?.toISOString() ?? null,
      deadline:    r.deadline?.toISOString() ?? null,
    })));
  } catch (err) {
    logger.error({ err }, "grant-proposals: list failed");
    res.status(500).json({ error: "Failed to load grant proposals" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN — Full proposal detail (all pipeline stages visible to Admin)
// ═════════════════════════════════════════════════════════════════════════════
router.get("/grant-proposals/:id", requireAdminAuth, async (req: Request, res: Response): Promise<void> => {
  const tid = getTenantId(req);
  const id  = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  try {
    const [row] = await db.select().from(grantProposalsTable)
      .where(and(eq(grantProposalsTable.id, id), eq(grantProposalsTable.tenantId, tid)));

    if (!row) { res.status(404).json({ error: "Grant proposal not found" }); return; }

    res.json(serialize(row));
  } catch (err) {
    logger.error({ err }, "grant-proposals: get failed");
    res.status(500).json({ error: "Failed to load grant proposal" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN — Approve, deny, or edit. The Supervisor enforces the approval gate:
//   plan_approved      → immediately triggers Phase 2 (Writer + Critic)
//   plan_denied        → pipeline closed; no further processing
//   approved           → final proposal approved
//   denied             → final proposal rejected
//   revision_requested → Admin wants changes before approval
// ═════════════════════════════════════════════════════════════════════════════
router.patch("/grant-proposals/:id", requireAdminAuth, async (req: Request, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const { status, adminNotes, fullProposalText, deadline } = req.body as {
    status?:           string;
    adminNotes?:       string;
    fullProposalText?: string;
    deadline?:         string | null;
  };

  const VALID_STATUSES = ["plan_approved", "plan_denied", "approved", "denied", "revision_requested"];
  if (!status || !VALID_STATUSES.includes(status)) {
    res.status(400).json({
      error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
    });
    return;
  }

  let parsedDeadline: Date | null | undefined = undefined;
  if (deadline !== undefined) {
    if (deadline === null || deadline === "") {
      parsedDeadline = null;
    } else {
      const d = new Date(deadline);
      if (isNaN(d.getTime())) { res.status(400).json({ error: "Invalid deadline" }); return; }
      parsedDeadline = d;
    }
  }

  try {
    // When Admin approves the plan, Supervisor immediately moves to writing_in_progress
    const dbStatus = status === "plan_approved" ? "writing_in_progress" : status;

    const updates: Record<string, unknown> = {
      status:      dbStatus,
      adminNotes:  adminNotes ?? null,
      respondedAt: new Date(),
      updatedAt:   new Date(),
    };
    if (fullProposalText !== undefined) {
      updates.fullProposalText = fullProposalText;
    }
    if (parsedDeadline !== undefined) {
      updates.deadline = parsedDeadline;
    }

    const [row] = await db.update(grantProposalsTable)
      .set(updates)
      .where(eq(grantProposalsTable.id, id))
      .returning();

    if (!row) { res.status(404).json({ error: "Grant proposal not found" }); return; }

    logger.info({ grantProposalId: id, adminDecision: status, dbStatus }, "Admin grant decision recorded");

    // ── Supervisor: Admin approved the plan → trigger Phase 2 ────────────────
    if (status === "plan_approved") {
      const continuePayload = {
        run_id:             row.runId,
        tenant_id:          row.tenantId,
        organization_name:  row.organizationName,
        grant_type:         row.grantType,
        target_funder:      row.targetFunder      ?? undefined,
        mission_statement:  row.missionStatement  ?? undefined,
        project_description: row.projectDescription ?? undefined,
        budget_range:       row.budgetRange       ?? undefined,
        strategy_plan:      row.strategyPlan      ?? "",
        admin_plan_notes:   adminNotes            ?? undefined,
      };

      // Fire-and-forget — Phase 2 runs asynchronously
      fetch(`${GRANT_AGENT_URL}/grant-agent/continue`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(continuePayload),
        signal:  AbortSignal.timeout(15_000),
      })
        .then(r => logger.info({ grantProposalId: id, httpStatus: r.status }, "Supervisor: Phase 2 triggered"))
        .catch(err => logger.error({ err, grantProposalId: id }, "Supervisor: failed to trigger Phase 2"));
    }

    res.json(serialize(row));
  } catch (err) {
    logger.error({ err }, "grant-proposals: patch failed");
    res.status(500).json({ error: "Failed to update grant proposal" });
  }
});

export default router;
