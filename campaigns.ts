import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, crmLeadsTable } from "@workspace/db";
import { requireEmployeeAuth, getTenantId } from "../middlewares/authMiddleware";

const router: IRouter = Router();

const CAMPAIGN_TYPES = [
  "partnership",
  "investor",
  "consulting",
  "architecture",
  "law",
  "construction",
  "financial",
] as const;

const CAMPAIGN_LABELS: Record<string, string> = {
  partnership:  "Partnership",
  investor:     "Investor",
  consulting:   "Consulting",
  architecture: "Architecture",
  law:          "Law",
  construction: "Construction",
  financial:    "Financial Advisory",
};

const CAMPAIGN_VALUES: Record<string, number> = {
  partnership:  100000,
  investor:     150000,
  consulting:   27600,
  architecture: 38400,
  law:          48000,
  construction: 33600,
  financial:    57600,
};

const CAMPAIGN_STATUSES = [
  "not_contacted",
  "contacted",
  "replied",
  "meeting_booked",
  "proposal_sent",
  "won",
  "lost",
] as const;

router.get("/campaigns/summary", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const { role } = (req as any).session ?? {};

  if (!["admin", "account_representative", "project_manager"].includes(role ?? "")) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const leads = await db
    .select()
    .from(crmLeadsTable)
    .where(eq(crmLeadsTable.tenantId, tid));

  const summary = CAMPAIGN_TYPES.map(type => {
    const typeLeads = leads.filter(l => l.campaignType === type);
    const wonLeads  = typeLeads.filter(l => l.campaignStatus === "won" || l.stage === "won");
    const totalValue = wonLeads.reduce((s, l) => s + parseFloat(l.value ?? "0"), 0);

    const statusBreakdown: Record<string, number> = {};
    for (const status of CAMPAIGN_STATUSES) {
      statusBreakdown[status] = typeLeads.filter(l => (l.campaignStatus ?? "not_contacted") === status).length;
    }

    const nextActionsCount = typeLeads.filter(l =>
      l.nextFollowUpAt && new Date(l.nextFollowUpAt) <= new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    ).length;

    return {
      type,
      label: CAMPAIGN_LABELS[type] ?? type,
      defaultValue: CAMPAIGN_VALUES[type] ?? 0,
      totalLeads: typeLeads.length,
      statusBreakdown,
      winRate: typeLeads.length > 0 ? Math.round((wonLeads.length / typeLeads.length) * 100) : 0,
      totalWonValue: totalValue,
      nextActionsCount,
    };
  });

  res.json(summary);
});

export default router;
