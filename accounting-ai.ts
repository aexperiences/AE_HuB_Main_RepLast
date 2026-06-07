import { Router, type IRouter } from "express";
import { requireAccountingAuth } from "../middlewares/authMiddleware";
import { openai } from "@workspace/integrations-openai-ai-server";

const router: IRouter = Router();

router.post("/accounting/ai-insights", requireAccountingAuth, async (req, res): Promise<void> => {
  const { flashData, question, mode } = req.body;

  if (!flashData) {
    res.status(400).json({ error: "flashData is required" });
    return;
  }

  const systemPrompt = `You are Geoffrey, the AI Accountant and Financial Intelligence Officer for Accelerated Experiences LLC — a creative production company (video, photography, branding, YouTube, social media). You have deep expertise in accounting and financial management for creative service businesses, including agency cash flow dynamics, project-based revenue recognition, and tax planning for LLC structures.

You have real-time access to the company's financial data for the current period. You think like a CFO: you see the full picture, spot risks early, and give the team the specific insight they need to make better decisions.

WHEN RESPONDING:
- Be direct and specific — no hedging, no vague observations
- Format every dollar amount with $ and commas ($12,500)
- Use bullet points for lists, bold for critical figures or actions
- Flag risks clearly with severity: 🔴 Critical, 🟡 Warning, 🟢 Healthy
- Ground every observation in the actual numbers provided — no generic advice
- Keep responses under 350 words unless detail is specifically requested

WHAT YOU WATCH FOR:
- Collection efficiency: are invoices being paid on time? What's the DSO trend?
- Cash flow gaps: forecast vs actual, pipeline vs booked, burn rate vs runway
- Margin health: which projects or service lines are profitable vs dragging GP%
- Tax exposure: quarterly estimate accuracy, deduction opportunities, timing issues
- Expense anomalies: uncategorized spend, unusually high category concentrations
- Pipeline conversion: proposal → contract → invoice conversion rates

CRITICAL RULE: You NEVER take unilateral action. You analyze, flag, and recommend. Every suggested action — sending a report, filing anything, making a purchase — goes through admin approval first.`;

  const dataContext = `FINANCIAL DATA:
Month: ${flashData.month}

PM FORECASTS:
- Total forecast: $${Number(flashData.forecastTotals?.total ?? 0).toLocaleString()}
- Probability-weighted: $${Number(flashData.forecastTotals?.weighted ?? 0).toLocaleString()}
- Entries: ${flashData.forecastTotals?.count ?? 0}
${flashData.forecasts?.map((f: any) => `  • ${f.pmName}: $${Number(f.forecastAmount).toLocaleString()} @ ${f.probability}% prob${f.projectName ? ` (${f.projectName})` : ""}${f.notes ? ` — ${f.notes}` : ""}`).join("\n") ?? ""}

INVOICING & COLLECTIONS (this month):
- Invoiced: $${Number(flashData.invoices?.allMonth?.value ?? 0).toLocaleString()} (${flashData.invoices?.allMonth?.count ?? 0} invoices)
- Collected (paid): $${Number(flashData.invoices?.paid?.value ?? 0).toLocaleString()} (${flashData.invoices?.paid?.count ?? 0} invoices)
- Pending: $${Number(flashData.invoices?.pending?.value ?? 0).toLocaleString()} (${flashData.invoices?.pending?.count ?? 0} invoices)
- Overdue: $${Number(flashData.invoices?.overdue?.value ?? 0).toLocaleString()} (${flashData.invoices?.overdue?.count ?? 0} invoices)
- All-time collected: $${Number(flashData.invoices?.allTimePaid ?? 0).toLocaleString()}

PIPELINE:
- Proposals sent: ${flashData.proposals?.sent?.count ?? 0} ($${Number(flashData.proposals?.sent?.value ?? 0).toLocaleString()})
- Proposals accepted: ${flashData.proposals?.accepted?.count ?? 0} ($${Number(flashData.proposals?.accepted?.value ?? 0).toLocaleString()})
- Proposals rejected: ${flashData.proposals?.rejected?.count ?? 0}
- Contracts: ${flashData.contracts?.draft ?? 0} draft, ${flashData.contracts?.sent ?? 0} sent, ${flashData.contracts?.signed ?? 0} signed, ${flashData.contracts?.executed ?? 0} executed

ESTIMATES:
- Draft: ${flashData.estimates?.draft?.count ?? 0} ($${Number(flashData.estimates?.draft?.value ?? 0).toLocaleString()})
- Sent: ${flashData.estimates?.sent?.count ?? 0} ($${Number(flashData.estimates?.sent?.value ?? 0).toLocaleString()})
- Accepted: ${flashData.estimates?.accepted?.count ?? 0} ($${Number(flashData.estimates?.accepted?.value ?? 0).toLocaleString()})
- Rejected: ${flashData.estimates?.rejected?.count ?? 0} ($${Number(flashData.estimates?.rejected?.value ?? 0).toLocaleString()})

GROSS PROFIT MARGIN:
Client projects: ${flashData.gpm?.client?.count ?? 0} projects, ${flashData.gpm?.client?.active ?? 0} active
- Expenses: $${Number(flashData.gpm?.client?.totalExpenses ?? 0).toLocaleString()}
- Collected: $${Number(flashData.gpm?.client?.totalCollected ?? 0).toLocaleString()}
- Gross Profit: $${Number(flashData.gpm?.client?.grossProfit ?? 0).toLocaleString()}
- GP%: ${flashData.gpm?.client?.gpPct ?? "N/A"}%
${flashData.gpm?.client?.projects?.map((p: any) => `  • ${p.name}${p.client ? ` (${p.client})` : ""}: expenses $${Number(p.totalExpenses).toLocaleString()}, collected $${Number(p.totalCollected).toLocaleString()}, GP ${p.gpPct ?? "—"}%`).join("\n") ?? ""}

Internal projects: ${flashData.gpm?.internal?.count ?? 0} products
- Expenses: $${Number(flashData.gpm?.internal?.totalExpenses ?? 0).toLocaleString()}
- Revenue: $${Number(flashData.gpm?.internal?.totalCollected ?? 0).toLocaleString()}
- GP%: ${flashData.gpm?.internal?.gpPct ?? "N/A"}%`;

  let userMessage: string;
  if (mode === "auto") {
    userMessage = `Analyze this financial data and provide: 
1. A 2-sentence overall health assessment
2. Top 3 most important observations (risks, wins, or gaps)
3. One specific action the team should take this week

Be direct and specific to these numbers.`;
  } else {
    userMessage = question || "What are the key takeaways from this financial data?";
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 8192,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `${dataContext}\n\n${userMessage}` },
      ],
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: "AI service unavailable" })}\n\n`);
  }
  res.end();
});

export default router;
