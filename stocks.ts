import { requireEmployeeAuth } from "../middlewares/authMiddleware";
import { Router, type IRouter } from "express";
import yahooFinance from "yahoo-finance2";
import { openrouter } from "@workspace/integrations-openrouter-ai";

const router: IRouter = Router();

// 60-second quote cache
const quoteCache = new Map<string, { data: unknown; ts: number }>();
const histCache  = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL  = 60_000;

const DEFAULT_WATCHLIST = [
  { symbol: "SNDL",  name: "Sundial Growers",        sector: "Cannabis"     },
  { symbol: "GNUS",  name: "Genius Brands Intl",     sector: "Media"        },
  { symbol: "BNGO",  name: "Bionano Genomics",        sector: "Biotech"      },
  { symbol: "OCGN",  name: "Ocugen Inc",              sector: "Biotech"      },
  { symbol: "SPCE",  name: "Virgin Galactic",         sector: "Aerospace"    },
  { symbol: "MVIS",  name: "MicroVision Inc",         sector: "Technology"   },
  { symbol: "TLRY",  name: "Tilray Brands",           sector: "Cannabis"     },
  { symbol: "CLOV",  name: "Clover Health",           sector: "Healthcare"   },
  { symbol: "MULN",  name: "Mullen Automotive",       sector: "EV"           },
  { symbol: "NKLA",  name: "Nikola Corporation",      sector: "EV"           },
  { symbol: "INPX",  name: "Inpixon",                 sector: "Technology"   },
  { symbol: "BLNK",  name: "Blink Charging",          sector: "EV/Charging"  },
  { symbol: "GPRO",  name: "GoPro Inc",               sector: "Consumer Tech"},
  { symbol: "SOFI",  name: "SoFi Technologies",       sector: "Fintech"      },
  { symbol: "PLTR",  name: "Palantir Technologies",   sector: "Technology"   },
  { symbol: "LCID",  name: "Lucid Group",             sector: "EV"           },
  { symbol: "RIVN",  name: "Rivian Automotive",       sector: "EV"           },
  { symbol: "BBIG",  name: "Vinco Ventures",          sector: "Media"        },
  { symbol: "IDEX",  name: "Ideanomics",              sector: "EV"           },
  { symbol: "ILUS",  name: "Ilustrato Pictures",      sector: "Media"        },
];

function isFresh(entry: { ts: number } | undefined): boolean {
  return !!entry && Date.now() - entry.ts < CACHE_TTL;
}

/* ── GET /api/stocks/watchlist ── */
router.get("/stocks/watchlist", requireEmployeeAuth, (_req, res): void => {
  res.json(DEFAULT_WATCHLIST);
});

/* ── GET /api/stocks/quotes ── */
router.get("/stocks/quotes", requireEmployeeAuth, async (req, res): Promise<void> => {
  const rawSymbols = (req.query.symbols as string) ?? "";
  const symbols = rawSymbols.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) { res.status(400).json({ error: "symbols query param required" }); return; }

  const results: Record<string, unknown> = {};
  await Promise.allSettled(symbols.map(async symbol => {
    const cached = quoteCache.get(symbol);
    if (isFresh(cached)) { results[symbol] = cached!.data; return; }
    try {
      const q = await (yahooFinance as any).quote(symbol, {}, { validateResult: false });
      const data = {
        symbol,
        name:            q.longName ?? q.shortName ?? symbol,
        price:           q.regularMarketPrice ?? null,
        change:          q.regularMarketChange ?? null,
        changePct:       q.regularMarketChangePercent ?? null,
        open:            q.regularMarketOpen ?? null,
        high:            q.regularMarketDayHigh ?? null,
        low:             q.regularMarketDayLow ?? null,
        volume:          q.regularMarketVolume ?? null,
        avgVolume:       q.averageDailyVolume10Day ?? null,
        marketCap:       q.marketCap ?? null,
        fiftyTwoWkHigh:  q.fiftyTwoWeekHigh ?? null,
        fiftyTwoWkLow:   q.fiftyTwoWeekLow ?? null,
        currency:        q.currency ?? "USD",
        marketState:     q.marketState ?? "CLOSED",
        exchange:        q.fullExchangeName ?? q.exchange ?? null,
      };
      quoteCache.set(symbol, { data, ts: Date.now() });
      results[symbol] = data;
    } catch (err) {
      results[symbol] = { symbol, error: "Quote unavailable" };
    }
  }));

  res.json(results);
});

/* ── GET /api/stocks/history/:symbol ── */
router.get("/stocks/history/:symbol", requireEmployeeAuth, async (req, res): Promise<void> => {
  const symbol = String(req.params.symbol).toUpperCase();
  const cached = histCache.get(symbol);
  if (isFresh(cached)) { res.json(cached!.data); return; }

  try {
    const end   = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 90);

    const raw = await (yahooFinance as any).historical(symbol, {
      period1: start.toISOString().slice(0, 10),
      period2: end.toISOString().slice(0, 10),
      interval: "1d",
    }, { validateResult: false });

    const data = (raw as any[]).map((d: any) => ({
      date:   d.date instanceof Date ? d.date.toISOString().slice(0, 10) : String(d.date).slice(0, 10),
      open:   d.open,
      high:   d.high,
      low:    d.low,
      close:  d.close,
      volume: d.volume,
    }));

    histCache.set(symbol, { data, ts: Date.now() });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "History unavailable" });
  }
});

/* ── POST /api/stocks/briefing  ── */
router.post("/stocks/briefing", requireEmployeeAuth, async (req, res): Promise<void> => {
  const { quotes } = req.body ?? {};
  if (!quotes || typeof quotes !== "object") {
    res.status(400).json({ error: "quotes object required" });
    return;
  }

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const quoteLines = Object.values(quotes)
    .filter((q: any) => q && !q.error && q.price != null)
    .map((q: any) => {
      const pct = q.changePct != null ? `${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%` : "—";
      const vol = q.volume ? `Vol: ${(q.volume / 1_000_000).toFixed(1)}M` : "";
      return `${q.symbol} (${q.name}): $${q.price?.toFixed(4) ?? "—"} ${pct} | ${vol}`;
    }).join("\n");

  const systemPrompt = `You are Geoffrey, Accelerated Experiences' elite AI Financial Analyst and CFO. Today is ${today}.

You specialize in high-risk, high-reward penny stock intelligence for Anthony and Jessica — the founders of Accelerated Experiences LLC. They understand that penny stocks carry significant risk and that this is NOT professional financial advice — it's intelligent pattern analysis to inform their own decisions.

Your job: analyze the current market data below and deliver a clear, decisive MORNING BRIEFING. Be opinionated. Be specific. Don't hedge excessively.

RULES:
- Name EXACTLY 3 BUY picks with specific price targets and reasoning
- Name EXACTLY 2 SELL/AVOID picks with reasons
- Name 1 "Wildcard" — a speculative high-risk pick worth watching
- Mention specific price levels, % gain targets, and stop-loss suggestions
- Reference current price, momentum, volume trends from the data
- End with a one-sentence "Market Vibe" for today
- Format cleanly with sections: 🟢 BUY PICKS, 🔴 SELL/AVOID, 🎲 WILDCARD, 📡 MARKET VIBE
- Add the standard disclaimer at the bottom: "Not financial advice. Penny stocks carry extreme risk. DYOR."

CURRENT MARKET DATA:
${quoteLines || "No live data available — use general penny stock market knowledge for today."}`;

  try {
    const resp = await openrouter.chat.completions.create({
      model: "google/gemini-2.0-flash-001",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: `Generate today's morning briefing for Anthony and Jessica. Date: ${today}.` },
      ],
      max_tokens: 800,
    });
    const briefing = resp.choices[0]?.message?.content ?? "";
    res.json({ briefing, generatedAt: new Date().toISOString() });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Briefing generation failed" });
  }
});

export default router;
