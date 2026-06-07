import { Router, type IRouter } from "express";
import { eq, desc, or, isNull, and } from "drizzle-orm";
import { db, clientsTable } from "@workspace/db";
import { firstAvailable } from "../lib/nextNum";
import {
  CreateClientBody,
  GetClientParams,
  GetClientResponse,
  UpdateClientParams,
  UpdateClientBody,
  UpdateClientResponse,
  DeleteClientParams,
  ListClientsResponse,
} from "@workspace/api-zod";
import { requireEmployeeAuth, getTenantId } from "../middlewares/authMiddleware";

const router: IRouter = Router();

const toClient = (c: typeof clientsTable.$inferSelect) => ({
  ...c,
  createdAt: c.createdAt.toISOString(),
  clientNumber: c.clientNumber ?? null,
});

const getSession = (req: any) => ({
  employeeId: req.session?.employeeId as string | undefined,
  role: req.session?.employeeRole as string | undefined,
});

router.get("/clients", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const { employeeId, role } = getSession(req);
  const isAdmin = role === "admin";

  const clients = isAdmin
    ? await db.select().from(clientsTable).where(eq(clientsTable.tenantId, tid)).orderBy(desc(clientsTable.createdAt))
    : await db.select().from(clientsTable)
        .where(and(eq(clientsTable.tenantId, tid), or(eq(clientsTable.createdBy, employeeId!), isNull(clientsTable.createdBy))))
        .orderBy(desc(clientsTable.createdAt));

  res.json(clients.map(toClient));
});

router.post("/clients", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const parsed = CreateClientBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { employeeId } = getSession(req);

  const clientNumber = await firstAvailable("CLI", "clients", "client_number");

  const [client] = await db.insert(clientsTable).values({
    tenantId: tid,
    name: parsed.data.name,
    company: parsed.data.company ?? null,
    email: parsed.data.email ?? null,
    phone: parsed.data.phone ?? null,
    address: parsed.data.address ?? null,
    city: parsed.data.city ?? null,
    state: parsed.data.state ?? null,
    notes: parsed.data.notes ?? null,
    tags: parsed.data.tags ?? null,
    status: (parsed.data.status ?? "lead") as "lead" | "active" | "inactive",
    createdBy: employeeId ?? null,
    clientNumber,
  }).returning();
  res.status(201).json(toClient(client));
});

router.get("/clients/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = GetClientParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const { employeeId, role } = getSession(req);
  const isAdmin = role === "admin";

  const [client] = await db.select().from(clientsTable).where(and(eq(clientsTable.id, params.data.id), eq(clientsTable.tenantId, tid)));
  if (!client) { res.status(404).json({ error: "Client not found" }); return; }

  if (!isAdmin && client.createdBy && client.createdBy !== employeeId) {
    res.status(403).json({ error: "Access denied" }); return;
  }
  res.json(toClient(client));
});

router.patch("/clients/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = UpdateClientParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateClientBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { employeeId, role } = getSession(req);
  const isAdmin = role === "admin";

  const [existing] = await db.select().from(clientsTable).where(and(eq(clientsTable.id, params.data.id), eq(clientsTable.tenantId, tid)));
  if (!existing) { res.status(404).json({ error: "Client not found" }); return; }
  if (!isAdmin && existing.createdBy && existing.createdBy !== employeeId) {
    res.status(403).json({ error: "Access denied" }); return;
  }

  const [client] = await db.update(clientsTable).set(parsed.data).where(and(eq(clientsTable.id, params.data.id), eq(clientsTable.tenantId, tid))).returning();
  if (!client) { res.status(404).json({ error: "Client not found" }); return; }
  res.json(toClient(client));
});

router.delete("/clients/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const params = DeleteClientParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const { employeeId, role } = getSession(req);
  const isAdmin = role === "admin";

  const [existing] = await db.select().from(clientsTable).where(and(eq(clientsTable.id, params.data.id), eq(clientsTable.tenantId, tid)));
  if (!existing) { res.status(404).json({ error: "Client not found" }); return; }
  if (!isAdmin && existing.createdBy && existing.createdBy !== employeeId) {
    res.status(403).json({ error: "Access denied" }); return;
  }

  await db.delete(clientsTable).where(and(eq(clientsTable.id, params.data.id), eq(clientsTable.tenantId, tid)));
  res.sendStatus(204);
});

export default router;
