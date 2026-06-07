import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { db, tenantsTable, employeeAccounts } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sendEmail } from "../lib/email";

const router = Router();

router.post("/trials/signup", async (req: Request, res: Response) => {
  const { name, email, company, password, vertical, demoToken } = req.body;

  if (!name || !email || !company || !password) {
    res.status(400).json({ error: "Name, email, company, and password are required" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const emailLower = email.toLowerCase().trim();

  const existing = await db
    .select({ id: employeeAccounts.id })
    .from(employeeAccounts)
    .where(eq(employeeAccounts.email, emailLower))
    .limit(1);

  if (existing.length > 0) {
    res.status(409).json({ error: "An account with this email already exists. Try logging in." });
    return;
  }

  const slug = company
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48) + "-" + Math.random().toString(36).slice(2, 7);

  const trialEndsAt = new Date();
  trialEndsAt.setDate(trialEndsAt.getDate() + 30);

  const [tenant] = await db
    .insert(tenantsTable)
    .values({
      name: company,
      slug,
      plan: "trial",
      status: "active",
      trialEndsAt,
    })
    .returning();

  const passwordHash = await bcrypt.hash(password, 12);
  const [account] = await db
    .insert(employeeAccounts)
    .values({
      tenantId: tenant.id,
      name,
      email: emailLower,
      passwordHash,
      role: "admin",
      status: "approved",
    })
    .returning();

  (req as any).session.employeeId   = account.id;
  (req as any).session.employeeRole = account.role;
  (req as any).session.employeeName = account.name;
  (req as any).session.tenantId     = tenant.id;

  const loginUrl = `${process.env.APP_URL ?? "https://accelerated-experiences-1.replit.app"}/sign-in`;

  await sendEmail({
    to: emailLower,
    subject: "Welcome to AEHub — Your 30-Day Pilot Has Started!",
    html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a1e3d;color:#fff;border-radius:12px;overflow:hidden;">
  <div style="background:linear-gradient(135deg,#0ea5e9,#1d4ed8);padding:32px 24px;text-align:center;">
    <h1 style="margin:0;font-size:24px;">Welcome to AEHub, ${name.split(" ")[0]}!</h1>
    <p style="margin:8px 0 0;opacity:0.9;">Your 30-day free pilot is live.</p>
  </div>
  <div style="padding:32px 24px;">
    <p style="margin:0 0 16px;">Hi ${name.split(" ")[0]},</p>
    <p style="margin:0 0 16px;">Your AEHub pilot for <strong>${company}</strong> is ready to go. You have full access to every feature for the next 30 days — no credit card needed.</p>
    <div style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px;margin:0 0 24px;">
      <p style="margin:0 0 8px;font-size:13px;opacity:0.7;">YOUR ACCOUNT</p>
      <p style="margin:0 0 4px;font-size:15px;"><strong>${name}</strong></p>
      <p style="margin:0;font-size:13px;opacity:0.7;">${emailLower}</p>
    </div>
    <div style="text-align:center;margin:0 0 32px;">
      <a href="${loginUrl}" style="display:inline-block;background:linear-gradient(135deg,#0ea5e9,#1d4ed8);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:bold;font-size:16px;">Open My AEHub →</a>
    </div>
    <p style="margin:0 0 8px;font-size:14px;opacity:0.7;"><strong>What to do first:</strong></p>
    <ol style="margin:0;padding-left:20px;font-size:14px;opacity:0.8;line-height:1.8;">
      <li>Create your first project</li>
      <li>Add a client</li>
      <li>Send your first invoice</li>
      <li>Ask Bobert anything — he's available 24/7</li>
    </ol>
    <p style="margin:24px 0 0;font-size:13px;opacity:0.5;">Questions? Just reply to this email or chat with Bobert inside AEHub.</p>
  </div>
</div>`,
    text: `Welcome to AEHub, ${name}!\n\nYour 30-day pilot for ${company} is live.\nLog in at: ${loginUrl}\n\nFull access, no credit card required.\n\nWelcome aboard!`,
  });

  if (demoToken) {
    try {
      await db.execute(
        (await import("drizzle-orm/sql")).sql`
          UPDATE crm_leads
          SET demo_completed_at = COALESCE(demo_completed_at, NOW()),
              campaign_status = 'pilot_active',
              notes = COALESCE(notes, '') || E'\n[Pilot started: ${company} — ${emailLower}]'
          WHERE demo_token = ${demoToken}
        `
      );
    } catch { /* non-critical */ }
  }

  req.log?.info?.({ tenantId: tenant.id, email: emailLower, vertical }, "trial signup complete");

  res.json({
    ok: true,
    tenantId: tenant.id,
    trialEndsAt: tenant.trialEndsAt,
    name: account.name,
    email: account.email,
  });
});

router.get("/trials/status", async (req: Request, res: Response) => {
  const tenantId = (req as any).session?.tenantId;
  if (!tenantId) {
    res.json({ trial: false });
    return;
  }
  const [tenant] = await db
    .select({ plan: tenantsTable.plan, trialEndsAt: tenantsTable.trialEndsAt, status: tenantsTable.status })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId))
    .limit(1);

  if (!tenant || tenant.plan !== "trial") {
    res.json({ trial: false });
    return;
  }

  const now = new Date();
  const daysLeft = Math.max(0, Math.ceil((new Date(tenant.trialEndsAt).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
  res.json({ trial: true, daysLeft, trialEndsAt: tenant.trialEndsAt, status: tenant.status });
});

export default router;
