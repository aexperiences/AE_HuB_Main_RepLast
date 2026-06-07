import { requireEmployeeAuth, requireClientAuth, getTenantId } from "../middlewares/authMiddleware";
import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, contractsTable, clientAccounts } from "@workspace/db";
import { onContractSigned } from "../lib/automation-triggers";
import {
  CreateContractBody,
  GetContractParams,
  GetContractResponse,
  UpdateContractParams,
  UpdateContractBody,
  UpdateContractResponse,
  DeleteContractParams,
  ListContractsResponse,
  SendContractParams,
  SendContractResponse,
  SignContractParams,
  SignContractBody,
  SignContractResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function formatContract(c: typeof contractsTable.$inferSelect) {
  return {
    ...c,
    createdAt: c.createdAt.toISOString(),
  };
}

router.get("/contracts", requireEmployeeAuth, async (req: Request, res: Response): Promise<void> => {
  const tid = getTenantId(req);
  const contracts = await db.select().from(contractsTable).where(eq(contractsTable.tenantId, tid)).orderBy(desc(contractsTable.createdAt));
  res.json(ListContractsResponse.parse(contracts.map(formatContract)));
});

router.post("/contracts", requireEmployeeAuth, async (req: Request, res: Response): Promise<void> => {
  const tid = getTenantId(req);
  const parsed = CreateContractBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const d = parsed.data;
  const [contract] = await db.insert(contractsTable).values({
    tenantId: tid,
    title: d.title,
    clientName: d.clientName,
    clientEmail: d.clientEmail,
    proposalId: d.proposalId ?? null,
    projectId: d.projectId ?? null,
    content: d.content,
    status: (d.status as any) ?? "draft",
    notes: d.notes ?? null,
  }).returning();
  res.status(201).json(GetContractResponse.parse(formatContract(contract)));
});

router.get("/contracts/for-client", requireClientAuth, async (req: Request, res: Response): Promise<void> => {
  const session = (req as any).session;
  const tid = getTenantId(req);
  const [account] = await db.select().from(clientAccounts).where(eq(clientAccounts.id, session.clientId)).limit(1);
  if (!account) { res.status(401).json({ error: "Unauthorized" }); return; }
  const contracts = await db.select().from(contractsTable)
    .where(and(eq(contractsTable.tenantId, tid), eq(contractsTable.clientEmail, account.email)))
    .orderBy(desc(contractsTable.createdAt));
  const visible = contracts.filter(c => c.status !== "draft");
  res.json(visible.map(formatContract));
});

router.get("/contracts/:id", requireEmployeeAuth, async (req: Request, res: Response): Promise<void> => {
  const tid = getTenantId(req);
  const params = GetContractParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [contract] = await db.select().from(contractsTable).where(and(eq(contractsTable.id, params.data.id), eq(contractsTable.tenantId, tid)));
  if (!contract) { res.status(404).json({ error: "Not found" }); return; }
  res.json(GetContractResponse.parse(formatContract(contract)));
});

router.patch("/contracts/:id", requireEmployeeAuth, async (req: Request, res: Response): Promise<void> => {
  const tid = getTenantId(req);
  const params = UpdateContractParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = UpdateContractBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const d = body.data;
  const updates: Record<string, unknown> = {};
  if (d.title !== undefined) updates.title = d.title;
  if (d.clientName !== undefined) updates.clientName = d.clientName;
  if (d.clientEmail !== undefined) updates.clientEmail = d.clientEmail;
  if (d.content !== undefined) updates.content = d.content;
  if (d.status !== undefined) updates.status = d.status;
  if (d.sentAt !== undefined) updates.sentAt = d.sentAt;
  if (d.signedAt !== undefined) updates.signedAt = d.signedAt;
  if (d.signerName !== undefined) updates.signerName = d.signerName;
  if (d.notes !== undefined) updates.notes = d.notes;
  const [updated] = await db.update(contractsTable).set(updates).where(and(eq(contractsTable.id, params.data.id), eq(contractsTable.tenantId, tid))).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(UpdateContractResponse.parse(formatContract(updated)));
});

router.delete("/contracts/:id", requireEmployeeAuth, async (req: Request, res: Response): Promise<void> => {
  const tid = getTenantId(req);
  const params = DeleteContractParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  await db.delete(contractsTable).where(and(eq(contractsTable.id, params.data.id), eq(contractsTable.tenantId, tid)));
  res.status(204).send();
});

router.post("/contracts/:id/send", requireEmployeeAuth, async (req: Request, res: Response): Promise<void> => {
  const tid = getTenantId(req);
  const params = SendContractParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const now = new Date().toISOString();
  const [updated] = await db.update(contractsTable)
    .set({ status: "sent", sentAt: now })
    .where(and(eq(contractsTable.id, params.data.id), eq(contractsTable.tenantId, tid)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(SendContractResponse.parse(formatContract(updated)));
});

router.post("/contracts/:id/sign", requireEmployeeAuth, async (req: Request, res: Response): Promise<void> => {
  const tid = getTenantId(req);
  const params = SignContractParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = SignContractBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const now = new Date().toISOString();
  const [updated] = await db.update(contractsTable)
    .set({ status: "signed", signedAt: now, signerName: body.data.signerName })
    .where(and(eq(contractsTable.id, params.data.id), eq(contractsTable.tenantId, tid)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  onContractSigned({ id: updated.id, title: updated.title, clientName: updated.clientName, clientEmail: updated.clientEmail, signerName: updated.signerName }, tid).catch(() => {});
  res.json(SignContractResponse.parse(formatContract(updated)));
});

router.post("/contracts/:id/sign-client", requireClientAuth, async (req: Request, res: Response): Promise<void> => {
  const session = (req as any).session;
  const tid = getTenantId(req);
  const params = SignContractParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid contract id" }); return; }
  const body = SignContractBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "signerName is required" }); return; }

  const [account] = await db.select().from(clientAccounts).where(eq(clientAccounts.id, session.clientId)).limit(1);
  if (!account) { res.status(401).json({ error: "Unauthorized" }); return; }

  const [existing] = await db.select().from(contractsTable)
    .where(and(eq(contractsTable.id, params.data.id), eq(contractsTable.tenantId, tid)))
    .limit(1);
  if (!existing) { res.status(404).json({ error: "Contract not found" }); return; }
  if (existing.clientEmail !== account.email) { res.status(403).json({ error: "Forbidden" }); return; }
  if (existing.status !== "sent") { res.status(400).json({ error: "Contract is not awaiting signature" }); return; }

  const now = new Date().toISOString();
  const [updated] = await db.update(contractsTable)
    .set({ status: "signed", signedAt: now, signerName: body.data.signerName })
    .where(and(eq(contractsTable.id, params.data.id), eq(contractsTable.tenantId, tid)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  onContractSigned({ id: updated.id, title: updated.title, clientName: updated.clientName, clientEmail: updated.clientEmail, signerName: updated.signerName }, tid).catch(() => {});
  res.json(formatContract(updated));
});

export default router;
