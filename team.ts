import { requireEmployeeAuth, getTenantId } from "../middlewares/authMiddleware";
import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db, teamMembersTable } from "@workspace/db";
import {
  CreateTeamMemberBody,
  UpdateTeamMemberParams,
  UpdateTeamMemberBody,
  UpdateTeamMemberResponse,
  DeleteTeamMemberParams,
  ListTeamMembersResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const toMember = (m: typeof teamMembersTable.$inferSelect) => ({
  ...m,
  hourlyRate: m.hourlyRate ? Number(m.hourlyRate) : null,
  createdAt: m.createdAt.toISOString(),
});

router.get("/team", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const members = await db.select().from(teamMembersTable).where(eq(teamMembersTable.tenantId, tid)).orderBy(desc(teamMembersTable.createdAt));
  res.json(ListTeamMembersResponse.parse(members.map(toMember)));
});

router.post("/team", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const parsed = CreateTeamMemberBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [member] = await db.insert(teamMembersTable).values({
    tenantId: tid,
    name: parsed.data.name,
    email: parsed.data.email ?? null,
    phone: parsed.data.phone ?? null,
    role: (parsed.data.role ?? "contractor") as "owner" | "manager" | "designer" | "photographer" | "videographer" | "editor" | "copywriter" | "coordinator" | "contractor",
    hourlyRate: parsed.data.hourlyRate != null ? String(parsed.data.hourlyRate) : null,
    color: parsed.data.color ?? "#3b82f6",
    status: (parsed.data.status ?? "active") as "active" | "inactive",
  }).returning();
  res.status(201).json(toMember(member));
});

router.patch("/team/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = UpdateTeamMemberParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateTeamMemberBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const updateData: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.hourlyRate !== undefined) updateData.hourlyRate = parsed.data.hourlyRate != null ? String(parsed.data.hourlyRate) : null;
  const [member] = await db.update(teamMembersTable).set(updateData).where(and(eq(teamMembersTable.id, params.data.id), eq(teamMembersTable.tenantId, tid))).returning();
  if (!member) { res.status(404).json({ error: "Team member not found" }); return; }
  res.json(UpdateTeamMemberResponse.parse(toMember(member)));
});

router.delete("/team/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = DeleteTeamMemberParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [member] = await db.delete(teamMembersTable).where(and(eq(teamMembersTable.id, params.data.id), eq(teamMembersTable.tenantId, tid))).returning();
  if (!member) { res.status(404).json({ error: "Team member not found" }); return; }
  res.sendStatus(204);
});

export default router;
