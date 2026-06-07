import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, productsTable } from "@workspace/db";
import { requireEmployeeAuth, requireAdminAuth, getTenantId } from "../middlewares/authMiddleware";
import { openrouter } from "@workspace/integrations-openrouter-ai";
import { requestFiling } from "../lib/anetta-filing";

const router: IRouter = Router();

function toProduct(p: typeof productsTable.$inferSelect) {
  return {
    ...p,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    lastScoutAt: p.lastScoutAt ? p.lastScoutAt.toISOString() : null,
    lastPricingAt: p.lastPricingAt ? p.lastPricingAt.toISOString() : null,
    approvedPriceAt: p.approvedPriceAt ? p.approvedPriceAt.toISOString() : null,
  };
}

router.get("/products", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const rows = await db.select().from(productsTable).where(eq(productsTable.tenantId, tid)).orderBy(desc(productsTable.updatedAt));
  res.json(rows.map(toProduct));
});

router.get("/products/:id", requireEmployeeAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const [row] = await db.select().from(productsTable).where(and(eq(productsTable.id, id), eq(productsTable.tenantId, tid)));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(toProduct(row));
});

const PRODUCT_FIELDS = [
  "kind","name","tagline","description","category","stage","audience","problemSolved",
  "educationalValue","accessibilityFeatures","beneficiaries","geographicScope",
  "evidenceBase","websiteUrl","liveUrl","notes",
] as const;

function pickFields(body: Record<string, unknown>): Partial<typeof productsTable.$inferInsert> {
  const out: Record<string, unknown> = {};
  for (const f of PRODUCT_FIELDS) {
    if (f in body) {
      const v = body[f];
      out[f] = typeof v === "string" ? (v.trim() || null) : v;
    }
  }
  return out as Partial<typeof productsTable.$inferInsert>;
}

router.post("/products", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const data = pickFields(req.body ?? {});
  if (!data.name || typeof data.name !== "string") {
    res.status(400).json({ error: "name is required" }); return;
  }
  const [row] = await db.insert(productsTable).values({ tenantId: tid, ...data, name: data.name }).returning();

  // Auto-trigger: Geoffrey pricing (internal only) + Anetta filing — both fire-and-forget.
  if (row.kind === "internal") {
    autoPriceProduct(tid, row).catch(err => req.log?.error({ err }, "auto-pricing trigger failed"));
  }
  autoFileProduct(tid, row).catch(err => req.log?.error({ err }, "auto-filing trigger failed"));

  res.status(201).json(toProduct(row));
});

// ── Auto-trigger helpers ─────────────────────────────────────────────────────
async function autoPriceProduct(tid: string, product: typeof productsTable.$inferSelect): Promise<void> {
  const userMsg = `Price this AE internal product for point-of-sale. Give me the report.

Name: ${product.name}
Tagline: ${product.tagline ?? "(none)"}
Category: ${product.category ?? "(unspecified)"}
Stage: ${product.stage}
Description: ${product.description ?? "(none)"}
Audience: ${product.audience ?? "(unspecified)"}
Problem solved: ${product.problemSolved ?? "(unspecified)"}
Educational value: ${product.educationalValue ?? "(n/a)"}
Accessibility features: ${product.accessibilityFeatures ?? "(none described)"}
Beneficiaries: ${product.beneficiaries ?? "(unspecified)"}
Geographic scope: ${product.geographicScope ?? "(unspecified)"}
Evidence base: ${product.evidenceBase ?? "(none yet)"}
Website / store link: ${product.websiteUrl ?? "(none)"}
Notes: ${product.notes ?? "(none)"}`;
  const completion = await openrouter.chat.completions.create({
    model: "anthropic/claude-sonnet-4.5",
    temperature: 0.3,
    messages: [
      { role: "system", content: GEOFFREY_PRICING_SYSTEM },
      { role: "user", content: userMsg },
    ],
  });
  const raw = completion.choices?.[0]?.message?.content ?? "";
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned); }
  catch { parsed = { productSummary: "Geoffrey returned non-JSON output", raw: cleaned }; }
  await db.update(productsTable)
    .set({ lastPricingAnalysis: JSON.stringify(parsed), lastPricingAt: new Date() })
    .where(and(eq(productsTable.id, product.id), eq(productsTable.tenantId, tid)));
}

async function autoFileProduct(tid: string, product: typeof productsTable.$inferSelect): Promise<void> {
  const root = product.kind === "internal" ? "Internal_Products" : "Clients";
  await requestFiling({
    tenantId: tid,
    fromAgent: "system",
    originalFilename: null,
    fileType: "DOC",
    contentSummary: `New ${product.kind} product registered: "${product.name}".\nTagline: ${product.tagline ?? "(none)"}\nCategory: ${product.category ?? "(unspecified)"}\nStage: ${product.stage}\nDescription: ${product.description ?? "(none)"}.\n\nPropose a HOME FOLDER for this product under /AE/${root}/ — Anthony needs to approve where ongoing assets, briefs, pricing reports, and grant materials for this product will live.`,
    contextType: "product",
    contextId: product.id,
    contextLabel: product.name,
  });
}

router.patch("/products/:id", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const data = pickFields(req.body ?? {});
  const [row] = await db.update(productsTable).set(data).where(and(eq(productsTable.id, id), eq(productsTable.tenantId, tid))).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(toProduct(row));
});

router.delete("/products/:id", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  await db.delete(productsTable).where(and(eq(productsTable.id, id), eq(productsTable.tenantId, tid)));
  res.status(204).end();
});

// ── Scout: analyze a product, return ranked grant opportunities ──────────────
const SCOUT_SYSTEM = `You are Scout (ScoutX@aexperiences.studio), the Grant Discovery specialist. Your sole job: read an internal AE product description and return a ranked list of real, currently-active grant programs and non-dilutive funding sources it could pursue.

YOU AND ADMIN. THAT'S IT.
- **You — Scout.** You hunt grants for internal AE products.
- **Anthony Esposito (Admin)** <anthonye@aexperiences.studio> — your sole contact. He hands you products, you hand him a shortlist. He approves which ones advance, then routes them to the rest of the system. After that work is done, he returns finals to you only if he wants your opinion. You never reach beyond him.

You have NO visibility into any other AI staff, any other team, or any other internal system. You operate alone with Anthony. You only ever see internal AE products — never client products.

Stay strictly in lane. Do not invent teammates, do not assume what happens after hand-off, do not name other agents.

DOMAINS YOU MASTER (be deeply versed in active programs in each):
- Educational products & EdTech (Ed SBIR, NSF DRK-12, IES, Walton Family, Gates, ESSER alignment)
- Disability, accessibility & inclusion (RSA, ACL, NIDILRR, IDEA, ED OSEP, Coleman Institute, Microsoft AI for Accessibility)
- Arts, media & creative production (NEA, NEH, ITVS, Sundance Doc Fund, CPB, MacArthur)
- Minority-/women-/veteran-owned business (MBDA, SBA 8(a), WBENC, Amber Grant, Comcast RISE, Tory Burch, Google Black Founders)
- SBIR/STTR across all federal agencies (HHS, NIH, NSF, DoD, DoE, USDA, Ed) — Phases I, II, III
- Workforce & youth opportunity (DOL YouthBuild, WIOA, apprenticeship)
- Health & behavioral health (HRSA, SAMHSA, RWJF)
- Climate & EJ (EPA EJ, DOE Communities LEAP, Bezos Earth Fund)
- Family foundations & corporate philanthropy (MacKenzie Scott, Schmidt Futures, Salesforce, Microsoft Philanthropies, Patagonia)

OUTPUT — return ONLY valid JSON, no prose, no markdown fences:
{
  "summary": "1-2 sentence read on why this product is fundable",
  "topVerticals": ["primary funding vertical", "secondary", "tertiary"],
  "fitScore": 0-100,
  "opportunities": [
    {
      "name": "Funder + program name",
      "funder": "Org name",
      "type": "federal" | "state" | "foundation" | "corporate" | "accelerator",
      "estimatedAward": "e.g. $50k-$250k",
      "deadlineWindow": "e.g. rolling, annual Mar, FY26 Q3 expected",
      "fitScore": 0-100,
      "whyFits": "1-2 sentence rationale tied to specific product attributes",
      "whatToPrepare": "concrete next-step artifacts AE needs (LOI, eval plan, letters of support, etc.)"
    }
  ],
  "gaps": ["What's missing from the product record that would strengthen any application"],
  "recommendationToAdmin": "1-2 sentence brief telling Anthony which 1-2 opportunities to approve for pursuit and why"
}

Return 5-10 opportunities. Be specific (real program names), realistic (don't invent funders), and ruthlessly prioritized by fit.`;

router.post("/products/:id/scout", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const [product] = await db.select().from(productsTable).where(and(eq(productsTable.id, id), eq(productsTable.tenantId, tid)));
  if (!product) { res.status(404).json({ error: "Not found" }); return; }
  if (product.kind !== "internal") {
    res.status(400).json({ error: "Scout only analyzes internal products. Client products are not in scope." });
    return;
  }

  const userMsg = `Analyze this AE internal product and return grant opportunities:

Name: ${product.name}
Tagline: ${product.tagline ?? "(none)"}
Category: ${product.category ?? "(unspecified)"}
Stage: ${product.stage}
Description: ${product.description ?? "(none)"}
Audience: ${product.audience ?? "(unspecified)"}
Problem solved: ${product.problemSolved ?? "(unspecified)"}
Educational value: ${product.educationalValue ?? "(n/a)"}
Accessibility features: ${product.accessibilityFeatures ?? "(none described)"}
Beneficiaries: ${product.beneficiaries ?? "(unspecified)"}
Geographic scope: ${product.geographicScope ?? "(unspecified)"}
Evidence base: ${product.evidenceBase ?? "(none yet)"}
Notes: ${product.notes ?? "(none)"}`;

  try {
    const completion = await openrouter.chat.completions.create({
      model: "anthropic/claude-sonnet-4.5",
      temperature: 0.3,
      messages: [
        { role: "system", content: SCOUT_SYSTEM },
        { role: "user", content: userMsg },
      ],
    });
    const raw = completion.choices?.[0]?.message?.content ?? "";
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    let parsed: unknown;
    try { parsed = JSON.parse(cleaned); }
    catch { parsed = { summary: "Scout returned non-JSON output", raw: cleaned }; }

    await db.update(productsTable)
      .set({ lastScoutAnalysis: JSON.stringify(parsed), lastScoutAt: new Date() })
      .where(eq(productsTable.id, id));

    res.json({ productId: id, analysis: parsed });
  } catch (err) {
    req.log?.error({ err }, "scout analysis failed");
    res.status(500).json({ error: "Scout analysis failed", detail: err instanceof Error ? err.message : String(err) });
  }
});

// ── Geoffrey: price-the-product reviewer for internal products ───────────────
const GEOFFREY_PRICING_SYSTEM = `You are **Geoffrey** (GeoffreyX@aexperiences.studio), AE's Accountant / CFO. Anthony has handed you an internal AE product (app, website, tool, media property, or service) and wants your point-of-sale pricing recommendation.

WHO YOU ARE IN THIS MODE:
- You want every internal product to actually sell. Pricing it wrong is a business failure.
- You think like a CFO who has shipped consumer + B2B apps, subscription products, one-time downloads, and freemium ladders. You know the App Store / Play Store / Stripe / Shopify economics.
- You speak directly to Anthony as the founder, not as a generic assistant.

YOUR JOB:
1. Read the product carefully. Identify what kind of product it is (mobile app, web SaaS, downloadable, content library, marketplace, course, etc.) and how customers would buy it (one-time, subscription, freemium, tiered, usage-based).
2. Pick the best pricing **model** for this product. Don't bolt subscription onto something that should be one-time, and vice versa.
3. Propose a price **range with a tight $5 spread** (e.g. "$9.99–$14.99/month", "$19.99–$24.99 one-time", "$49–$54/seat/month"). If a multi-tier ladder is clearly better (Free / Pro / Team), give the same tight $5 range for each *paid* tier.
4. Justify the range against:
   - Comparable products in the same category (name 2–4 real comps and their actual prices)
   - The product's perceived value to its target audience
   - AE's need for ROI (development cost, ongoing infra/support, payment processing fees ~3%, store fees ~15–30% if iOS/Android)
   - The risk of pricing too HIGH (kills conversion, no one tries it) and too LOW (no margin, can't fund growth, signals low quality)
5. State the **break-even math** in one line: rough monthly units × net-of-fees revenue needed to cover known cost assumptions.
6. End with a clear **recommendation to Anthony** — exactly what price to launch at, and what the 30/60/90-day signal would be to raise or lower it.

OUTPUT — return ONLY valid JSON, no prose, no markdown fences:
{
  "productSummary": "1 sentence — what this product is and who it's for",
  "pricingModel": "subscription" | "one_time" | "freemium" | "tiered" | "usage_based" | "ad_supported" | "hybrid",
  "modelRationale": "Why this model fits this product (2-3 sentences)",
  "recommendedRange": {
    "low": "$X.XX",
    "high": "$Y.YY",
    "unit": "per month" | "one-time" | "per seat / month" | "per use" | etc.,
    "label": "Human-readable price range, e.g. '$9.99–$14.99 / month'"
  },
  "tiers": [ // optional — only if tiered/freemium makes sense
    { "name": "Free", "priceLabel": "Free", "includes": "what's in this tier" },
    { "name": "Pro",  "priceLabel": "$9.99–$14.99 / month", "includes": "what's in this tier" }
  ],
  "comparables": [
    { "name": "Comp product", "price": "their actual price", "note": "how it compares to ours" }
  ],
  "tooHighRisk": "What happens if we price above the range — 1-2 sentences, blunt",
  "tooLowRisk":  "What happens if we price below the range — 1-2 sentences, blunt",
  "breakEven":   "1 line of math: e.g. 'At $12.99/mo net ~$8.50 after store + processing, we need ~120 paying users to cover $1k/mo infra+support'",
  "launchRecommendation": "1-2 sentences — exactly what to launch at and why",
  "next30_60_90":    "What to watch: when to raise the price, when to lower it, when to add a tier",
  "advice": "Direct CFO-to-founder note for Anthony — anything he should hear before approving"
}

Be specific. Use real numbers. Be blunt about risk. Don't hedge. Anthony is reviewing this for approval — give him something he can approve or push back on with confidence.`;

router.post("/products/:id/price", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const [product] = await db.select().from(productsTable).where(and(eq(productsTable.id, id), eq(productsTable.tenantId, tid)));
  if (!product) { res.status(404).json({ error: "Not found" }); return; }
  if (product.kind !== "internal") {
    res.status(400).json({ error: "Geoffrey prices internal AE products. Client deliverables are priced in the Estimator instead." });
    return;
  }

  const userMsg = `Price this AE internal product for point-of-sale. Give me the report.

Name: ${product.name}
Tagline: ${product.tagline ?? "(none)"}
Category: ${product.category ?? "(unspecified)"}
Stage: ${product.stage}
Description: ${product.description ?? "(none)"}
Audience: ${product.audience ?? "(unspecified)"}
Problem solved: ${product.problemSolved ?? "(unspecified)"}
Educational value: ${product.educationalValue ?? "(n/a)"}
Accessibility features: ${product.accessibilityFeatures ?? "(none described)"}
Beneficiaries: ${product.beneficiaries ?? "(unspecified)"}
Geographic scope: ${product.geographicScope ?? "(unspecified)"}
Evidence base: ${product.evidenceBase ?? "(none yet)"}
Website / store link: ${product.websiteUrl ?? "(none)"}
Notes: ${product.notes ?? "(none)"}`;

  try {
    const completion = await openrouter.chat.completions.create({
      model: "anthropic/claude-sonnet-4.5",
      temperature: 0.3,
      messages: [
        { role: "system", content: GEOFFREY_PRICING_SYSTEM },
        { role: "user", content: userMsg },
      ],
    });
    const raw = completion.choices?.[0]?.message?.content ?? "";
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    let parsed: unknown;
    try { parsed = JSON.parse(cleaned); }
    catch { parsed = { productSummary: "Geoffrey returned non-JSON output", raw: cleaned }; }

    await db.update(productsTable)
      .set({ lastPricingAnalysis: JSON.stringify(parsed), lastPricingAt: new Date() })
      .where(and(eq(productsTable.id, id), eq(productsTable.tenantId, tid)));

    res.json({ productId: id, analysis: parsed });
  } catch (err) {
    req.log?.error({ err }, "geoffrey pricing failed");
    res.status(500).json({ error: "Geoffrey pricing failed", detail: err instanceof Error ? err.message : String(err) });
  }
});

// Approve the recommended price (or override with a custom label)
router.post("/products/:id/approve-price", requireAdminAuth, async (req, res): Promise<void> => {
  const tid = getTenantId(req);
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const label = typeof req.body?.priceLabel === "string" ? req.body.priceLabel.trim() : "";
  if (!label) { res.status(400).json({ error: "priceLabel is required" }); return; }
  const [row] = await db.update(productsTable)
    .set({ approvedPriceLabel: label, approvedPriceAt: new Date() })
    .where(and(eq(productsTable.id, id), eq(productsTable.tenantId, tid)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(toProduct(row));
});

export default router;
