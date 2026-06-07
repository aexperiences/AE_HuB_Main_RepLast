import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, invoicesTable } from "@workspace/db";
import { requireClientAuth, getTenantId } from "../middlewares/authMiddleware";
import { getUncachableStripeClient } from "../stripeClient";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * POST /stripe/create-payment-session
 * Client-authenticated route: creates a Stripe Checkout session for a given invoice.
 * Stores the Stripe session ID on the invoice row and returns the checkout URL.
 */
router.post("/stripe/create-payment-session", requireClientAuth, async (req, res): Promise<void> => {
  const session = (req as any).session;
  const clientId: string | undefined = session.clientId;
  if (!clientId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { invoiceId } = req.body;
  if (!invoiceId || typeof invoiceId !== "number") {
    res.status(400).json({ error: "invoiceId (number) is required" });
    return;
  }

  const tid = getTenantId(req);

  const [invoice] = await db
    .select()
    .from(invoicesTable)
    .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.tenantId, tid)))
    .limit(1);

  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  if (invoice.clientAccountId !== clientId) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  if (invoice.status === "paid" || invoice.status === "cancelled" || invoice.status === "draft") {
    res.status(400).json({ error: `Invoice cannot be paid in status: ${invoice.status}` });
    return;
  }

  const amountCents = Math.round(Number(invoice.amount) * 100);
  if (amountCents <= 0) {
    res.status(400).json({ error: "Invoice amount must be greater than zero" });
    return;
  }

  try {
    const stripe = await getUncachableStripeClient();

    const host = process.env.REPLIT_DOMAINS?.split(",")[0];
    const baseUrl = host ? `https://${host}` : `${req.protocol}://${req.get("host")}`;

    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: {
              name: `Invoice ${invoice.invoiceNumber}`,
              description: invoice.projectName
                ? `Project: ${invoice.projectName}`
                : `Payment to Accelerated Experiences LLC`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        invoiceId: String(invoice.id),
        invoiceNumber: invoice.invoiceNumber,
        clientAccountId: clientId,
      },
      success_url: `${baseUrl}/client?payment=success&invoice=${invoice.id}`,
      cancel_url: `${baseUrl}/client?tab=invoices`,
    });

    await db
      .update(invoicesTable)
      .set({ stripeCheckoutSessionId: checkoutSession.id })
      .where(eq(invoicesTable.id, invoice.id));

    res.json({ url: checkoutSession.url });
  } catch (err) {
    logger.error({ err }, "Failed to create Stripe checkout session");
    res.status(500).json({ error: "Failed to create payment session" });
  }
});

export default router;
