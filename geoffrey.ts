import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, geoffreyRequests, expensesTable, invoicesTable, projectsTable, estimatesTable, proposalsTable } from "@workspace/db";
import { requireAdminAuth, requireAccountingAuth, requireEmployeeAuth, getTenantId } from "../middlewares/authMiddleware";
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { resolveModel, extractJSON } from "../lib/ai-models";
import { nowBlock } from "../lib/agent-roster";

const router: IRouter = Router();

function serializeRequest(r: typeof geoffreyRequests.$inferSelect) {
  return {
    ...r,
    amount: r.amount != null ? Number(r.amount) : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    responseAt: r.responseAt ? r.responseAt.toISOString() : null,
  };
}

function getQuarterlyTaxDates(year: number): Array<{ quarter: string; year: number; dueDate: string; period: string }> {
  return [
    { quarter: "Q1", year, dueDate: `${year}-04-15`, period: `Jan–Mar ${year}` },
    { quarter: "Q2", year, dueDate: `${year}-06-16`, period: `Apr–May ${year}` },
    { quarter: "Q3", year, dueDate: `${year}-09-15`, period: `Jun–Aug ${year}` },
    { quarter: "Q4", year, dueDate: `${year + 1}-01-15`, period: `Sep–Dec ${year}` },
  ];
}

router.get("/geoffrey/requests", requireAccountingAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const { status } = req.query as { status?: string };
  const rows = await db.select().from(geoffreyRequests)
    .where(and(
      eq(geoffreyRequests.tenantId, tid),
      ...(status && status !== "all" ? [eq(geoffreyRequests.status, status)] : []),
    ))
    .orderBy(desc(geoffreyRequests.createdAt));
  res.json(rows.map(serializeRequest));
});

router.patch("/geoffrey/requests/:id", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const { status, adminNotes } = req.body;
  if (!status || !["approved", "denied", "overridden"].includes(status)) {
    res.status(400).json({ error: "status must be approved, denied, or overridden" }); return;
  }

  const [row] = await db.update(geoffreyRequests)
    .set({ status, adminNotes: adminNotes ?? null, responseAt: new Date(), updatedAt: new Date() })
    .where(and(eq(geoffreyRequests.id, id), eq(geoffreyRequests.tenantId, tid)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(serializeRequest(row));
});

router.post("/geoffrey/analyze", requireAccountingAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const { model: requestedModel } = req.body;
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;
  const currentQuarter = Math.ceil(currentMonth / 3);

  const [expenses, invoices, projects, estimates, proposals] = await Promise.all([
    db.select().from(expensesTable).where(eq(expensesTable.tenantId, tid)).orderBy(desc(expensesTable.createdAt)).limit(200),
    db.select().from(invoicesTable).where(eq(invoicesTable.tenantId, tid)).orderBy(desc(invoicesTable.createdAt)).limit(200),
    db.select().from(projectsTable).where(and(eq(projectsTable.tenantId, tid), eq(projectsTable.status, "active"))),
    db.select().from(estimatesTable).where(eq(estimatesTable.tenantId, tid)).orderBy(desc(estimatesTable.createdAt)).limit(50),
    db.select().from(proposalsTable).where(eq(proposalsTable.tenantId, tid)).orderBy(desc(proposalsTable.createdAt)).limit(50),
  ]);

  const paidInvoices = invoices.filter(i => i.status === "paid");
  const totalRevenue = paidInvoices.reduce((s, i) => s + Number(i.amount), 0);
  const pendingRevenue = invoices.filter(i => i.status === "sent").reduce((s, i) => s + Number(i.amount), 0);
  const overdueRevenue = invoices.filter(i => i.status === "overdue").reduce((s, i) => s + Number(i.amount), 0);
  const totalExpenses = expenses.reduce((s, e) => s + Number(e.amount), 0);
  const uncategorizedExpenses = expenses.filter(e => !e.category || e.category === "other");
  const overdueInvoices = invoices.filter(i => i.status === "overdue");
  const oldPendingInvoices = invoices.filter(i => i.status === "sent" && i.dueDate && i.dueDate < todayStr);

  const expensesByCategory = expenses.reduce((acc, e) => {
    const cat = e.category ?? "uncategorized";
    acc[cat] = (acc[cat] ?? 0) + Number(e.amount);
    return acc;
  }, {} as Record<string, number>);

  const revenueByClient: Record<string, number> = {};
  for (const inv of paidInvoices) {
    const c = inv.client ?? "Unknown";
    revenueByClient[c] = (revenueByClient[c] ?? 0) + Number(inv.amount);
  }
  const topClients = Object.entries(revenueByClient).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const monthlyRevenue: Record<string, number> = {};
  for (const inv of paidInvoices) {
    const m = inv.createdAt.toISOString().slice(0, 7);
    monthlyRevenue[m] = (monthlyRevenue[m] ?? 0) + Number(inv.amount);
  }
  const recentMonths = Object.entries(monthlyRevenue).sort((a, b) => a[0].localeCompare(b[0])).slice(-6);

  const proposalsSent = proposals.filter(p => p.status === "sent");
  const proposalsAccepted = proposals.filter(p => p.status === "accepted");
  const conversionRate = proposalsSent.length > 0
    ? Math.round((proposalsAccepted.length / (proposalsSent.length + proposalsAccepted.length)) * 100)
    : null;

  const salesTaxCollected = paidInvoices.reduce((s, i) => s + Number(i.salesTaxAmount ?? 0), 0);
  const salesTaxPending = invoices.filter(i => i.status === "sent").reduce((s, i) => s + Number(i.salesTaxAmount ?? 0), 0);

  const grossProfit = totalRevenue - totalExpenses;
  const gpMargin = totalRevenue > 0 ? Math.round((grossProfit / totalRevenue) * 100) : null;

  const seTaxRate = 0.1413;
  const federalEffectiveTaxRate = 0.22;
  const combinedTaxRate = seTaxRate + federalEffectiveTaxRate;
  const taxableIncome = Math.max(0, totalRevenue - totalExpenses);
  const estimatedTaxOwed = taxableIncome * combinedTaxRate;
  const quarterlyPaymentDue = estimatedTaxOwed / 4;

  const quarterDates = getQuarterlyTaxDates(currentYear);
  const upcomingQuarters = quarterDates.filter(q => q.dueDate >= todayStr);

  const systemPrompt = `${nowBlock()}

You are Geoffrey, Chief AI Accountant and Strategic Financial Advisor for Accelerated Experiences LLC — a creative services company (video production, photography, branding, YouTube, social media). You are the company's fractional CFO: analytically sharp, deeply expert in US business accounting and tax law for creative service businesses, and equally expert in business growth strategy for service agencies.

OWNER PROFILE: Anthony Esposito (Italian/Irish heritage, white-owned business). Do NOT recommend grants, programs, or funding sources that require minority-owned business status, BIPOC certification, Black/Hispanic/Latino/Native American ownership, or similar eligibility criteria Anthony does not meet. Only recommend grants AE is actually eligible for.

YOUR ACCOUNTING EXPERTISE:
- Revenue recognition for service businesses: project-based income, retainer billing, milestone payments
- Cash flow management: receivables aging, DSO (days sales outstanding), collection prioritization
- Creative industry deductions: equipment depreciation (Section 179), software subscriptions, home office, vehicle mileage for productions, talent/contractor payments (1099 obligations), location fees, props, travel for shoots, professional development
- Tax planning: quarterly estimated payments, self-employment (SE) tax at 15.3% (half deductible), bonus depreciation, entity structure optimization (LLC vs S-Corp election), SEP-IRA or Solo 401(k) contributions to reduce taxable income
- Expense categorization: proper GL coding for creative agency spend (COGS vs SG&A, direct project costs vs overhead)
- Financial health indicators: GP margin benchmarks for creative agencies (typical 40–60%), accounts receivable health, burn rate, cash runway
- Sales tax: most creative services are not subject to sales tax in most US states, but digital products and certain deliverables may be; flag if applicable

YOUR STRATEGIC ADVISORY EXPERTISE — you think like a growth-focused CFO:
- Pricing strategy: service businesses should target 50%+ gross margins; price based on value delivered, not hours worked
- Revenue concentration risk: if any single client is >30% of revenue, flag as business risk
- Pipeline velocity: track time from estimate to signed contract to first invoice to payment
- Recurring revenue: retainer arrangements are 3–4x more valuable than project work — always recommend converting repeat clients
- Team leverage: subcontractors as a percentage of revenue impacts margins significantly; track this
- Wealth building for small business owners: LLC profits flow to personal income; optimize with retirement accounts (SEP-IRA: up to 25% of net self-employment income), health insurance deduction, home office, equipment
- Business milestones: help the owner see the path from current state to $500K, $1M, and $2M annual revenue
- Agency growth playbook: upsell existing clients, build referral systems, develop productized service packages, reduce scope creep with clear contracts

CRITICAL RULE: You NEVER act unilaterally. Every recommended action — sending a report, filing anything, contacting a client, making a payment — requires admin approval. You are an advisor; the team makes decisions.

Respond in JSON matching this EXACT shape (no markdown, no extra keys):
{
  "summary": "2-3 sentence financial health assessment with the single most important priority right now",
  "taxSnapshot": {
    "estimatedAnnualRevenue": number,
    "estimatedTaxableIncome": number,
    "estimatedTaxLiability": number,
    "estimatedTaxRate": number,
    "seTaxLiability": number,
    "potentialDeductions": number,
    "quarterlyPaymentDue": number,
    "notes": string
  },
  "observations": [{ "severity": "high"|"medium"|"low", "category": string, "title": string, "detail": string }],
  "actionRequests": [{ "type": string, "title": string, "description": string, "amount": number|null, "category": string|null, "priority": "high"|"medium"|"low" }],
  "taxTips": [string],
  "organizedExpenses": [{ "expenseId": number, "currentCategory": string, "suggestedCategory": string, "reason": string }],
  "strategicAdvisory": [{ "category": "pricing"|"pipeline"|"collections"|"growth"|"operations"|"tax_optimization"|"risk"|"wealth", "title": string, "insight": string, "action": string, "impact": "high"|"medium"|"low" }],
  "wealthPlaybook": [{ "milestone": string, "title": string, "detail": string, "timeframe": string, "priority": "now"|"soon"|"later" }],
  "agentBroadcasts": [{ "to": string, "subject": string, "message": string }]
}`;

  const dataContext = `FINANCIAL OVERVIEW — ${todayStr} (Q${currentQuarter} ${currentYear}):
Collected Revenue (all-time paid): $${totalRevenue.toLocaleString()}
Pending Revenue (sent invoices): $${pendingRevenue.toLocaleString()}
Overdue Revenue: $${overdueRevenue.toLocaleString()} (${overdueInvoices.length} invoices)
Total Expenses: $${totalExpenses.toLocaleString()}
Gross Profit: $${grossProfit.toLocaleString()} | GP Margin: ${gpMargin !== null ? gpMargin + "%" : "N/A"}
Active Projects: ${projects.length}
Sales Tax Collected: $${salesTaxCollected.toLocaleString()} | Sales Tax Pending: $${salesTaxPending.toLocaleString()}

MONTHLY REVENUE TREND (last 6 months):
${recentMonths.map(([m, v]) => `• ${m}: $${v.toLocaleString()}`).join("\n") || "• No monthly data yet"}

TOP CLIENTS BY COLLECTED REVENUE:
${topClients.map(([c, v]) => `• ${c}: $${v.toLocaleString()}`).join("\n") || "• No client revenue data yet"}

EXPENSE BREAKDOWN BY CATEGORY:
${Object.entries(expensesByCategory).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => `• ${cat}: $${amt.toLocaleString()}`).join("\n") || "• No expense data yet"}

UNCATEGORIZED/OTHER EXPENSES (${uncategorizedExpenses.length} items):
${uncategorizedExpenses.slice(0, 15).map(e => `• ID:${e.id} — ${e.title}: $${Number(e.amount).toLocaleString()} (vendor: ${e.vendor ?? "—"})`).join("\n") || "• None"}

OVERDUE INVOICES (${overdueInvoices.length}):
${overdueInvoices.slice(0, 10).map(i => `• ${i.invoiceNumber ?? "INV"} — ${i.client ?? "Unknown"}: $${Number(i.amount).toLocaleString()} (due: ${i.dueDate ?? "—"})`).join("\n") || "• None"}

PAST-DUE SENT INVOICES (${oldPendingInvoices.length}):
${oldPendingInvoices.slice(0, 10).map(i => `• ${i.invoiceNumber ?? "INV"} — ${i.client ?? "Unknown"}: $${Number(i.amount).toLocaleString()} (due: ${i.dueDate ?? "—"})`).join("\n") || "• None"}

PIPELINE:
Open Estimates: ${estimates.filter(e => e.status === "sent" || e.status === "draft").length} ($${estimates.filter(e => e.status === "sent" || e.status === "draft").reduce((s, e) => s + Number(e.total ?? 0), 0).toLocaleString()})
Accepted Estimates: ${estimates.filter(e => e.status === "accepted").length}
Open Proposals: ${proposals.filter(p => p.status === "sent").length} ($${proposals.filter(p => p.status === "sent").reduce((s, p) => s + Number(p.total ?? 0), 0).toLocaleString()})
Won Proposals: ${proposalsAccepted.length} | Proposal Conversion Rate: ${conversionRate !== null ? conversionRate + "%" : "insufficient data"}

TAX ESTIMATE (combined federal + SE tax):
Taxable Income: $${taxableIncome.toLocaleString()}
SE Tax (14.13% net, half deductible): $${Math.round(taxableIncome * seTaxRate).toLocaleString()}
Federal Income Tax (est. 22% bracket): $${Math.round(taxableIncome * federalEffectiveTaxRate).toLocaleString()}
Combined Tax Liability: $${Math.round(estimatedTaxOwed).toLocaleString()} (est. ${Math.round(combinedTaxRate * 100)}%)
Quarterly Payment Target: $${Math.round(quarterlyPaymentDue).toLocaleString()} per quarter
Potential Deductions (all expenses): $${totalExpenses.toLocaleString()}

UPCOMING QUARTERLY TAX DUE DATES (${currentYear}):
${upcomingQuarters.map(q => `• ${q.quarter} ${q.year} (${q.period}): due ${q.dueDate} — est. $${Math.round(quarterlyPaymentDue).toLocaleString()}`).join("\n")}

Recent Expenses (last 10):
${expenses.slice(0, 10).map(e => `• ${e.title}: $${Number(e.amount).toLocaleString()} (${e.category ?? "uncategorized"}, vendor: ${e.vendor ?? "—"}, date: ${e.date})`).join("\n")}`;

  const completion = await openrouter.chat.completions.create({
    model: resolveModel("geoffrey", requestedModel as string),
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `${dataContext}\n\nAnalyze the company finances. Provide:\n1. Sharp financial observations and flags\n2. Specific tax planning recommendations for this creative LLC\n3. Strategic advisory on how to grow revenue, increase margins, and build wealth\n4. A wealth playbook with concrete milestones from current revenue toward $1M+/year\n5. Any broadcasts to the team (PMs, sales, ops) that accounting needs to communicate\n\nBe specific with dollar amounts. Be direct. Be the best CFO this company has ever had.`,
      },
    ],
    max_tokens: 8192,
  });

  const raw = extractJSON(completion.choices[0]?.message?.content ?? "{}");
  let analysis: Record<string, unknown>;
  try { analysis = JSON.parse(raw); } catch { analysis = {}; }

  const quarterlyTaxCalendar = getQuarterlyTaxDates(currentYear).map(q => ({
    ...q,
    estimatedPayment: Math.round(quarterlyPaymentDue),
    status: q.dueDate < todayStr ? "past" : q.dueDate <= `${currentYear}-${String(currentMonth + 2).padStart(2, "0")}-15` ? "upcoming" : "future",
  }));

  res.json({
    analysis,
    financials: {
      totalRevenue,
      pendingRevenue,
      overdueRevenue,
      totalExpenses,
      grossProfit,
      gpMargin,
      taxableIncome,
      estimatedTaxOwed: Math.round(estimatedTaxOwed),
      seTaxOwed: Math.round(taxableIncome * seTaxRate),
      quarterlyPaymentDue: Math.round(quarterlyPaymentDue),
      salesTaxCollected,
      salesTaxPending,
      overdueCount: overdueInvoices.length,
      expenseCount: expenses.length,
      uncategorizedCount: uncategorizedExpenses.length,
      conversionRate,
    },
    quarterlyTaxCalendar,
  });
});

router.post("/geoffrey/submit-requests", requireAccountingAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const { requests } = req.body;
  if (!Array.isArray(requests) || requests.length === 0) {
    res.status(400).json({ error: "requests array is required" }); return;
  }
  const inserted = await Promise.all(
    requests.map((r: any) =>
      db.insert(geoffreyRequests).values({
        tenantId: tid,
        type: r.type ?? "general",
        title: r.title ?? r.description ?? "Request",
        description: r.description ?? null,
        amount: r.amount != null ? String(r.amount) : null,
        category: r.category ?? null,
        actionData: r.actionData ?? null,
        status: "pending",
      }).returning().then(rows => rows[0])
    )
  );
  res.status(201).json(inserted.map(serializeRequest));
});

// ── Opportunity Radar ─────────────────────────────────────────────────────────
router.post("/geoffrey/opportunity-radar", requireAccountingAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];
  const threeMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 3, 1).toISOString().split("T")[0];
  const sixMonthsAgo  = new Date(today.getFullYear(), today.getMonth() - 6, 1).toISOString().split("T")[0];
  const { model: requestedModel } = req.body;

  const [expenses, invoices, projects] = await Promise.all([
    db.select().from(expensesTable).where(eq(expensesTable.tenantId, tid)).orderBy(desc(expensesTable.createdAt)).limit(150),
    db.select().from(invoicesTable).where(eq(invoicesTable.tenantId, tid)).orderBy(desc(invoicesTable.createdAt)).limit(150),
    db.select().from(projectsTable).where(eq(projectsTable.tenantId, tid)).orderBy(desc(projectsTable.createdAt)).limit(60),
  ]);

  const paidInvoices  = invoices.filter(i => i.status === "paid");
  const totalRevenue  = paidInvoices.reduce((s, i) => s + Number(i.amount), 0);
  const totalExpenses = expenses.reduce((s, e) => s + Number(e.amount), 0);

  const revenueByService: Record<string, number> = {};
  for (const inv of paidInvoices) {
    const n = (inv.notes ?? "").toLowerCase();
    const svc =
      n.includes("video") || n.includes("film") ? "Video Production" :
      n.includes("photo") ? "Photography" :
      n.includes("brand") || n.includes("logo") || n.includes("design") ? "Branding & Design" :
      n.includes("social") || n.includes("content") ? "Social Media" :
      n.includes("podcast") || n.includes("audio") ? "Podcast / Audio" :
      n.includes("web") || n.includes("app") ? "Web / App Dev" :
      n.includes("game") || n.includes("gaming") ? "Gaming / Interactive" :
      "General Services";
    revenueByService[svc] = (revenueByService[svc] ?? 0) + Number(inv.amount);
  }

  const recentExp = expenses.filter(e => e.date >= threeMonthsAgo);
  const priorExp  = expenses.filter(e => e.date < threeMonthsAgo && e.date >= sixMonthsAgo);
  const recentByCat = recentExp.reduce((a, e) => { const c = e.category ?? "other"; a[c] = (a[c] ?? 0) + Number(e.amount); return a; }, {} as Record<string, number>);
  const priorByCat  = priorExp.reduce((a, e) => { const c = e.category ?? "other"; a[c] = (a[c] ?? 0) + Number(e.amount); return a; }, {} as Record<string, number>);

  const gpMargin = totalRevenue > 0 ? Math.round(((totalRevenue - totalExpenses) / totalRevenue) * 100) : 0;
  const overdueAmt = invoices.filter(i => i.status === "overdue").reduce((s, i) => s + Number(i.amount), 0);
  const pendingAmt = invoices.filter(i => i.status === "sent").reduce((s, i) => s + Number(i.amount), 0);

  const systemPrompt = `You are Geoffrey, Chief AI Financial Strategist for Accelerated Experiences LLC (creative agency: video, photo, branding, social, podcast, gaming, AI tools). Today: ${todayStr}. Founders: Anthony & Jessica.

Analyze the financial data and return ONLY a valid JSON object (no markdown) with these exact keys:
{
  "topPriority": "single most important financial action this week (1 sentence, specific dollar amount if possible)",
  "revenueStreams": [{ "service": string, "revenue": number, "marginEstimate": string, "action": string, "priority": "high"|"medium"|"low" }],
  "costLeaks": [{ "category": string, "amount": number, "flag": string, "recommendation": string, "severity": "high"|"medium"|"low" }],
  "opportunities": [{ "title": string, "insight": string, "potentialRevenue": string, "effort": "low"|"medium"|"high", "timeframe": string, "action": string }],
  "revenueHealthScore": number,
  "healthLabel": "Excellent"|"Good"|"Fair"|"At Risk"|"Critical",
  "healthColor": "green"|"blue"|"yellow"|"orange"|"red"
}

Include 3-5 revenue streams, 2-4 cost leaks (flag category spikes month-over-month), 3-4 high-margin opportunities AE is not yet pursuing or underpricing. Health score 0-100 based on GP margin vs 50% target, AR aging, pipeline. Be specific with dollar amounts.`;

  const dataCtx = `REVENUE BY SERVICE:
${Object.entries(revenueByService).sort((a,b)=>b[1]-a[1]).map(([s,v])=>`• ${s}: $${v.toLocaleString()}`).join("\n") || "• No data yet"}

TOTALS: Revenue $${totalRevenue.toLocaleString()} | Expenses $${totalExpenses.toLocaleString()} | GP $${(totalRevenue-totalExpenses).toLocaleString()} (${gpMargin}%)
Overdue: $${overdueAmt.toLocaleString()} | Pending: $${pendingAmt.toLocaleString()}

EXPENSE TREND (recent 3mo vs prior 3mo):
${Object.entries(recentByCat).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`• ${c}: $${v.toLocaleString()} now vs $${Math.round(priorByCat[c]??0).toLocaleString()} prior`).join("\n") || "• No data"}

ACTIVE PROJECTS (${projects.filter(p=>p.status==="active").length}):
${projects.filter(p=>p.status==="active").slice(0,8).map(p=>`• ${p.name} — ${p.serviceType??"General"} — $${p.budget?Number(p.budget).toLocaleString():"N/A"}`).join("\n")||"• None"}`;

  try {
    const completion = await openrouter.chat.completions.create({
      model: resolveModel("geoffrey", requestedModel as string),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: dataCtx + "\n\nIdentify cost leaks, revenue stream gaps, and new high-margin opportunities. Include revenue health score." },
      ],
      max_tokens: 3000,
    });

    const raw = extractJSON(completion.choices[0]?.message?.content ?? "{}");
    let radar: Record<string, unknown>;
    try { radar = JSON.parse(raw); }
    catch { radar = { topPriority: "Run full Geoffrey analysis for details.", revenueStreams: [], costLeaks: [], opportunities: [], revenueHealthScore: 50, healthLabel: "Fair", healthColor: "yellow" }; }

    res.json({ radar, meta: { totalRevenue, totalExpenses, gpMargin, overdueAmt, pendingAmt, todayStr } });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Opportunity radar failed" });
  }
});

// ── Grant Hunt ────────────────────────────────────────────────────────────────
router.post("/geoffrey/hunt-grants", requireEmployeeAuth, async (req, res): Promise<void> => {
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];

  const GRANT_DB = [
    { id: "amber-grant",         name: "Amber Grant for Women",                           funder: "WomensNet",                   maxAmount: 10000,   amountLabel: "$10K/mo + $25K annual",    category: "Women-Owned Business",  deadlineRaw: "2026-05-31", deadlineDisplay: "May 31 — THIS MONTH",       fit: "strong",    tags: ["Women-Owned", "Monthly"],                    url: "https://ambergrantsforwomen.com",                   description: "Monthly $10K + one annual $25K. If AE has a woman founder/co-founder, apply every month without fail." },
    { id: "comcast-lift",        name: "Comcast NBCUniversal LIFT Labs",                   funder: "Comcast / NBCUniversal",      maxAmount: 50000,   amountLabel: "Up to $50K + distribution", category: "Media & Technology",   deadlineRaw: "2026-09-30", deadlineDisplay: "Cohort Q3 2026 — Opening Soon", fit: "strong", tags: ["Media", "Distribution", "Content"],            url: "https://www.comcastliftlabs.com",                  description: "Funding plus access to NBC/Comcast distribution network. Excellent for content production and media distribution ambitions." },
    { id: "sbir",                name: "SBIR — Small Business Innovation Research",         funder: "U.S. Small Business Admin",   maxAmount: 1500000, amountLabel: "Phase I: $150K → Phase II: $1.5M", category: "Technology",     deadlineRaw: "2026-07-15", deadlineDisplay: "Rolling by agency",          fit: "good",      tags: ["Technology", "AI", "Federal", "Non-Dilutive"], url: "https://www.sbir.gov",                             description: "Largest federal small-business grant program. AEHub's AI creative tools platform is a strong R&D angle for Phase I." },
    { id: "nea-media",           name: "NEA — Media Arts Grants",                           funder: "National Endowment for Arts", maxAmount: 100000,  amountLabel: "$10K–$100K",               category: "Arts & Media",          deadlineRaw: "2026-10-01", deadlineDisplay: "Oct 2026 — Build Now",       fit: "excellent", tags: ["Federal", "Film", "Video", "Podcast"],          url: "https://www.arts.gov/grants",                      description: "Federal grants for film, video, animation, documentary, digital storytelling. AE's video + podcast output is a strong fit." },
    { id: "ifp",                 name: "Film Independent Narrative Lab",                    funder: "Film Independent",            maxAmount: 25000,   amountLabel: "$10K–$25K + mentorship",   category: "Independent Film",      deadlineRaw: "2026-10-15", deadlineDisplay: "Oct 15, 2026",               fit: "good",      tags: ["Film", "Narrative", "Mentorship"],              url: "https://www.filmindependent.org/lab/narrative",    description: "Funding + mentorship from industry professionals. Great if AE is producing narrative film or ambitious branded content." },
    { id: "creative-capital",    name: "Creative Capital Award",                            funder: "Creative Capital Foundation", maxAmount: 50000,   amountLabel: "$50,000 + ongoing support", category: "Innovative Arts",      deadlineRaw: "2027-01-15", deadlineDisplay: "Jan 2027 — Start Now",       fit: "good",      tags: ["Arts", "Prestige", "Career Development"],      url: "https://creative-capital.org/awards",              description: "One of the most prestigious arts grants. $50K + ongoing development support. For AE's most ambitious, boundary-pushing creative projects." },
  ].map(g => {
    const dl = new Date(g.deadlineRaw);
    const days = Math.ceil((dl.getTime() - today.getTime()) / 86400000);
    const urgency = days < 0 ? "past" : days <= 14 ? "critical" : days <= 30 ? "urgent" : days <= 90 ? "soon" : "future";
    const urgencyColor = days < 0 ? "gray" : days <= 14 ? "red" : days <= 30 ? "orange" : days <= 90 ? "amber" : "blue";
    return { ...g, daysUntil: days, urgency, urgencyColor };
  }).sort((a, b) => {
    if (a.urgency === "past" && b.urgency !== "past") return 1;
    if (b.urgency === "past" && a.urgency !== "past") return -1;
    const fitRank: Record<string, number> = { excellent: 0, strong: 1, good: 2 };
    const fitDiff = (fitRank[a.fit] ?? 2) - (fitRank[b.fit] ?? 2);
    return fitDiff !== 0 ? fitDiff : a.daysUntil - b.daysUntil;
  });

  const topActionable = GRANT_DB.filter(g => g.urgency !== "past").slice(0, 3);
  res.json({ grants: GRANT_DB, topActionable, asOf: todayStr });
});

export default router;
