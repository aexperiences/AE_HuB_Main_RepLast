import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, pmForecastsTable, estimatesTable, invoicesTable, proposalsTable, contractsTable, projectsTable, expensesTable } from "@workspace/db";
import { requireEmployeeAuth, requireAccountingAuth, getTenantId } from "../middlewares/authMiddleware";

const router: IRouter = Router();

function toForecast(f: typeof pmForecastsTable.$inferSelect) {
  return {
    ...f,
    forecastAmount: Number(f.forecastAmount),
    createdAt: f.createdAt.toISOString(),
  };
}

router.get("/pm-forecasts", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const month = req.query.month as string | undefined;
  const rows = month
    ? await db.select().from(pmForecastsTable).where(and(eq(pmForecastsTable.tenantId, tid), eq(pmForecastsTable.month, month))).orderBy(desc(pmForecastsTable.createdAt))
    : await db.select().from(pmForecastsTable).where(eq(pmForecastsTable.tenantId, tid)).orderBy(desc(pmForecastsTable.createdAt));
  res.json(rows.map(toForecast));
});

router.post("/pm-forecasts", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const { pmName, month, projectId, projectName, forecastAmount, probability, notes } = req.body;
  if (!pmName || !month || !forecastAmount) {
    res.status(400).json({ error: "pmName, month, and forecastAmount are required" });
    return;
  }
  const [row] = await db.insert(pmForecastsTable).values({
    tenantId: tid,
    pmName,
    month,
    projectId: projectId ?? null,
    projectName: projectName ?? null,
    forecastAmount: String(forecastAmount),
    probability: probability ?? 80,
    notes: notes ?? null,
  }).returning();
  res.status(201).json(toForecast(row));
});

router.patch("/pm-forecasts/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const update: Record<string, unknown> = {};
  if (req.body.pmName !== undefined) update.pmName = req.body.pmName;
  if (req.body.month !== undefined) update.month = req.body.month;
  if (req.body.projectId !== undefined) update.projectId = req.body.projectId;
  if (req.body.projectName !== undefined) update.projectName = req.body.projectName;
  if (req.body.forecastAmount !== undefined) update.forecastAmount = String(req.body.forecastAmount);
  if (req.body.probability !== undefined) update.probability = req.body.probability;
  if (req.body.notes !== undefined) update.notes = req.body.notes;
  const [row] = await db.update(pmForecastsTable).set(update).where(and(eq(pmForecastsTable.id, id), eq(pmForecastsTable.tenantId, tid))).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(toForecast(row));
});

router.delete("/pm-forecasts/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const [row] = await db.delete(pmForecastsTable).where(and(eq(pmForecastsTable.id, id), eq(pmForecastsTable.tenantId, tid))).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.sendStatus(204);
});

router.get("/accounting/flash", requireAccountingAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const month = (req.query.month as string) ?? new Date().toISOString().slice(0, 7);

  const [forecasts, allEstimates, allInvoices, allProposals, allContracts, allProjects, allExpenses] = await Promise.all([
    db.select().from(pmForecastsTable).where(and(eq(pmForecastsTable.tenantId, tid), eq(pmForecastsTable.month, month))).orderBy(desc(pmForecastsTable.createdAt)),
    db.select().from(estimatesTable).where(eq(estimatesTable.tenantId, tid)).orderBy(desc(estimatesTable.createdAt)),
    db.select().from(invoicesTable).where(eq(invoicesTable.tenantId, tid)).orderBy(desc(invoicesTable.createdAt)),
    db.select().from(proposalsTable).where(eq(proposalsTable.tenantId, tid)).orderBy(desc(proposalsTable.createdAt)),
    db.select().from(contractsTable).where(eq(contractsTable.tenantId, tid)).orderBy(desc(contractsTable.createdAt)),
    db.select().from(projectsTable).where(eq(projectsTable.tenantId, tid)).orderBy(desc(projectsTable.createdAt)),
    db.select().from(expensesTable).where(eq(expensesTable.tenantId, tid)).orderBy(desc(expensesTable.createdAt)),
  ]);

  const forecastSerialized = forecasts.map(toForecast);
  const forecastTotal = forecastSerialized.reduce((s, f) => s + f.forecastAmount, 0);
  const forecastWeighted = forecastSerialized.reduce((s, f) => s + f.forecastAmount * (f.probability / 100), 0);

  const estimatesByStatus = {
    draft:    { count: 0, value: 0 },
    sent:     { count: 0, value: 0 },
    accepted: { count: 0, value: 0 },
    rejected: { count: 0, value: 0 },
  };
  for (const e of allEstimates) {
    const st = e.status as keyof typeof estimatesByStatus;
    if (estimatesByStatus[st]) {
      estimatesByStatus[st].count += 1;
      estimatesByStatus[st].value += Number(e.total);
    }
  }

  const monthInvoices = allInvoices.filter(inv => {
    const invMonth = inv.createdAt.toISOString().slice(0, 7);
    return invMonth === month;
  });

  const invoiceSummary = {
    pending:  { count: 0, value: 0 },
    paid:     { count: 0, value: 0 },
    overdue:  { count: 0, value: 0 },
    allMonth: { count: 0, value: 0 },
  };
  for (const inv of monthInvoices) {
    if (inv.status === "cancelled") continue;
    const amt = Number(inv.amount);
    invoiceSummary.allMonth.count += 1;
    invoiceSummary.allMonth.value += amt;
    if (inv.status === "paid") {
      invoiceSummary.paid.count += 1;
      invoiceSummary.paid.value += amt;
    } else if (inv.status === "overdue") {
      invoiceSummary.overdue.count += 1;
      invoiceSummary.overdue.value += amt;
    } else {
      invoiceSummary.pending.count += 1;
      invoiceSummary.pending.value += amt;
    }
  }

  const allTimeCollected = allInvoices
    .filter(inv => inv.status === "paid")
    .reduce((s, inv) => s + Number(inv.amount), 0);

  const proposalsByStatus = { sent: { count: 0, value: 0 }, accepted: { count: 0, value: 0 }, rejected: { count: 0, value: 0 } };
  for (const p of allProposals) {
    const st = p.status as keyof typeof proposalsByStatus;
    if (proposalsByStatus[st]) {
      proposalsByStatus[st].count += 1;
      proposalsByStatus[st].value += Number(p.total);
    }
  }

  const contractsByStatus = { draft: 0, sent: 0, signed: 0, executed: 0 };
  for (const c of allContracts) {
    const st = c.status as keyof typeof contractsByStatus;
    if (st in contractsByStatus) contractsByStatus[st] += 1;
  }

  function calcProjectGpm(projects: typeof allProjects) {
    const idSet = new Set(projects.map(p => p.id));
    const expenses  = allExpenses.filter(e => e.projectId != null && idSet.has(e.projectId));
    const invoices  = allInvoices.filter(inv => inv.projectId != null && idSet.has(inv.projectId));
    const totalExpenses   = expenses.reduce((s, e) => s + Number(e.amount), 0);
    const totalInvoiced   = invoices.filter(inv => inv.status !== "cancelled").reduce((s, inv) => s + Number(inv.amount), 0);
    const totalCollected  = invoices.filter(inv => inv.status === "paid").reduce((s, inv) => s + Number(inv.amount), 0);
    const totalBudget     = projects.reduce((s, p) => s + (p.budget ? Number(p.budget) : 0), 0);
    const grossProfit     = totalCollected - totalExpenses;
    const gpPct           = totalCollected > 0 ? Math.round((grossProfit / totalCollected) * 100) : null;
    const projectRows     = projects.map(p => {
      const pExp = allExpenses.filter(e => e.projectId === p.id).reduce((s, e) => s + Number(e.amount), 0);
      const pInv = allInvoices.filter(inv => inv.projectId === p.id && inv.status !== "cancelled").reduce((s, inv) => s + Number(inv.amount), 0);
      const pColl = allInvoices.filter(inv => inv.projectId === p.id && inv.status === "paid").reduce((s, inv) => s + Number(inv.amount), 0);
      const pGP = pColl - pExp;
      const pGpPct = pColl > 0 ? Math.round((pGP / pColl) * 100) : null;
      return {
        id: p.id,
        name: p.name,
        client: p.client ?? null,
        status: p.status,
        budget: p.budget ? Number(p.budget) : null,
        totalExpenses: pExp,
        totalInvoiced: pInv,
        totalCollected: pColl,
        grossProfit: pGP,
        gpPct: pGpPct,
      };
    });
    return {
      count: projects.length,
      active: projects.filter(p => p.status === "active").length,
      totalBudget,
      totalExpenses,
      totalInvoiced,
      totalCollected,
      grossProfit,
      gpPct,
      projects: projectRows,
    };
  }

  const clientProjects   = allProjects.filter(p => p.projectType === "client");
  const internalProjects = allProjects.filter(p => p.projectType === "internal");

  res.json({
    month,
    forecasts: forecastSerialized,
    forecastTotals: {
      total: forecastTotal,
      weighted: forecastWeighted,
      count: forecastSerialized.length,
    },
    estimates: {
      ...estimatesByStatus,
      all: allEstimates.map(e => ({
        id: e.id,
        title: e.title,
        client: e.client,
        projectId: e.projectId,
        status: e.status,
        total: Number(e.total),
        subtotal: Number(e.subtotal),
        createdAt: e.createdAt.toISOString(),
      })),
    },
    proposals: proposalsByStatus,
    contracts: contractsByStatus,
    invoices: {
      ...invoiceSummary,
      allTimePaid: allTimeCollected,
    },
    gpm: {
      client:   calcProjectGpm(clientProjects),
      internal: calcProjectGpm(internalProjects),
    },
  });
});

export default router;
