import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, invoicesTable, clientAccounts } from "@workspace/db";
import { requireClientAuth, requireEmployeeAuth, getTenantId } from "../middlewares/authMiddleware";
import {
  CreateInvoiceBody,
  GetInvoiceParams,
  GetInvoiceResponse,
  UpdateInvoiceParams,
  UpdateInvoiceBody,
  UpdateInvoiceResponse,
  DeleteInvoiceParams,
  ListInvoicesResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function formatInvoice(inv: typeof invoicesTable.$inferSelect) {
  return {
    ...inv,
    amount: Number(inv.amount),
    salesTaxRate: inv.salesTaxRate != null ? Number(inv.salesTaxRate) : null,
    salesTaxAmount: inv.salesTaxAmount != null ? Number(inv.salesTaxAmount) : null,
    createdAt: inv.createdAt.toISOString(),
  };
}

router.get("/invoices", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const invoices = await db.select().from(invoicesTable).where(eq(invoicesTable.tenantId, tid)).orderBy(desc(invoicesTable.createdAt));
  res.json(ListInvoicesResponse.parse(invoices.map(formatInvoice)));
});

router.post("/invoices", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const parsed = CreateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const count = await db.select().from(invoicesTable).where(eq(invoicesTable.tenantId, tid));
  const invoiceNumber = `INV-${String(count.length + 1).padStart(4, "0")}`;

  const taxRate = (parsed.data as any).salesTaxRate ?? null;
  const taxAmount = (parsed.data as any).salesTaxAmount ?? null;

  const [invoice] = await db.insert(invoicesTable).values({
    tenantId: tid,
    invoiceNumber,
    projectId: parsed.data.projectId ?? null,
    projectName: null,
    client: parsed.data.client,
    clientAccountId: parsed.data.clientAccountId ?? null,
    amount: String(parsed.data.amount),
    salesTaxRate: taxRate != null ? String(taxRate) : null,
    salesTaxAmount: taxAmount != null ? String(taxAmount) : null,
    status: parsed.data.status as "draft" | "sent" | "paid" | "overdue" | "cancelled",
    dueDate: parsed.data.dueDate ?? null,
    paidAt: null,
    notes: parsed.data.notes ?? null,
  }).returning();

  res.status(201).json(GetInvoiceResponse.parse(formatInvoice(invoice)));
});

router.get("/invoices/for-client", requireClientAuth, async (req, res): Promise<void> => {
  const session = (req as any).session;
  const tid = getTenantId(req);
  const clientId: string | undefined = session.clientId;
  if (!clientId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const [account] = await db.select().from(clientAccounts).where(eq(clientAccounts.id, clientId)).limit(1);
  if (!account) { res.status(401).json({ error: "Unauthorized" }); return; }

  const invoices = await db
    .select()
    .from(invoicesTable)
    .where(and(eq(invoicesTable.tenantId, tid), eq(invoicesTable.clientAccountId, clientId)))
    .orderBy(desc(invoicesTable.createdAt));
  res.json(invoices.filter(i => i.status !== "cancelled" && i.status !== "draft").map(formatInvoice));
});

router.get("/invoices/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = GetInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [invoice] = await db.select().from(invoicesTable).where(and(eq(invoicesTable.id, params.data.id), eq(invoicesTable.tenantId, tid)));
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  res.json(GetInvoiceResponse.parse(formatInvoice(invoice)));
});

router.patch("/invoices/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = UpdateInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updateData: Record<string, unknown> = {};
  const pd = parsed.data as any;
  if (pd.client !== undefined) updateData.client = pd.client;
  if (pd.clientAccountId !== undefined) updateData.clientAccountId = pd.clientAccountId;
  if (pd.amount !== undefined) updateData.amount = String(pd.amount);
  if (pd.salesTaxRate !== undefined) updateData.salesTaxRate = pd.salesTaxRate != null ? String(pd.salesTaxRate) : null;
  if (pd.salesTaxAmount !== undefined) updateData.salesTaxAmount = pd.salesTaxAmount != null ? String(pd.salesTaxAmount) : null;
  if (pd.status !== undefined) updateData.status = pd.status;
  if (pd.dueDate !== undefined) updateData.dueDate = pd.dueDate;
  if (pd.paidAt !== undefined) updateData.paidAt = pd.paidAt;
  if (pd.notes !== undefined) updateData.notes = pd.notes;

  const [invoice] = await db.update(invoicesTable).set(updateData).where(and(eq(invoicesTable.id, params.data.id), eq(invoicesTable.tenantId, tid))).returning();
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  res.json(UpdateInvoiceResponse.parse(formatInvoice(invoice)));
});

router.delete("/invoices/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = DeleteInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [invoice] = await db.delete(invoicesTable).where(and(eq(invoicesTable.id, params.data.id), eq(invoicesTable.tenantId, tid))).returning();
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
