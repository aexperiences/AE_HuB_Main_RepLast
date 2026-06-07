import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { db, employeeAccounts, clientAccounts } from "@workspace/db";
import { tenantsTable, passwordResetTokensTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAdminAuth, requireEmployeeAuth, requireClientAuth, requireProjectManagerAuth } from "../middlewares/authMiddleware";

const router = Router();

function getTenantId(req: Request): string {
  return (req as any).session.tenantId as string;
}

// ── Company (Tenant) Registration ────────────────────────────────

router.post("/company/register", async (req: Request, res: Response) => {
  try {
    const { companyName, adminName, adminEmail, adminPassword } = req.body;
    if (!companyName || !adminName || !adminEmail || !adminPassword) {
      return res.status(400).json({ error: "companyName, adminName, adminEmail, and adminPassword are required" });
    }
    if (adminPassword.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const emailLower = adminEmail.toLowerCase().trim();
    const existing = await db.select().from(employeeAccounts).where(eq(employeeAccounts.email, emailLower)).limit(1);
    if (existing.length > 0) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const slug = companyName.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 50) + "-" + Date.now().toString(36);

    const [tenant] = await db.insert(tenantsTable).values({
      name: companyName.trim(),
      slug,
      plan: "trial",
      status: "active",
    }).returning();

    const passwordHash = await bcrypt.hash(adminPassword, 12);
    const [account] = await db.insert(employeeAccounts).values({
      tenantId: tenant.id,
      name: adminName.trim(),
      email: emailLower,
      passwordHash,
      role: "admin",
      status: "approved",
    }).returning();

    (req as any).session.employeeId = account.id;
    (req as any).session.employeeRole = account.role;
    (req as any).session.employeeName = account.name;
    (req as any).session.tenantId = tenant.id;

    return res.status(201).json({
      tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan, trialEndsAt: tenant.trialEndsAt },
      account: { id: account.id, name: account.name, email: account.email, role: account.role },
    });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── Tenant info ──────────────────────────────────────────────────

router.get("/tenant", requireEmployeeAuth, async (req: Request, res: Response) => {
  const tid = getTenantId(req);
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tid)).limit(1);
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });
  return res.json({
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    plan: tenant.plan,
    status: tenant.status,
    trialEndsAt: tenant.trialEndsAt,
    stripeCustomerId: tenant.stripeCustomerId,
    stripeSubscriptionId: tenant.stripeSubscriptionId,
  });
});

// ── Employee Auth ────────────────────────────────────────────────

router.post("/employee/register", requireEmployeeAuth, async (req: Request, res: Response) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const tid = getTenantId(req);
    const emailLower = email.toLowerCase().trim();
    const existing = await db.select().from(employeeAccounts).where(eq(employeeAccounts.email, emailLower)).limit(1);
    if (existing.length > 0) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const callerRole = (req as any).session.employeeRole;
    const isCallerAdmin = callerRole === "admin";
    const assignedRole = isCallerAdmin && role ? role : "employee";
    const passwordHash = await bcrypt.hash(password, 12);

    const [account] = await db.insert(employeeAccounts).values({
      tenantId: tid,
      name: name.trim(),
      email: emailLower,
      passwordHash,
      role: assignedRole as "admin" | "employee" | "project_manager" | "accounting" | "account_representative",
      status: isCallerAdmin ? "approved" : "pending",
    }).returning();

    return res.status(201).json({
      id: account.id,
      name: account.name,
      email: account.email,
      role: account.role,
      status: account.status,
    });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/employee/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const [account] = await db.select().from(employeeAccounts).where(eq(employeeAccounts.email, email.toLowerCase())).limit(1);
    if (!account) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(password, account.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (account.status === "pending") {
      return res.status(403).json({ error: "Your account is pending approval from an administrator" });
    }
    if (account.status === "rejected") {
      return res.status(403).json({ error: "Your account has been rejected" });
    }

    (req as any).session.employeeId = account.id;
    (req as any).session.employeeRole = account.role;
    (req as any).session.employeeName = account.name;
    (req as any).session.tenantId = account.tenantId;

    let tenant = null;
    if (account.tenantId) {
      const [t] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, account.tenantId)).limit(1);
      if (t) tenant = { id: t.id, name: t.name, plan: t.plan, status: t.status, trialEndsAt: t.trialEndsAt };
    }

    return res.json({
      id: account.id,
      name: account.name,
      email: account.email,
      role: account.role,
      tenant,
    });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/employee/logout", (req: Request, res: Response) => {
  (req as any).session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

router.get("/employee/me", requireEmployeeAuth, async (req: Request, res: Response) => {
  const session = (req as any).session;
  const [account] = await db.select().from(employeeAccounts).where(eq(employeeAccounts.id, session.employeeId)).limit(1);
  if (!account) return res.status(404).json({ error: "Not found" });

  let tenant = null;
  if (account.tenantId) {
    const [t] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, account.tenantId)).limit(1);
    if (t) tenant = { id: t.id, name: t.name, plan: t.plan, status: t.status, trialEndsAt: t.trialEndsAt };
  }

  return res.json({ id: account.id, name: account.name, email: account.email, role: account.role, status: account.status, tenant });
});

// ── Password Reset ───────────────────────────────────────────────

router.post("/employee/password-reset/request", async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const [account] = await db.select().from(employeeAccounts).where(eq(employeeAccounts.email, email.toLowerCase())).limit(1);

    if (!account) {
      return res.json({ ok: true, message: "If that email exists, a reset link has been sent." });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await db.delete(passwordResetTokensTable).where(eq(passwordResetTokensTable.employeeId, account.id));
    await db.insert(passwordResetTokensTable).values({ employeeId: account.id, token, expiresAt });

    req.log.info({ employeeId: account.id }, "Password reset token generated");
    return res.json({ ok: true, message: "If that email exists, a reset link has been sent.", _devToken: process.env.NODE_ENV !== "production" ? token : undefined });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/employee/password-reset/verify", async (req: Request, res: Response) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token is required" });

    const [resetToken] = await db.select().from(passwordResetTokensTable).where(eq(passwordResetTokensTable.token, token)).limit(1);
    if (!resetToken || resetToken.usedAt || resetToken.expiresAt < new Date()) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }
    return res.json({ ok: true, employeeId: resetToken.employeeId });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/employee/password-reset/reset", async (req: Request, res: Response) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: "Token and newPassword are required" });
    if (newPassword.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

    const [resetToken] = await db.select().from(passwordResetTokensTable).where(eq(passwordResetTokensTable.token, token)).limit(1);
    if (!resetToken || resetToken.usedAt || resetToken.expiresAt < new Date()) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db.update(employeeAccounts).set({ passwordHash, updatedAt: new Date() }).where(eq(employeeAccounts.id, resetToken.employeeId));
    await db.update(passwordResetTokensTable).set({ usedAt: new Date() }).where(eq(passwordResetTokensTable.token, token));

    return res.json({ ok: true });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── Admin: manage employees ───────────────────────────────────────

router.get("/admin/employees", requireAdminAuth, async (req: Request, res: Response) => {
  const tid = getTenantId(req);
  const accounts = await db.select({
    id: employeeAccounts.id,
    name: employeeAccounts.name,
    email: employeeAccounts.email,
    role: employeeAccounts.role,
    status: employeeAccounts.status,
    createdAt: employeeAccounts.createdAt,
  }).from(employeeAccounts).where(eq(employeeAccounts.tenantId, tid)).orderBy(employeeAccounts.createdAt);
  return res.json(accounts);
});

router.patch("/admin/employees/:id/status", requireAdminAuth, async (req: Request, res: Response) => {
  const tid = getTenantId(req);
  const id = String(req.params.id);
  const { status } = req.body;
  if (!["approved", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const [updated] = await db.update(employeeAccounts)
    .set({ status: status as "approved" | "rejected" | "pending", updatedAt: new Date() })
    .where(and(eq(employeeAccounts.id, id), eq(employeeAccounts.tenantId, tid)))
    .returning();
  if (!updated) return res.status(404).json({ error: "Not found" });
  return res.json(updated);
});

router.patch("/admin/employees/:id/role", requireAdminAuth, async (req: Request, res: Response) => {
  const tid = getTenantId(req);
  const id = String(req.params.id);
  const { role } = req.body;
  const validRoles = ["admin", "employee", "project_manager", "accounting", "account_representative", "creator"];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }
  const [updated] = await db.update(employeeAccounts)
    .set({ role: role as "admin" | "employee" | "project_manager" | "accounting" | "account_representative" | "creator", updatedAt: new Date() })
    .where(and(eq(employeeAccounts.id, id), eq(employeeAccounts.tenantId, tid)))
    .returning();
  if (!updated) return res.status(404).json({ error: "Not found" });
  return res.json(updated);
});

// ── Client Auth ────────────────────────────────────────────────

router.post("/client/register", async (req: Request, res: Response) => {
  try {
    const { name, email, password, companyName, tenantSlug } = req.body;
    if (!name || !email || !password || !tenantSlug) {
      return res.status(400).json({ error: "Name, email, password, and tenantSlug are required" });
    }

    const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.slug, tenantSlug)).limit(1);
    if (!tenant) return res.status(404).json({ error: "Company not found" });

    const emailLower = email.toLowerCase();
    const existing = await db.select().from(clientAccounts).where(eq(clientAccounts.email, emailLower)).limit(1);
    if (existing.length > 0) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const [account] = await db.insert(clientAccounts).values({
      tenantId: tenant.id,
      name,
      email: emailLower,
      passwordHash,
      companyName: companyName || null,
      status: "pending",
    }).returning();

    return res.status(201).json({
      id: account.id,
      name: account.name,
      email: account.email,
      status: account.status,
    });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/client/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const [account] = await db.select().from(clientAccounts).where(eq(clientAccounts.email, email.toLowerCase())).limit(1);
    if (!account) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(password, account.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (account.status === "pending") {
      return res.status(403).json({ error: "Your account is awaiting approval. We'll notify you when you're approved." });
    }
    if (account.status === "rejected") {
      return res.status(403).json({ error: "Your account access has been declined. Please contact us for more information." });
    }

    (req as any).session.clientId = account.id;
    (req as any).session.clientName = account.name;
    (req as any).session.tenantId = account.tenantId;

    return res.json({
      id: account.id,
      name: account.name,
      email: account.email,
      companyName: account.companyName,
    });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/client/logout", (req: Request, res: Response) => {
  (req as any).session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

router.get("/client/me", requireClientAuth, async (req: Request, res: Response) => {
  const session = (req as any).session;
  const [account] = await db.select().from(clientAccounts).where(eq(clientAccounts.id, session.clientId)).limit(1);
  if (!account) return res.status(404).json({ error: "Not found" });
  return res.json({ id: account.id, name: account.name, email: account.email, companyName: account.companyName, status: account.status });
});

// ── Staff: create client portal account ─────────────────────────

router.post("/staff/clients", requireProjectManagerAuth, async (req: Request, res: Response) => {
  try {
    const tid = getTenantId(req);
    const { name, email, password, companyName } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email, and password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const emailLower = email.toLowerCase().trim();
    const existing = await db.select().from(clientAccounts).where(eq(clientAccounts.email, emailLower)).limit(1);
    if (existing.length > 0) {
      return res.status(409).json({ error: "A client portal account with this email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const [account] = await db.insert(clientAccounts).values({
      tenantId: tid,
      name: name.trim(),
      email: emailLower,
      passwordHash,
      companyName: companyName?.trim() || null,
      status: "approved",
    }).returning();

    return res.status(201).json({
      id: account.id,
      name: account.name,
      email: account.email,
      companyName: account.companyName,
      status: account.status,
    });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── Admin: manage clients ─────────────────────────────────────────

router.get("/admin/clients", requireAdminAuth, async (req: Request, res: Response) => {
  const tid = getTenantId(req);
  const accounts = await db.select({
    id: clientAccounts.id,
    name: clientAccounts.name,
    email: clientAccounts.email,
    companyName: clientAccounts.companyName,
    status: clientAccounts.status,
    createdAt: clientAccounts.createdAt,
  }).from(clientAccounts).where(eq(clientAccounts.tenantId, tid)).orderBy(clientAccounts.createdAt);
  return res.json(accounts);
});

router.patch("/admin/clients/:id/status", requireAdminAuth, async (req: Request, res: Response) => {
  const tid = getTenantId(req);
  const id = String(req.params.id);
  const { status } = req.body;
  if (!["approved", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const [updated] = await db.update(clientAccounts)
    .set({ status: status as "approved" | "rejected" | "pending", updatedAt: new Date() })
    .where(and(eq(clientAccounts.id, id), eq(clientAccounts.tenantId, tid)))
    .returning();
  if (!updated) return res.status(404).json({ error: "Not found" });
  return res.json(updated);
});

export default router;
