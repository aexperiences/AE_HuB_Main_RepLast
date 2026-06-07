import { requireEmployeeAuth, getTenantId } from "../middlewares/authMiddleware";
import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, estimatesTable, projectsTable, productsTable } from "@workspace/db";
import { firstAvailable } from "../lib/nextNum";

async function spawnInternalProject(
  estimate: typeof estimatesTable.$inferSelect,
  tenantId: string,
): Promise<number | null> {
  // Re-find: if a project was already spawned for this estimate, reuse it (idempotent under concurrency).
  const [existing] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.tenantId, tenantId), eq(projectsTable.sourceEstimateId, estimate.id)));
  if (existing) {
    if (estimate.projectId !== existing.id) {
      await db.update(estimatesTable).set({ projectId: existing.id }).where(eq(estimatesTable.id, estimate.id));
    }
    return existing.id;
  }

  let productName: string | null = null;
  let productIdToLink: number | null = null;
  if (estimate.productId) {
    // Tenant-scope the product lookup so a tenant can't reference another tenant's product.
    const [p] = await db
      .select()
      .from(productsTable)
      .where(and(eq(productsTable.id, estimate.productId), eq(productsTable.tenantId, tenantId)));
    if (p) {
      productName = p.name;
      productIdToLink = p.id;
    }
  }
  const projectNumber = await firstAvailable("PROJ", "projects", "project_number");
  const [proj] = await db.insert(projectsTable).values({
    tenantId,
    name: estimate.title,
    client: productName ?? "Internal — AE",
    status: "active",
    projectType: "internal",
    jobType: "internal",
    budget: estimate.total,
    projectNumber,
    jobNumber: estimate.jobNumber,
    sourceProductId: productIdToLink,
    sourceEstimateId: estimate.id,
    description: estimate.description,
  }).returning();
  await db.update(estimatesTable).set({ projectId: proj.id }).where(eq(estimatesTable.id, estimate.id));
  return proj.id;
}

async function ensureProductBelongsToTenant(productId: number | null | undefined, tenantId: string): Promise<boolean> {
  if (!productId) return true;
  const [p] = await db
    .select({ id: productsTable.id })
    .from(productsTable)
    .where(and(eq(productsTable.id, productId), eq(productsTable.tenantId, tenantId)));
  return !!p;
}
import {
  CreateEstimateBody,
  GetEstimateParams,
  GetEstimateResponse,
  UpdateEstimateParams,
  UpdateEstimateBody,
  UpdateEstimateResponse,
  DeleteEstimateParams,
  ListEstimatesResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function formatEstimate(e: typeof estimatesTable.$inferSelect) {
  return {
    ...e,
    subtotal: Number(e.subtotal),
    tax: Number(e.tax),
    total: Number(e.total),
    lineItems: (e.lineItems as unknown[]) ?? [],
    createdAt: e.createdAt.toISOString(),
    estimateNumber: e.estimateNumber ?? null,
    jobNumber: e.jobNumber ?? null,
  };
}

router.get("/estimates", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const estimates = await db.select().from(estimatesTable).where(eq(estimatesTable.tenantId, tid)).orderBy(desc(estimatesTable.createdAt));
  res.json(estimates.map(formatEstimate));
});

router.post("/estimates", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const parsed = CreateEstimateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const estimateNumber = await firstAvailable("EST", "estimates", "estimate_number");
  const jobNumber = await firstAvailable("JOB", "estimates", "job_number");
  const kind = (parsed.data.kind as "client" | "internal" | undefined) ?? "client";
  if (kind === "internal" && parsed.data.productId != null) {
    const ok = await ensureProductBelongsToTenant(parsed.data.productId, tid);
    if (!ok) { res.status(400).json({ error: "Invalid productId" }); return; }
  }
  const [estimate] = await db.insert(estimatesTable).values({
    tenantId: tid,
    title: parsed.data.title,
    kind,
    client: parsed.data.client ?? null,
    productId: kind === "internal" ? (parsed.data.productId ?? null) : null,
    projectId: parsed.data.projectId ?? null,
    description: parsed.data.description ?? null,
    lineItems: (parsed.data.lineItems as unknown[]) ?? [],
    subtotal: String(parsed.data.subtotal ?? 0),
    tax: String(parsed.data.tax ?? 0),
    total: String(parsed.data.total ?? 0),
    status: parsed.data.status as "draft" | "sent" | "accepted" | "rejected",
    validUntil: parsed.data.validUntil ?? null,
    estimateNumber,
    jobNumber,
  }).returning();

  // Internal estimates created in 'accepted' state auto-spawn an internal project.
  if (estimate.kind === "internal" && estimate.status === "accepted" && !estimate.projectId) {
    await spawnInternalProject(estimate, tid);
    const [refreshed] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, estimate.id));
    res.status(201).json(formatEstimate(refreshed));
    return;
  }
  res.status(201).json(formatEstimate(estimate));
});

router.get("/estimates/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = GetEstimateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [estimate] = await db.select().from(estimatesTable).where(and(eq(estimatesTable.id, params.data.id), eq(estimatesTable.tenantId, tid)));
  if (!estimate) {
    res.status(404).json({ error: "Estimate not found" });
    return;
  }
  res.json(formatEstimate(estimate));
});

router.patch("/estimates/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = UpdateEstimateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateEstimateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updateData: Record<string, unknown> = {};
  if (parsed.data.productId !== undefined && parsed.data.productId !== null) {
    const ok = await ensureProductBelongsToTenant(parsed.data.productId, tid);
    if (!ok) { res.status(400).json({ error: "Invalid productId" }); return; }
  }
  if (parsed.data.title !== undefined) updateData.title = parsed.data.title;
  if (parsed.data.kind !== undefined) updateData.kind = parsed.data.kind;
  if (parsed.data.productId !== undefined) updateData.productId = parsed.data.productId;
  if (parsed.data.client !== undefined) updateData.client = parsed.data.client;
  if (parsed.data.description !== undefined) updateData.description = parsed.data.description;
  if (parsed.data.lineItems !== undefined) updateData.lineItems = parsed.data.lineItems;
  if (parsed.data.subtotal !== undefined) updateData.subtotal = String(parsed.data.subtotal);
  if (parsed.data.tax !== undefined) updateData.tax = String(parsed.data.tax);
  if (parsed.data.total !== undefined) updateData.total = String(parsed.data.total);
  if (parsed.data.status !== undefined) updateData.status = parsed.data.status;
  if (parsed.data.validUntil !== undefined) updateData.validUntil = parsed.data.validUntil;

  const [estimate] = await db.update(estimatesTable).set(updateData).where(and(eq(estimatesTable.id, params.data.id), eq(estimatesTable.tenantId, tid))).returning();
  if (!estimate) {
    res.status(404).json({ error: "Estimate not found" });
    return;
  }
  // When an internal estimate transitions to 'accepted' and isn't yet linked to a project, spawn one.
  if (estimate.kind === "internal" && estimate.status === "accepted" && !estimate.projectId) {
    await spawnInternalProject(estimate, tid);
    const [refreshed] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, estimate.id));
    res.json(formatEstimate(refreshed));
    return;
  }
  res.json(formatEstimate(estimate));
});

// Manual trigger: start (or re-find) an internal project from an internal estimate.
router.post("/estimates/:id/start-project", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const [estimate] = await db.select().from(estimatesTable).where(and(eq(estimatesTable.id, id), eq(estimatesTable.tenantId, tid)));
  if (!estimate) { res.status(404).json({ error: "Estimate not found" }); return; }
  if (estimate.kind !== "internal") { res.status(400).json({ error: "Only internal estimates can spawn internal projects" }); return; }
  if (estimate.projectId) { res.json({ projectId: estimate.projectId, alreadyLinked: true }); return; }
  const projectId = await spawnInternalProject(estimate, tid);
  res.status(201).json({ projectId, alreadyLinked: false });
});

router.delete("/estimates/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = DeleteEstimateParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [estimate] = await db.delete(estimatesTable).where(and(eq(estimatesTable.id, params.data.id), eq(estimatesTable.tenantId, tid))).returning();
  if (!estimate) {
    res.status(404).json({ error: "Estimate not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
