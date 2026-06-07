import { requireEmployeeAuth, requireClientAuth, getTenantId } from "../middlewares/authMiddleware";
import { Router, type IRouter, type Request, type Response } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, proposalsTable, clientAccounts } from "@workspace/db";
import { firstAvailable } from "../lib/nextNum";
import {
  CreateProposalBody,
  GetProposalParams,
  GetProposalResponse,
  UpdateProposalParams,
  UpdateProposalBody,
  UpdateProposalResponse,
  DeleteProposalParams,
  ListProposalsResponse,
  SendProposalParams,
  SendProposalResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function formatProposal(p: typeof proposalsTable.$inferSelect) {
  return {
    ...p,
    subtotal: Number(p.subtotal),
    tax: Number(p.tax),
    total: Number(p.total),
    lineItems: (p.lineItems as unknown[]) ?? [],
    createdAt: p.createdAt.toISOString(),
    proposalNumber: p.proposalNumber ?? null,
    jobNumber: p.jobNumber ?? null,
  };
}

router.get("/proposals", requireEmployeeAuth, async (req: Request, res: Response): Promise<void> => {
  const tid = getTenantId(req);
  const proposals = await db.select().from(proposalsTable).where(eq(proposalsTable.tenantId, tid)).orderBy(desc(proposalsTable.createdAt));
  res.json(proposals.map(formatProposal));
});

router.post("/proposals", requireEmployeeAuth, async (req: Request, res: Response): Promise<void> => {
  const tid = getTenantId(req);
  const parsed = CreateProposalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;
  const proposalNumber = await firstAvailable("PRO", "proposals", "proposal_number");
  const incomingJobNumber = typeof req.body.jobNumber === "string" && req.body.jobNumber.trim()
    ? req.body.jobNumber.trim()
    : null;
  const jobNumber = incomingJobNumber ?? await firstAvailable("JOB", "proposals", "job_number");
  const [proposal] = await db.insert(proposalsTable).values({
    tenantId: tid,
    title: d.title,
    clientName: d.clientName,
    clientEmail: d.clientEmail ?? "",
    projectId: d.projectId ?? null,
    description: d.description ?? null,
    lineItems: (d.lineItems as unknown[]) ?? [],
    subtotal: String(d.subtotal ?? 0),
    tax: String(d.tax ?? 0),
    total: String(d.total ?? 0),
    status: (d.status as any) ?? "draft",
    validUntil: d.validUntil ?? null,
    notes: d.notes ?? null,
    clientMessage: d.clientMessage ?? null,
    proposalNumber,
    jobNumber,
  }).returning();
  res.status(201).json(formatProposal(proposal));
});

router.get("/proposals/for-client", requireClientAuth, async (req: Request, res: Response): Promise<void> => {
  const session = (req as any).session;
  const tid = getTenantId(req);
  const [account] = await db.select().from(clientAccounts).where(eq(clientAccounts.id, session.clientId)).limit(1);
  if (!account) { res.status(401).json({ error: "Unauthorized" }); return; }
  const proposals = await db.select().from(proposalsTable)
    .where(and(eq(proposalsTable.tenantId, tid), eq(proposalsTable.clientEmail, account.email)))
    .orderBy(desc(proposalsTable.createdAt));
  const sent = proposals.filter(p => p.status !== "draft");
  res.json(sent.map(formatProposal));
});

router.get("/proposals/:id", requireEmployeeAuth, async (req: Request, res: Response): Promise<void> => {
  const tid = getTenantId(req);
  const params = GetProposalParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [proposal] = await db.select().from(proposalsTable).where(and(eq(proposalsTable.id, params.data.id), eq(proposalsTable.tenantId, tid)));
  if (!proposal) { res.status(404).json({ error: "Not found" }); return; }
  res.json(formatProposal(proposal));
});

router.patch("/proposals/:id", requireEmployeeAuth, async (req: Request, res: Response): Promise<void> => {
  const tid = getTenantId(req);
  const params = UpdateProposalParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = UpdateProposalBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const d = body.data;
  const updates: Record<string, unknown> = {};
  if (d.title !== undefined) updates.title = d.title;
  if (d.clientName !== undefined) updates.clientName = d.clientName;
  if (d.clientEmail !== undefined) updates.clientEmail = d.clientEmail;
  if (d.description !== undefined) updates.description = d.description;
  if (d.lineItems !== undefined) updates.lineItems = d.lineItems;
  if (d.subtotal !== undefined) updates.subtotal = String(d.subtotal);
  if (d.tax !== undefined) updates.tax = String(d.tax);
  if (d.total !== undefined) updates.total = String(d.total);
  if (d.status !== undefined) updates.status = d.status;
  if (d.validUntil !== undefined) updates.validUntil = d.validUntil;
  if (d.notes !== undefined) updates.notes = d.notes;
  if (d.clientMessage !== undefined) updates.clientMessage = d.clientMessage;
  const [updated] = await db.update(proposalsTable).set(updates).where(and(eq(proposalsTable.id, params.data.id), eq(proposalsTable.tenantId, tid))).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(formatProposal(updated));
});

router.delete("/proposals/:id", requireEmployeeAuth, async (req: Request, res: Response): Promise<void> => {
  const tid = getTenantId(req);
  const params = DeleteProposalParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  await db.delete(proposalsTable).where(and(eq(proposalsTable.id, params.data.id), eq(proposalsTable.tenantId, tid)));
  res.status(204).send();
});

router.post("/proposals/:id/send", requireEmployeeAuth, async (req: Request, res: Response): Promise<void> => {
  const tid = getTenantId(req);
  const params = SendProposalParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [updated] = await db.update(proposalsTable)
    .set({ status: "sent" })
    .where(and(eq(proposalsTable.id, params.data.id), eq(proposalsTable.tenantId, tid)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(formatProposal(updated));
});

router.post("/proposals/:id/respond", requireClientAuth, async (req: Request, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { action } = req.body as { action?: string };
  if (action !== "accept" && action !== "reject") {
    res.status(400).json({ error: "action must be 'accept' or 'reject'" });
    return;
  }
  const session = (req as any).session;
  const [account] = await db.select().from(clientAccounts).where(eq(clientAccounts.id, session.clientId)).limit(1);
  if (!account) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [proposal] = await db.select().from(proposalsTable).where(eq(proposalsTable.id, id)).limit(1);
  if (!proposal) { res.status(404).json({ error: "Not found" }); return; }
  if (proposal.clientEmail?.toLowerCase() !== account.email.toLowerCase()) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (proposal.status !== "sent") {
    res.status(409).json({ error: "Proposal is not in a sent state" });
    return;
  }
  const newStatus = action === "accept" ? "accepted" : "rejected";
  const [updated] = await db.update(proposalsTable)
    .set({ status: newStatus })
    .where(eq(proposalsTable.id, id))
    .returning();
  res.json(formatProposal(updated));
});

router.post("/proposals/:id/record-response", requireEmployeeAuth, async (req: Request, res: Response): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { action } = req.body as { action?: string };
  if (action !== "accept" && action !== "reject") {
    res.status(400).json({ error: "action must be 'accept' or 'reject'" });
    return;
  }
  const [proposal] = await db.select().from(proposalsTable)
    .where(and(eq(proposalsTable.id, id), eq(proposalsTable.tenantId, tid)))
    .limit(1);
  if (!proposal) { res.status(404).json({ error: "Not found" }); return; }
  if (proposal.status !== "sent") {
    res.status(409).json({ error: "Proposal is not in a sent state" });
    return;
  }
  const newStatus = action === "accept" ? "accepted" : "rejected";
  const [updated] = await db.update(proposalsTable)
    .set({ status: newStatus })
    .where(and(eq(proposalsTable.id, id), eq(proposalsTable.tenantId, tid)))
    .returning();
  res.json(formatProposal(updated));
});

export default router;
