import { requireAccountingAuth } from "../middlewares/authMiddleware";
import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, invoicesTable, timeEntriesTable, projectsTable, teamMembersTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/reports/revenue-by-client", requireAccountingAuth, async (req, res): Promise<void> => {
  const invoices = await db.select().from(invoicesTable);
  const map = new Map<string, { revenue: number; invoiceCount: number }>();
  for (const inv of invoices) {
    if (inv.status === "paid") {
      const existing = map.get(inv.client) ?? { revenue: 0, invoiceCount: 0 };
      map.set(inv.client, {
        revenue: existing.revenue + Number(inv.amount),
        invoiceCount: existing.invoiceCount + 1,
      });
    }
  }
  const result = Array.from(map.entries())
    .map(([client, data]) => ({ client, ...data }))
    .sort((a, b) => b.revenue - a.revenue);
  res.json(result);
});

router.get("/reports/team-performance", requireAccountingAuth, async (req, res): Promise<void> => {
  const [entries, members] = await Promise.all([
    db.select().from(timeEntriesTable),
    db.select().from(teamMembersTable),
  ]);
  const map = new Map<number, { memberName: string; totalHours: number; billableHours: number; hourlyRate: number }>();
  for (const member of members) {
    map.set(member.id, {
      memberName: member.name,
      totalHours: 0,
      billableHours: 0,
      hourlyRate: member.hourlyRate ? Number(member.hourlyRate) : 0,
    });
  }
  for (const entry of entries) {
    if (entry.teamMemberId && map.has(entry.teamMemberId)) {
      const m = map.get(entry.teamMemberId)!;
      m.totalHours += Number(entry.hours);
      if (entry.billable) m.billableHours += Number(entry.hours);
    }
  }
  const result = Array.from(map.entries()).map(([memberId, data]) => ({
    memberId,
    memberName: data.memberName,
    totalHours: data.totalHours,
    billableHours: data.billableHours,
    revenue: data.billableHours * data.hourlyRate,
  })).sort((a, b) => b.totalHours - a.totalHours);
  res.json(result);
});

router.get("/reports/profit-loss", requireAccountingAuth, async (req, res): Promise<void> => {
  const [invoices, entries, projects] = await Promise.all([
    db.select().from(invoicesTable),
    db.select().from(timeEntriesTable),
    db.select().from(projectsTable),
  ]);
  const totalRevenue = invoices.filter(i => i.status === "paid").reduce((s, i) => s + Number(i.amount), 0);
  const pendingRevenue = invoices.filter(i => i.status === "sent" || i.status === "overdue").reduce((s, i) => s + Number(i.amount), 0);
  const totalHours = entries.reduce((s, e) => s + Number(e.hours), 0);
  const billableHours = entries.filter(e => e.billable).reduce((s, e) => s + Number(e.hours), 0);
  const activeProjects = projects.filter(p => p.status === "active").length;
  const completedProjects = projects.filter(p => p.status === "completed").length;
  res.json({ totalRevenue, pendingRevenue, totalHours, billableHours, activeProjects, completedProjects });
});

export default router;
