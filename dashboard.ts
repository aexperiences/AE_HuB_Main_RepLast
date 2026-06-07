import { Router, type IRouter } from "express";
import { and, eq, desc } from "drizzle-orm";
import { db, projectsTable, invoicesTable, deadlinesTable, estimatesTable, proposalsTable, contractsTable } from "@workspace/db";
import {
  GetDashboardSummaryResponse,
  GetRecentActivityResponse,
  GetUpcomingDeadlinesResponse,
  GetRevenueByMonthResponse,
} from "@workspace/api-zod";
import { requireEmployeeAuth, getTenantId } from "../middlewares/authMiddleware";

const router: IRouter = Router();

router.get("/dashboard/summary", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const [projects, invoices, deadlines, estimates] = await Promise.all([
    db.select().from(projectsTable).where(eq(projectsTable.tenantId, tid)),
    db.select().from(invoicesTable).where(eq(invoicesTable.tenantId, tid)),
    db.select().from(deadlinesTable).where(eq(deadlinesTable.tenantId, tid)),
    db.select().from(estimatesTable).where(eq(estimatesTable.tenantId, tid)),
  ]);

  const today = new Date().toISOString().split("T")[0];

  const totalRevenue = invoices
    .filter(i => i.status === "paid")
    .reduce((sum, i) => sum + Number(i.amount), 0);

  const paidInvoices = invoices.filter(i => i.status === "paid").length;
  const pendingInvoices = invoices.filter(i => i.status === "sent" || i.status === "draft").length;
  const overdueInvoices = invoices.filter(i => i.status === "overdue").length;
  const activeProjects = projects.filter(p => p.status === "active").length;
  const completedProjects = projects.filter(p => p.status === "completed").length;
  const internalProjects = projects.filter(p => p.projectType === "internal");
  const externalProjects = projects.filter(p => p.projectType !== "internal");
  const activeInternalProjects = internalProjects.filter(p => p.status === "active").length;
  const completedInternalProjects = internalProjects.filter(p => p.status === "completed").length;
  const activeExternalProjects = externalProjects.filter(p => p.status === "active").length;
  const completedExternalProjects = externalProjects.filter(p => p.status === "completed").length;

  const overdueDeadlines = deadlines.filter(d => !d.completed && d.dueDate < today).length;
  const sevenDays = new Date();
  sevenDays.setDate(sevenDays.getDate() + 7);
  const sevenDaysStr = sevenDays.toISOString().split("T")[0];
  const upcomingDeadlines = deadlines.filter(d => !d.completed && d.dueDate >= today && d.dueDate <= sevenDaysStr).length;

  const totalEstimatesValue = estimates.reduce((sum, e) => sum + Number(e.total), 0);
  const acceptedEstimates = estimates.filter(e => e.status === "accepted").length;

  res.json(GetDashboardSummaryResponse.parse({
    totalRevenue,
    paidInvoices,
    pendingInvoices,
    overdueInvoices,
    activeProjects,
    completedProjects,
    activeInternalProjects,
    completedInternalProjects,
    activeExternalProjects,
    completedExternalProjects,
    overdueDeadlines,
    upcomingDeadlines,
    totalEstimatesValue,
    acceptedEstimates,
  }));
});

router.get("/dashboard/recent-activity", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const [projects, invoices, deadlines, estimates, proposals, contracts] = await Promise.all([
    db.select().from(projectsTable).where(eq(projectsTable.tenantId, tid)).orderBy(desc(projectsTable.createdAt)).limit(5),
    db.select().from(invoicesTable).where(eq(invoicesTable.tenantId, tid)).orderBy(desc(invoicesTable.createdAt)).limit(5),
    db.select().from(deadlinesTable).where(eq(deadlinesTable.tenantId, tid)).orderBy(desc(deadlinesTable.createdAt)).limit(5),
    db.select().from(estimatesTable).where(eq(estimatesTable.tenantId, tid)).orderBy(desc(estimatesTable.createdAt)).limit(5),
    db.select().from(proposalsTable).where(eq(proposalsTable.tenantId, tid)).orderBy(desc(proposalsTable.createdAt)).limit(5),
    db.select().from(contractsTable).where(eq(contractsTable.tenantId, tid)).orderBy(desc(contractsTable.createdAt)).limit(5),
  ]);

  const activities = [
    ...projects.map(p => ({
      id: p.id,
      type: "project" as const,
      title: p.name,
      description: `Project ${p.status.replace("_", " ")}${p.client ? ` for ${p.client}` : ""}`,
      createdAt: p.createdAt.toISOString(),
    })),
    ...invoices.map(i => ({
      id: i.id + 1000,
      type: "invoice" as const,
      title: i.invoiceNumber,
      description: `$${Number(i.amount).toLocaleString()} invoice for ${i.client} — ${i.status}`,
      createdAt: i.createdAt.toISOString(),
    })),
    ...deadlines.map(d => ({
      id: d.id + 2000,
      type: "deadline" as const,
      title: d.title,
      description: `Due ${d.dueDate} — ${d.priority} priority`,
      createdAt: d.createdAt.toISOString(),
    })),
    ...estimates.map(e => ({
      id: e.id + 3000,
      type: "estimate" as const,
      title: e.title,
      description: `$${Number(e.total).toLocaleString()} estimate for ${e.client} — ${e.status}`,
      createdAt: e.createdAt.toISOString(),
    })),
    ...proposals.map(p => ({
      id: p.id + 5000,
      type: "estimate" as const,
      title: p.title,
      description: `$${Number(p.total).toLocaleString()} proposal for ${p.clientName} — ${p.status}`,
      createdAt: p.createdAt.toISOString(),
    })),
    ...contracts.map(c => ({
      id: c.id + 6000,
      type: "project" as const,
      title: c.title,
      description: `Contract for ${c.clientName} — ${c.status}`,
      createdAt: c.createdAt.toISOString(),
    })),
  ];

  activities.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json(GetRecentActivityResponse.parse(activities.slice(0, 10)));
});

router.get("/dashboard/upcoming-deadlines", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const today = new Date().toISOString().split("T")[0];
  const sevenDays = new Date();
  sevenDays.setDate(sevenDays.getDate() + 7);
  const sevenDaysStr = sevenDays.toISOString().split("T")[0];

  const deadlines = await db.select().from(deadlinesTable).where(eq(deadlinesTable.tenantId, tid)).orderBy(deadlinesTable.dueDate);
  const upcoming = deadlines.filter(d => !d.completed && d.dueDate >= today && d.dueDate <= sevenDaysStr);

  res.json(GetUpcomingDeadlinesResponse.parse(upcoming.map(d => ({
    ...d,
    createdAt: d.createdAt.toISOString(),
  }))));
});

router.get("/dashboard/revenue-by-month", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const invoices = await db.select().from(invoicesTable).where(and(eq(invoicesTable.tenantId, tid), eq(invoicesTable.status, "paid")));

  const byMonth: Record<string, { revenue: number; invoiceCount: number }> = {};
  for (const inv of invoices) {
    const month = inv.createdAt.toISOString().substring(0, 7);
    if (!byMonth[month]) byMonth[month] = { revenue: 0, invoiceCount: 0 };
    byMonth[month].revenue += Number(inv.amount);
    byMonth[month].invoiceCount += 1;
  }

  const result = Object.entries(byMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([month, data]) => ({ month, ...data }));

  res.json(GetRevenueByMonthResponse.parse(result));
});

export default router;
