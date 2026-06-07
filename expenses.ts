import { requireEmployeeAuth, requireAccountingAuth, getTenantId } from "../middlewares/authMiddleware";
import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, expensesTable } from "@workspace/db";
import {
  CreateExpenseBody,
  UpdateExpenseParams,
  UpdateExpenseBody,
  UpdateExpenseResponse,
  DeleteExpenseParams,
  ListExpensesResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

type ExpCategory = typeof expensesTable.$inferSelect["category"];
type ExpPayment = typeof expensesTable.$inferSelect["paymentMethod"];
type ExpStatus  = typeof expensesTable.$inferSelect["status"];

const toExpense = (e: typeof expensesTable.$inferSelect) => ({
  ...e,
  amount: Number(e.amount),
  markupPct: e.markupPct != null ? Number(e.markupPct) : null,
  isBillable: e.isBillable ?? true,
  createdAt: e.createdAt.toISOString(),
});

router.get("/expenses/summary", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const expenses = await db.select().from(expensesTable).where(eq(expensesTable.tenantId, tid));

  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const totalAll = expenses.reduce((s, e) => s + Number(e.amount), 0);
  const totalThisMonth = expenses.filter(e => e.date.startsWith(thisMonth)).reduce((s, e) => s + Number(e.amount), 0);
  const billableWithMarkup = expenses
    .filter(e => e.isBillable && e.markupPct)
    .reduce((s, e) => s + Number(e.amount) * (1 + Number(e.markupPct) / 100), 0);
  const pendingReimbursement = expenses
    .filter(e => e.paymentMethod === "reimbursable" && e.status !== "reimbursed" && e.status !== "voided")
    .reduce((s, e) => s + Number(e.amount), 0);

  const catMap = new Map<string, { total: number; count: number }>();
  for (const e of expenses) {
    const key = e.category ?? "other";
    const prev = catMap.get(key) ?? { total: 0, count: 0 };
    catMap.set(key, { total: prev.total + Number(e.amount), count: prev.count + 1 });
  }
  const byCategory = Array.from(catMap.entries())
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.total - a.total);

  const monthMap = new Map<string, { total: number; count: number }>();
  for (const e of expenses) {
    const key = e.date.slice(0, 7);
    const prev = monthMap.get(key) ?? { total: 0, count: 0 };
    monthMap.set(key, { total: prev.total + Number(e.amount), count: prev.count + 1 });
  }
  const byMonth = Array.from(monthMap.entries())
    .map(([month, v]) => ({ month, ...v }))
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-6);

  res.json({ totalAll, totalThisMonth, billableWithMarkup, pendingReimbursement, byCategory, byMonth });
});

router.get("/expenses", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const projectId = req.query.projectId ? Number(req.query.projectId) : undefined;
  const expenses = projectId
    ? await db.select().from(expensesTable).where(and(eq(expensesTable.tenantId, tid), eq(expensesTable.projectId, projectId))).orderBy(desc(expensesTable.createdAt))
    : await db.select().from(expensesTable).where(eq(expensesTable.tenantId, tid)).orderBy(desc(expensesTable.createdAt));
  res.json(ListExpensesResponse.parse(expenses.map(toExpense)));
});

router.post("/expenses", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const parsed = CreateExpenseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const markupPct = typeof req.body.markupPct === "number" ? String(req.body.markupPct) : null;
  const isBillable = typeof req.body.isBillable === "boolean" ? req.body.isBillable : true;

  const [expense] = await db.insert(expensesTable).values({
    tenantId: tid,
    title: parsed.data.title,
    amount: String(parsed.data.amount),
    category: (parsed.data.category ?? "other") as ExpCategory,
    projectId: parsed.data.projectId ?? null,
    projectName: parsed.data.projectName ?? null,
    vendor: parsed.data.vendor ?? null,
    markupPct,
    isBillable,
    paymentMethod: (parsed.data.paymentMethod ?? null) as ExpPayment | null,
    status: (parsed.data.status ?? "pending") as ExpStatus,
    submittedBy: parsed.data.submittedBy ?? null,
    date: parsed.data.date,
    notes: parsed.data.notes ?? null,
  }).returning();
  res.status(201).json(toExpense(expense));
});

router.patch("/expenses/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = UpdateExpenseParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateExpenseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const update: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) update.title = parsed.data.title;
  if (parsed.data.amount !== undefined) update.amount = String(parsed.data.amount);
  if (parsed.data.category !== undefined) update.category = parsed.data.category;
  if (parsed.data.vendor !== undefined) update.vendor = parsed.data.vendor;
  if (parsed.data.date !== undefined) update.date = parsed.data.date;
  if (parsed.data.notes !== undefined) update.notes = parsed.data.notes;
  if (typeof req.body.markupPct === "number") update.markupPct = String(req.body.markupPct);
  if (typeof req.body.isBillable === "boolean") update.isBillable = req.body.isBillable;
  if (parsed.data.paymentMethod !== undefined) update.paymentMethod = parsed.data.paymentMethod;
  if (parsed.data.status !== undefined) update.status = parsed.data.status;
  if (parsed.data.submittedBy !== undefined) update.submittedBy = parsed.data.submittedBy;

  const [expense] = await db.update(expensesTable).set(update).where(and(eq(expensesTable.id, params.data.id), eq(expensesTable.tenantId, tid))).returning();
  if (!expense) { res.status(404).json({ error: "Expense not found" }); return; }
  res.json(UpdateExpenseResponse.parse(toExpense(expense)));
});

router.delete("/expenses/:id", requireAccountingAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = DeleteExpenseParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [expense] = await db.delete(expensesTable).where(and(eq(expensesTable.id, params.data.id), eq(expensesTable.tenantId, tid))).returning();
  if (!expense) { res.status(404).json({ error: "Expense not found" }); return; }
  res.sendStatus(204);
});

export default router;
