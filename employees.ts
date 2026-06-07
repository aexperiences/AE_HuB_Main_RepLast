import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { eq, and, count } from "drizzle-orm";
import { db, employeeAccounts, employeeOnboardingTable } from "@workspace/db";
import { requireAdminAuth, getTenantId } from "../middlewares/authMiddleware";

const router: IRouter = Router();

type EmploymentType = "full_time" | "part_time" | "contractor" | "intern";

const ONBOARDING_TASKS: { taskType: string; label: string; forTypes: EmploymentType[] | "all" }[] = [
  { taskType: "offer_letter",      label: "Offer Letter / Agreement",                   forTypes: "all" },
  { taskType: "w4",                label: "W-4: Federal Withholding Certificate",        forTypes: ["full_time", "part_time", "intern"] },
  { taskType: "i9",                label: "I-9: Employment Eligibility Verification",    forTypes: ["full_time", "part_time", "intern"] },
  { taskType: "w9",                label: "W-9: Request for Taxpayer Identification",    forTypes: ["contractor"] },
  { taskType: "direct_deposit",    label: "Direct Deposit Authorization",               forTypes: "all" },
  { taskType: "emergency_contact", label: "Emergency Contact Form",                     forTypes: "all" },
  { taskType: "handbook",          label: "Employee Handbook Acknowledgment",           forTypes: ["full_time", "part_time", "intern"] },
  { taskType: "nda",               label: "Non-Disclosure Agreement (NDA)",             forTypes: "all" },
];

function tasksForType(empType: EmploymentType | null) {
  if (!empType) return ONBOARDING_TASKS.filter(t => t.forTypes === "all");
  return ONBOARDING_TASKS.filter(t => t.forTypes === "all" || (t.forTypes as EmploymentType[]).includes(empType));
}

async function generateEmployeeId(tenantId: string): Promise<string> {
  const [row] = await db.select({ c: count() }).from(employeeAccounts)
    .where(eq(employeeAccounts.tenantId, tenantId));
  const num = (Number(row?.c ?? 0)) + 1;
  return `AE-${num.toString().padStart(4, "0")}`;
}

function safeEmployee(e: typeof employeeAccounts.$inferSelect) {
  const { passwordHash: _, ...rest } = e;
  return rest;
}

router.get("/employees", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const rows = await db.select().from(employeeAccounts)
    .where(eq(employeeAccounts.tenantId, tid))
    .orderBy(employeeAccounts.createdAt);

  const onboarding = await db.select().from(employeeOnboardingTable)
    .where(eq(employeeOnboardingTable.tenantId, tid));

  const result = rows.map(e => {
    const tasks = onboarding.filter(t => t.employeeAccountId === e.id);
    const total = tasks.length;
    const done = tasks.filter(t => t.status === "completed" || t.status === "waived").length;
    return { ...safeEmployee(e), onboardingTotal: total, onboardingDone: done };
  });

  res.json(result);
});

router.get("/employees/:id", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const [employee] = await db.select().from(employeeAccounts)
    .where(and(eq(employeeAccounts.id, String(req.params.id)), eq(employeeAccounts.tenantId, tid)));
  if (!employee) { res.status(404).json({ error: "Employee not found" }); return; }
  res.json(safeEmployee(employee));
});

router.post("/employees", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    const tid = getTenantId(req);
    const { name, email, password, role, jobTitle, department, employmentType, startDate, phone,
            emergencyContactName, emergencyContactPhone, address, notes } = req.body;

    if (!name || !email || !password) {
      res.status(400).json({ error: "name, email, and password are required" }); return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" }); return;
    }

    const emailLower = email.toLowerCase().trim();
    const existing = await db.select().from(employeeAccounts).where(eq(employeeAccounts.email, emailLower)).limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: "An account with this email already exists" }); return;
    }

    const employeeId = await generateEmployeeId(tid);
    const passwordHash = await bcrypt.hash(password, 12);

    const [employee] = await db.insert(employeeAccounts).values({
      tenantId: tid,
      employeeId,
      name: name.trim(),
      email: emailLower,
      passwordHash,
      role: (role ?? "employee") as "admin" | "employee" | "project_manager" | "accounting" | "account_representative",
      status: "approved",
      jobTitle: jobTitle ?? null,
      department: department ?? null,
      employmentType: (employmentType ?? null) as "full_time" | "part_time" | "contractor" | "intern" | null,
      startDate: startDate ?? null,
      phone: phone ?? null,
      emergencyContactName: emergencyContactName ?? null,
      emergencyContactPhone: emergencyContactPhone ?? null,
      address: address ?? null,
      notes: notes ?? null,
    }).returning();

    const tasks = tasksForType(employmentType ?? null);
    if (tasks.length > 0) {
      await db.insert(employeeOnboardingTable).values(
        tasks.map(t => ({
          tenantId: tid,
          employeeAccountId: employee.id,
          taskType: t.taskType,
          label: t.label,
          status: "pending" as const,
        }))
      );
    }

    res.status(201).json(safeEmployee(employee));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/employees/:id", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    const tid = getTenantId(req);
    const { name, role, status, jobTitle, department, employmentType, startDate, phone,
            emergencyContactName, emergencyContactPhone, address, notes } = req.body;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) updates.name = name.trim();
    if (role !== undefined) updates.role = role;
    if (status !== undefined) updates.status = status;
    if (jobTitle !== undefined) updates.jobTitle = jobTitle;
    if (department !== undefined) updates.department = department;
    if (employmentType !== undefined) updates.employmentType = employmentType;
    if (startDate !== undefined) updates.startDate = startDate;
    if (phone !== undefined) updates.phone = phone;
    if (emergencyContactName !== undefined) updates.emergencyContactName = emergencyContactName;
    if (emergencyContactPhone !== undefined) updates.emergencyContactPhone = emergencyContactPhone;
    if (address !== undefined) updates.address = address;
    if (notes !== undefined) updates.notes = notes;

    const [employee] = await db.update(employeeAccounts)
      .set(updates)
      .where(and(eq(employeeAccounts.id, String(req.params.id)), eq(employeeAccounts.tenantId, tid)))
      .returning();

    if (!employee) { res.status(404).json({ error: "Employee not found" }); return; }
    res.json(safeEmployee(employee));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/employees/:id/password", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    const tid = getTenantId(req);
    const { password } = req.body;
    if (!password || password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" }); return;
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const [employee] = await db.update(employeeAccounts)
      .set({ passwordHash, updatedAt: new Date() })
      .where(and(eq(employeeAccounts.id, String(req.params.id)), eq(employeeAccounts.tenantId, tid)))
      .returning();
    if (!employee) { res.status(404).json({ error: "Employee not found" }); return; }
    res.json({ success: true });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/employees/:id", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const [employee] = await db.update(employeeAccounts)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(and(eq(employeeAccounts.id, String(req.params.id)), eq(employeeAccounts.tenantId, tid)))
    .returning();
  if (!employee) { res.status(404).json({ error: "Employee not found" }); return; }
  res.json({ success: true });
});

router.get("/employees/:id/onboarding", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const tasks = await db.select().from(employeeOnboardingTable)
    .where(and(eq(employeeOnboardingTable.employeeAccountId, String(req.params.id)), eq(employeeOnboardingTable.tenantId, tid)))
    .orderBy(employeeOnboardingTable.createdAt);
  res.json(tasks);
});

router.patch("/employees/:id/onboarding/:taskId", requireAdminAuth, async (req, res): Promise<void> => {
  try {
    const tid = getTenantId(req);
    const { status, notes } = req.body;
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (status !== undefined) {
      updates.status = status;
      if (status === "completed") updates.completedAt = new Date();
      if (status === "pending") updates.completedAt = null;
    }
    if (notes !== undefined) updates.notes = notes;

    const [task] = await db.update(employeeOnboardingTable)
      .set(updates)
      .where(and(eq(employeeOnboardingTable.id, String(req.params.taskId)), eq(employeeOnboardingTable.tenantId, tid)))
      .returning();
    if (!task) { res.status(404).json({ error: "Task not found" }); return; }
    res.json(task);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
