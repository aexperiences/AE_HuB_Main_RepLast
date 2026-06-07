import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, projectsTable, expensesTable, invoicesTable, estimatesTable } from "@workspace/db";
import { requireEmployeeAuth, getTenantId, getSession } from "../middlewares/authMiddleware";
import { firstAvailable } from "../lib/nextNum";
import { requestFiling } from "../lib/anetta-filing";
import {
  CreateProjectBody,
  GetProjectParams,
  GetProjectResponse,
  UpdateProjectParams,
  UpdateProjectBody,
  UpdateProjectResponse,
  DeleteProjectParams,
  ListProjectsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serializeProject(p: typeof projectsTable.$inferSelect) {
  return {
    ...p,
    budget: p.budget ? Number(p.budget) : null,
    createdAt: p.createdAt.toISOString(),
    projectNumber: p.projectNumber ?? null,
    jobNumber: p.jobNumber ?? null,
    assignedPmId: p.assignedPmId ?? null,
    assignedPmName: p.assignedPmName ?? null,
    jobType: p.jobType ?? "client",
    pmNotes: p.pmNotes ?? null,
    assignedCreatorId: (p as any).assignedCreatorId ?? null,
    assignedCreatorName: (p as any).assignedCreatorName ?? null,
  };
}

router.get("/projects", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const typeFilter = req.query.type as string | undefined;
  const conditions: ReturnType<typeof eq>[] = [eq(projectsTable.tenantId, tid)];
  if (typeFilter === "client" || typeFilter === "internal") {
    conditions.push(eq(projectsTable.projectType, typeFilter));
  }
  const projects = await db.select().from(projectsTable).where(and(...conditions)).orderBy(desc(projectsTable.createdAt));
  res.json(projects.map(serializeProject));
});

router.post("/projects", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const serviceType = typeof req.body.serviceType === "string" ? req.body.serviceType : null;
  const projectType = (parsed.data.projectType as string) ?? "client";

  let projectNumber: string;
  let jobNumber: string;
  const incomingJobNumber = typeof req.body.jobNumber === "string" && req.body.jobNumber.trim()
    ? req.body.jobNumber.trim()
    : null;

  if (projectType === "client") {
    if (incomingJobNumber) {
      projectNumber = incomingJobNumber;
      jobNumber = incomingJobNumber;
    } else {
      projectNumber = await firstAvailable("JOB", "projects", "project_number");
      jobNumber = projectNumber;
    }
  } else {
    projectNumber = await firstAvailable("INT", "projects", "project_number");
    jobNumber = projectNumber;
  }

  const [project] = await db.insert(projectsTable).values({
    tenantId: tid,
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    client: parsed.data.client ?? null,
    status: parsed.data.status as "active" | "completed" | "on_hold" | "cancelled",
    projectType,
    serviceType,
    platform: (parsed.data.platform as string | undefined) ?? null,
    budget: parsed.data.budget != null ? String(parsed.data.budget) : null,
    startDate: parsed.data.startDate ?? null,
    endDate: parsed.data.endDate ?? null,
    projectNumber,
    jobNumber,
  }).returning();

  // Auto-trigger: Anetta filing request for the new project's home folder.
  const root = projectType === "internal" ? "Internal_Products" : "Clients";
  const contextLabel = projectType === "internal"
    ? project.name
    : (project.client ?? project.name);
  void requestFiling({
    tenantId: tid,
    fromAgent: "system",
    originalFilename: null,
    fileType: "DOC",
    contentSummary: `New ${projectType} project created: "${project.name}" (${project.projectNumber}).\nClient: ${project.client ?? "(internal)"}\nService: ${project.serviceType ?? "(unspecified)"}\nBudget: ${project.budget ?? "(unset)"}\nDescription: ${project.description ?? "(none)"}.\n\nPropose a HOME FOLDER for this project under /AE/${root}/${contextLabel}/ — every deliverable, brief, contract, and invoice tied to this project will land here.`,
    contextType: "project",
    contextId: project.id,
    contextLabel,
  }).catch(err => req.log?.error({ err }, "auto-filing trigger failed"));

  res.status(201).json(serializeProject(project));
});

router.get("/projects/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = GetProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [project] = await db.select().from(projectsTable).where(and(eq(projectsTable.id, params.data.id), eq(projectsTable.tenantId, tid)));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json(serializeProject(project));
});

router.patch("/projects/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = UpdateProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const updateData: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
  if (parsed.data.description !== undefined) updateData.description = parsed.data.description;
  if (parsed.data.client !== undefined) updateData.client = parsed.data.client;
  if (parsed.data.status !== undefined) updateData.status = parsed.data.status;
  if (parsed.data.projectType !== undefined) updateData.projectType = parsed.data.projectType;
  if (parsed.data.platform !== undefined) updateData.platform = parsed.data.platform;
  if (parsed.data.budget !== undefined) updateData.budget = parsed.data.budget != null ? String(parsed.data.budget) : null;
  if (parsed.data.startDate !== undefined) updateData.startDate = parsed.data.startDate;
  if (parsed.data.endDate !== undefined) updateData.endDate = parsed.data.endDate;
  if (typeof req.body.serviceType === "string") updateData.serviceType = req.body.serviceType;
  const session = getSession(req);
  const isAdmin = session.employeeRole === "admin";
  const isPm = session.employeeRole === "project_manager";
  // Only admin can assign PM
  if (isAdmin) {
    if (req.body.assignedPmId !== undefined) updateData.assignedPmId = req.body.assignedPmId || null;
    if (req.body.assignedPmName !== undefined) updateData.assignedPmName = req.body.assignedPmName || null;
    if (req.body.jobType !== undefined) updateData.jobType = req.body.jobType || null;
    if (req.body.pmNotes !== undefined) updateData.pmNotes = req.body.pmNotes || null;
  }
  // Admin or PM can assign creator
  if (isAdmin || isPm) {
    if (req.body.assignedCreatorId !== undefined) updateData.assignedCreatorId = req.body.assignedCreatorId || null;
    if (req.body.assignedCreatorName !== undefined) updateData.assignedCreatorName = req.body.assignedCreatorName || null;
  }

  const [project] = await db.update(projectsTable).set(updateData).where(and(eq(projectsTable.id, params.data.id), eq(projectsTable.tenantId, tid))).returning();
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json(serializeProject(project));
});

router.delete("/projects/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = DeleteProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [project] = await db.delete(projectsTable).where(and(eq(projectsTable.id, params.data.id), eq(projectsTable.tenantId, tid))).returning();
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.sendStatus(204);
});

router.get("/projects/:id/financials", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [project] = await db.select().from(projectsTable).where(and(eq(projectsTable.id, id), eq(projectsTable.tenantId, tid)));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const [expenses, invoices, estimates] = await Promise.all([
    db.select().from(expensesTable).where(and(eq(expensesTable.projectId, id), eq(expensesTable.tenantId, tid))),
    db.select().from(invoicesTable).where(and(eq(invoicesTable.projectId, id), eq(invoicesTable.tenantId, tid))),
    db.select().from(estimatesTable).where(and(eq(estimatesTable.projectId, id), eq(estimatesTable.tenantId, tid))),
  ]);

  const totalExpenses = expenses.reduce((s, e) => s + Number(e.amount), 0);
  const totalInvoiced = invoices
    .filter(inv => inv.status !== "cancelled")
    .reduce((s, inv) => s + Number(inv.amount), 0);
  const totalCollected = invoices
    .filter(inv => inv.status === "paid")
    .reduce((s, inv) => s + Number(inv.amount), 0);

  const acceptedEstimate = estimates.find(e => e.status === "accepted");
  const latestEstimate = estimates[0];
  const estimatedValue = acceptedEstimate
    ? Number(acceptedEstimate.total)
    : latestEstimate ? Number(latestEstimate.total) : null;

  const grossProfit = totalCollected - totalExpenses;
  const gpPct = totalCollected > 0 ? (grossProfit / totalCollected) * 100 : null;

  res.json({
    totalExpenses,
    totalInvoiced,
    totalCollected,
    estimatedValue,
    grossProfit,
    gpPct,
    budget: project.budget ? Number(project.budget) : null,
    invoiceCount: invoices.length,
    expenseCount: expenses.length,
    estimateCount: estimates.length,
  });
});

export default router;
