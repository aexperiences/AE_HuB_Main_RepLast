import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { db, tenantsTable } from "@workspace/db";
import { requireEmployeeAuth, getTenantId } from "../middlewares/authMiddleware";
import { getUncachableStripeClient } from "../stripeClient";

const router = Router();

router.get("/billing/plans", async (_req, res): Promise<void> => {
  try {
    const result = await db.execute(sql`
      SELECT
        p.id as product_id,
        p.name as product_name,
        p.description as product_description,
        p.metadata as product_metadata,
        pr.id as price_id,
        pr.unit_amount,
        pr.currency,
        pr.recurring,
        pr.active as price_active
      FROM stripe.products p
      LEFT JOIN stripe.prices pr ON pr.product = p.id AND pr.active = true
      WHERE p.active = true
      ORDER BY pr.unit_amount ASC NULLS LAST
    `);

    const productsMap = new Map<string, any>();
    for (const row of result.rows as any[]) {
      if (!productsMap.has(row.product_id)) {
        productsMap.set(row.product_id, {
          id: row.product_id,
          name: row.product_name,
          description: row.product_description,
          metadata: row.product_metadata ?? {},
          prices: [],
        });
      }
      if (row.price_id) {
        productsMap.get(row.product_id).prices.push({
          id: row.price_id,
          unitAmount: row.unit_amount,
          currency: row.currency,
          recurring: row.recurring,
        });
      }
    }

    res.json({ plans: Array.from(productsMap.values()) });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to load plans", detail: err.message });
  }
});

router.get("/billing/subscription", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tid));
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

  if (!tenant.stripeSubscriptionId) {
    res.json({ subscription: null, tenant: { plan: tenant.plan, status: tenant.status, trialEndsAt: tenant.trialEndsAt } });
    return;
  }

  try {
    const result = await db.execute(
      sql`SELECT * FROM stripe.subscriptions WHERE id = ${tenant.stripeSubscriptionId}`
    );
    res.json({
      subscription: result.rows[0] ?? null,
      tenant: { plan: tenant.plan, status: tenant.status, trialEndsAt: tenant.trialEndsAt },
    });
  } catch {
    res.json({
      subscription: null,
      tenant: { plan: tenant.plan, status: tenant.status, trialEndsAt: tenant.trialEndsAt },
    });
  }
});

router.post("/billing/checkout", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const { priceId } = req.body;
  if (!priceId) { res.status(400).json({ error: "priceId is required" }); return; }

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tid));
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

  try {
    const stripe = await getUncachableStripeClient();

    let customerId = tenant.stripeCustomerId ?? undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: tenant.name,
        metadata: { tenantId: tenant.id, slug: tenant.slug },
      });
      await db.update(tenantsTable)
        .set({ stripeCustomerId: customer.id })
        .where(eq(tenantsTable.id, tid));
      customerId = customer.id;
    }

    const baseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      success_url: `${baseUrl}/?billing=success`,
      cancel_url: `${baseUrl}/?billing=cancel`,
      metadata: { tenantId: tenant.id },
    });

    res.json({ url: session.url });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to create checkout session", detail: err.message });
  }
});

router.post("/billing/portal", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tid));
  if (!tenant?.stripeCustomerId) {
    res.status(400).json({ error: "No billing account found. Please subscribe first." });
    return;
  }

  try {
    const stripe = await getUncachableStripeClient();
    const baseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: tenant.stripeCustomerId,
      return_url: `${baseUrl}/`,
    });

    res.json({ url: portalSession.url });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to open billing portal", detail: err.message });
  }
});

export default router;
