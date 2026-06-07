import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, invoicesTable, expensesTable } from "@workspace/db";
import { requireAccountingAuth, getTenantId } from "../middlewares/authMiddleware";
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { resolveModel, extractJSON } from "../lib/ai-models";
import { logger } from "../lib/logger";

const router: IRouter = Router();

type InvoiceRow = typeof invoicesTable.$inferSelect;
type ExpenseRow  = typeof expensesTable.$inferSelect;

function computeKPIs(invoices: InvoiceRow[], expenses: ExpenseRow[]) {
  const paid    = invoices.filter(i => i.status === "paid");
  const pending = invoices.filter(i => i.status === "sent" || i.status === "draft");
  const overdue = invoices.filter(i => i.status === "overdue");

  const revenue       = paid.reduce((s, i) => s + Number(i.amount), 0);
  const pendingRevenue = [...pending, ...overdue].reduce((s, i) => s + Number(i.amount), 0);
  const totalExpenses  = expenses.reduce((s, e) => s + Number(e.amount), 0);
  const grossProfit    = revenue - totalExpenses;
  const gpMargin       = revenue > 0 ? Math.round((grossProfit / revenue) * 1000) / 10 : null;
  const totalBilled    = paid.length + pending.length + overdue.length;
  const collectionRate = totalBilled > 0 ? Math.round((paid.length / totalBilled) * 100) : null;

  return { revenue, expenses: totalExpenses, grossProfit, gpMargin, invoiceCount: totalBilled, paidCount: paid.length, pendingRevenue, collectionRate };
}

function quarterBounds(year: number, q: number) {
  const sm = (q - 1) * 3 + 1;
  const em = sm + 2;
  const lastDay = new Date(year, em, 0).getDate();
  return {
    start: `${year}-${String(sm).padStart(2, "0")}-01`,
    end:   `${year}-${String(em).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
  };
}

// ── GET /api/reports/quarterly?year=2025&quarter=1  (quarter omitted = annual) ─
router.get("/reports/quarterly", requireAccountingAuth, async (req, res): Promise<void> => {
  const tid         = getTenantId(req);
  const year        = Number(req.query.year) || new Date().getFullYear();
  const qParam      = req.query.quarter as string | undefined;
  const isAnnual    = !qParam || qParam === "annual" || qParam === "0";
  const quarter     = isAnnual ? null : Math.max(1, Math.min(4, Number(qParam)));

  const periodStart = isAnnual ? `${year}-01-01` : quarterBounds(year, quarter!).start;
  const periodEnd   = isAnnual ? `${year}-12-31` : quarterBounds(year, quarter!).end;
  const priorStart  = isAnnual ? `${year - 1}-01-01` : quarterBounds(year - 1, quarter!).start;
  const priorEnd    = isAnnual ? `${year - 1}-12-31` : quarterBounds(year - 1, quarter!).end;

  const [allInvoices, allExpenses] = await Promise.all([
    db.select().from(invoicesTable).where(eq(invoicesTable.tenantId, tid)),
    db.select().from(expensesTable).where(eq(expensesTable.tenantId, tid)),
  ]);

  function filterInv(start: string, end: string) {
    return allInvoices.filter(i => {
      const d = i.createdAt.toISOString().slice(0, 10);
      return d >= start && d <= end;
    });
  }
  function filterExp(start: string, end: string) {
    return allExpenses.filter(e => e.date >= start && e.date <= end);
  }

  const periodInv  = filterInv(periodStart, periodEnd);
  const periodExp  = filterExp(periodStart, periodEnd);
  const priorInv   = filterInv(priorStart,  priorEnd);
  const priorExp   = filterExp(priorStart,  priorEnd);

  // Monthly breakdown
  const monthMap: Record<string, { revenue: number; expenses: number; invoiceCount: number }> = {};
  for (const inv of periodInv) {
    if (inv.status === "cancelled") continue;
    const m = inv.createdAt.toISOString().slice(0, 7);
    if (!monthMap[m]) monthMap[m] = { revenue: 0, expenses: 0, invoiceCount: 0 };
    if (inv.status === "paid") monthMap[m].revenue += Number(inv.amount);
    monthMap[m].invoiceCount += 1;
  }
  for (const exp of periodExp) {
    const m = exp.date.slice(0, 7);
    if (!monthMap[m]) monthMap[m] = { revenue: 0, expenses: 0, invoiceCount: 0 };
    monthMap[m].expenses += Number(exp.amount);
  }
  const months = Object.entries(monthMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, d]) => ({
      month,
      revenue:      Math.round(d.revenue),
      expenses:     Math.round(d.expenses),
      grossProfit:  Math.round(d.revenue - d.expenses),
      invoiceCount: d.invoiceCount,
    }));

  // Quarter-by-quarter breakdown (annual view only)
  const quarterBreakdown = isAnnual ? [1, 2, 3, 4].map(q => {
    const b   = quarterBounds(year, q);
    const qkp = computeKPIs(filterInv(b.start, b.end), filterExp(b.start, b.end));
    return { quarter: `Q${q}`, revenue: Math.round(qkp.revenue), expenses: Math.round(qkp.expenses), grossProfit: Math.round(qkp.grossProfit), gpMargin: qkp.gpMargin };
  }) : null;

  // Invoice status (treat sent/draft as pending for display)
  const statusCounts  = { paid: 0, pending: 0, overdue: 0 };
  const statusAmounts = { paid: 0, pending: 0, overdue: 0 };
  for (const inv of periodInv) {
    if (inv.status === "cancelled") continue;
    const key = (inv.status === "sent" || inv.status === "draft") ? "pending" : inv.status as "paid" | "pending" | "overdue";
    if (key in statusCounts) {
      statusCounts[key]++;
      statusAmounts[key] += Number(inv.amount);
    }
  }

  // Expense by category
  const catMap: Record<string, number> = {};
  for (const exp of periodExp) {
    const cat = exp.category ?? "other";
    catMap[cat] = (catMap[cat] ?? 0) + Number(exp.amount);
  }
  const expensesByCategory = Object.entries(catMap)
    .sort(([, a], [, b]) => b - a)
    .map(([category, amount]) => ({ category, amount: Math.round(amount) }));

  // Revenue by client (paid invoices only)
  const clientMap: Record<string, { revenue: number; invoiceCount: number }> = {};
  for (const inv of periodInv.filter(i => i.status === "paid")) {
    const client = inv.client || "Unknown";
    if (!clientMap[client]) clientMap[client] = { revenue: 0, invoiceCount: 0 };
    clientMap[client].revenue += Number(inv.amount);
    clientMap[client].invoiceCount++;
  }
  const revenueByClient = Object.entries(clientMap)
    .sort(([, a], [, b]) => b.revenue - a.revenue)
    .map(([client, d]) => ({ client, revenue: Math.round(d.revenue), invoiceCount: d.invoiceCount }));

  const kpis      = computeKPIs(periodInv, periodExp);
  const priorKPIs = computeKPIs(priorInv,  priorExp);

  res.json({
    period: {
      year, quarter, isAnnual,
      label:      isAnnual ? `FY ${year}`     : `Q${quarter} ${year}`,
      priorLabel: isAnnual ? `FY ${year - 1}` : `Q${quarter} ${year - 1}`,
      start: periodStart, end: periodEnd,
    },
    kpis: {
      revenue:        Math.round(kpis.revenue),
      expenses:       Math.round(kpis.expenses),
      grossProfit:    Math.round(kpis.grossProfit),
      gpMargin:       kpis.gpMargin,
      invoiceCount:   kpis.invoiceCount,
      paidCount:      kpis.paidCount,
      pendingRevenue: Math.round(kpis.pendingRevenue),
      collectionRate: kpis.collectionRate,
    },
    priorPeriod: {
      revenue:     Math.round(priorKPIs.revenue),
      expenses:    Math.round(priorKPIs.expenses),
      grossProfit: Math.round(priorKPIs.grossProfit),
      gpMargin:    priorKPIs.gpMargin,
    },
    months,
    quarterBreakdown,
    invoiceStatus:       statusCounts,
    invoiceStatusAmounts: {
      paid:    Math.round(statusAmounts.paid),
      pending: Math.round(statusAmounts.pending),
      overdue: Math.round(statusAmounts.overdue),
    },
    expensesByCategory,
    revenueByClient,
  });
});

// ── POST /api/reports/quarterly/ai-summary — Geoffrey narrates the period ──────
router.post("/reports/quarterly/ai-summary", requireAccountingAuth, async (req, res): Promise<void> => {
  const { period, kpis, priorPeriod, months, quarterBreakdown, revenueByClient, expensesByCategory } = req.body;

  if (!period || !kpis) {
    res.status(400).json({ error: "period and kpis are required" }); return;
  }

  const pctChange = (cur: number, prior: number) => prior > 0 ? `${cur >= prior ? "+" : ""}${Math.round(((cur - prior) / prior) * 100)}%` : "N/A";

  const topClients  = (revenueByClient as { client: string; revenue: number }[]).slice(0, 3).map(c => `${c.client}: $${c.revenue.toLocaleString()}`).join(", ");
  const topExpenses = (expensesByCategory as { category: string; amount: number }[]).slice(0, 3).map(e => `${e.category}: $${e.amount.toLocaleString()}`).join(", ");
  const trend = (months as { month: string; revenue: number; expenses: number }[]).map(m => `${m.month}: rev $${m.revenue.toLocaleString()}, exp $${m.expenses.toLocaleString()}`).join(" | ");

  const systemPrompt = `You are Geoffrey, the AI accountant for Accelerated Experiences LLC — a creative production company. You write clear, concise, professional financial executive summaries. You highlight what matters most, flag risks, and always end with 2-3 actionable recommendations. Write in first person as Geoffrey. Use dollar figures. Be direct and specific.`;

  const userPrompt = `Write a financial executive summary for ${period.label}.

Key figures:
- Revenue collected: $${kpis.revenue.toLocaleString()} (prior ${priorPeriod ? period.priorLabel ?? "prior period" : "N/A"}: $${priorPeriod?.revenue?.toLocaleString() ?? "N/A"}, change: ${priorPeriod ? pctChange(kpis.revenue, priorPeriod.revenue) : "N/A"})
- Total expenses: $${kpis.expenses.toLocaleString()} (prior: $${priorPeriod?.expenses?.toLocaleString() ?? "N/A"}, change: ${priorPeriod ? pctChange(kpis.expenses, priorPeriod.expenses) : "N/A"})
- Gross profit: $${kpis.grossProfit.toLocaleString()} | GP margin: ${kpis.gpMargin !== null ? kpis.gpMargin + "%" : "N/A"}
- Pending revenue: $${kpis.pendingRevenue.toLocaleString()}
- Collection rate: ${kpis.collectionRate !== null ? kpis.collectionRate + "%" : "N/A"} (${kpis.paidCount} paid of ${kpis.invoiceCount} invoiced)
- Top clients: ${topClients || "none"}
- Top expense categories: ${topExpenses || "none"}
${quarterBreakdown ? `- Quarter breakdown: ${(quarterBreakdown as { quarter: string; revenue: number; grossProfit: number }[]).map(q => `${q.quarter}: rev $${q.revenue.toLocaleString()}, GP $${q.grossProfit.toLocaleString()}`).join(" | ")}` : ""}
- Monthly trend: ${trend || "no data"}

Return ONLY a JSON object (no markdown) with these exact keys:
{
  "headline": "One sentence executive summary",
  "overview": "2-3 sentence overview of the period performance",
  "revenue": "2-3 sentences about revenue performance and collection",
  "expenses": "2 sentences about expense trends",
  "cashFlow": "2 sentences about GP, margins, and cash position",
  "recommendations": ["Recommendation 1", "Recommendation 2", "Recommendation 3"]
}`;

  try {
    const resp = await openrouter.chat.completions.create({
      model: resolveModel("geoffrey"),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      max_tokens: 900,
    });

    const raw = extractJSON(resp.choices[0]?.message?.content ?? "{}");
    let summary: Record<string, unknown> = {};
    try { summary = JSON.parse(raw); } catch { summary = { overview: resp.choices[0]?.message?.content ?? "Unable to generate summary." }; }
    res.json(summary);
  } catch (err) {
    logger.error({ err }, "financial-reports ai-summary error");
    res.status(500).json({ error: "Geoffrey is unavailable right now. Please try again." });
  }
});

export default router;
