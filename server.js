// server.js — Bitget-ready webhook bot (ccxt) — enhanced
import express from "express";
import bodyParser from "body-parser";
import ccxt from "ccxt";
import crypto from "crypto";

const app = express();

// parse bodies as text and json — we will handle both and compute HMAC from stringified body
app.use(bodyParser.text({ type: "*/*" }));
app.use(bodyParser.json({ type: "application/json", limit: "100kb" }));

// ---------- CONFIG from ENV ----------
const EXCHANGE_ID = process.env.EXCHANGE_ID || "bitget";
const EXCHANGE_TYPE = (process.env.EXCHANGE_TYPE || "swap").toLowerCase(); // 'swap' or 'spot'
const API_KEY = process.env.EXCHANGE_KEY || "";
const API_SECRET = process.env.EXCHANGE_SECRET || "";
const API_PASSWORD = process.env.EXCHANGE_PASSPHRASE || ""; // passphrase/password
const SAFETY_BUFFER = parseFloat(process.env.SAFETY_BUFFER || "1.0"); // 1.0 = 100% capital
const MIN_ORDER_AMOUNT = parseFloat(process.env.MIN_ORDER_AMOUNT || "0.00000001");
const DEFAULT_SYMBOL = process.env.DEFAULT_SYMBOL || "BTC/USDT:USDT";
const USE_SANDBOX = (process.env.SANDBOX || "false").toLowerCase() === "true";

// leverage options (optional)
const USE_LEVERAGE_FOR_SWAPS = (process.env.USE_LEVERAGE_FOR_SWAPS || "false").toLowerCase() === "true";
const LEVERAGE = parseFloat(process.env.LEVERAGE || "1");

// webhook security (optional) — if set, TradingView must send HMAC header 'x-webhook-signature'
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ""; // set to enable HMAC verification
const WEBHOOK_HEADER = process.env.WEBHOOK_HEADER || "x-webhook-signature"; // header name to check

if (!API_KEY || !API_SECRET) {
  console.warn("WARNING: EXCHANGE_KEY / EXCHANGE_SECRET not set — trading will fail until set.");
}

// ---------- INIT EXCHANGE ----------
let exchange;
try {
  const ExchangeClass = ccxt[EXCHANGE_ID];
  if (!ExchangeClass) {
    console.error("Exchange class not found in ccxt:", EXCHANGE_ID);
    process.exit(1);
  }
  const opts = {
    apiKey: API_KEY,
    secret: API_SECRET,
    password: API_PASSWORD || undefined,
    enableRateLimit: true,
    options: {}
  };
  if (EXCHANGE_ID === "bitget") {
    opts.options.defaultType = EXCHANGE_TYPE === "spot" ? "spot" : "swap";
  }
  exchange = new ExchangeClass(opts);

  // hint ccxt to use newer API version if supported
  try {
    if (!exchange.options) exchange.options = {};
    exchange.options.defaultType = opts.options.defaultType;
    exchange.options.version = "v3";
  } catch (e) {
    console.warn("Could not set exchange.options hints:", e && e.toString ? e.toString() : e);
  }

  if (USE_SANDBOX && typeof exchange.setSandboxMode === "function") {
    try {
      exchange.setSandboxMode(true);
      console.log("Sandbox mode enabled for", EXCHANGE_ID);
    } catch (e) {
      console.warn("Could not enable sandbox mode:", e && e.toString ? e.toString() : e);
    }
  }
} catch (e) {
  console.error("Failed to init exchange:", e && e.toString ? e.toString() : e);
  process.exit(1);
}

// ---------- MARKETS LOADER ----------
let marketsReady = false;
async function loadMarkets(retry = 0) {
  try {
    await exchange.loadMarkets(true);
    marketsReady = true;
    console.log("Markets loaded for", EXCHANGE_ID, "type:", EXCHANGE_TYPE);
  } catch (err) {
    console.error("Failed to load markets:", err && err.toString ? err.toString() : err);
    if (retry < 3) {
      console.log("Retrying loadMarkets in 2s (attempt", retry + 1, ")...");
      await new Promise((r) => setTimeout(r, 2000));
      return loadMarkets(retry + 1);
    }
  }
}
loadMarkets();

// ---------- DUPLICATE GUARD (in-memory, short TTL) ----------
const recentPayloads = new Map(); // key -> timestamp
const DUP_TTL_MS = 30 * 1000; // ignore identical payloads within 30s

function isDuplicate(key) {
  const now = Date.now();
  // purge old
  for (const [k, t] of recentPayloads.entries()) {
    if (now - t > DUP_TTL_MS) recentPayloads.delete(k);
  }
  if (recentPayloads.has(key)) return true;
  recentPayloads.set(key, now);
  return false;
}

// ---------- HELPERS ----------
function normalizeSymbol(inputSymbol) {
  if (!inputSymbol) return null;
  let s = String(inputSymbol).trim();
  s = s.replace("-", "/").replace("_", "/");
  if (!s.includes("/") && s.length >= 6) {
    s = s.slice(0, 3) + "/" + s.slice(3);
  }
  return s.toUpperCase();
}

function computeHmac(secret, payloadString) {
  return crypto.createHmac("sha256", secret).update(payloadString).digest("hex");
}

async function computeAllInAmounts(marketSymbol) {
  if (!marketsReady) await loadMarkets();
  let symbol = marketSymbol;

  // try to map to actual exchange market key
  if (exchange.markets && !(symbol in exchange.markets)) {
    const tries = [
      symbol,
      symbol.replace("/", ""),
      symbol.replace("/", "-"),
      symbol.replace("/", "").replace("-", "")
    ];
    const found = Object.keys(exchange.markets || {}).find(k => tries.includes(k) || tries.includes(k.replace("/", "")));
    if (found) symbol = found;
  }

  const market = exchange.markets && exchange.markets[symbol] ? exchange.markets[symbol] : null;

  let base, quote;
  if (market) {
    base = market.base;
    quote = market.quote;
  } else {
    const parts = symbol.split("/");
    base = parts[0];
    quote = parts[1];
  }

  // balances
  const bal = await exchange.fetchBalance();
  const freeQuote = (bal[quote] && (bal[quote].free || bal[quote].total)) ? (bal[quote].free || bal[quote].total) : 0;
  const freeBase  = (bal[base]  && (bal[base].free  || bal[base].total)) ? (bal[base].free  || bal[base].total) : 0;

  // price
  const ticker = await exchange.fetchTicker(symbol).catch(e => {
    console.warn("fetchTicker failed for", symbol, e && e.toString ? e.toString() : e);
    return null;
  });
  const price = ticker && (ticker.last || ticker.close || ticker.bid) ? (ticker.last || ticker.close || ticker.bid) : null;
  if (!price) throw new Error("Cannot fetch price for symbol " + symbol);

  // compute raw amounts
  let rawBuyAmount;
  if (EXCHANGE_TYPE === 'swap' && USE_LEVERAGE_FOR_SWAPS) {
    rawBuyAmount = (freeQuote * SAFETY_BUFFER * LEVERAGE) / price;
  } else {
    rawBuyAmount = (freeQuote * SAFETY_BUFFER) / price;
  }
  const rawSellAmount = freeBase * SAFETY_BUFFER;

  // round to exchange precision when possible
  let buyAmount = rawBuyAmount;
  let sellAmount = rawSellAmount;
  try {
    if (exchange.amountToPrecision) {
      if (symbol in (exchange.markets || {})) {
        buyAmount = parseFloat(exchange.amountToPrecision(symbol, buyAmount));
        sellAmount = parseFloat(exchange.amountToPrecision(symbol, sellAmount));
      } else {
        const found = Object.keys(exchange.markets || {}).find(k => k.replace("/", "") === symbol.replace("/", ""));
        if (found) {
          buyAmount = parseFloat(exchange.amountToPrecision(found, buyAmount));
          sellAmount = parseFloat(exchange.amountToPrecision(found, sellAmount));
          symbol = found;
        }
      }
    }
  } catch (e) {
    console.warn("Precision rounding failed:", e && e.toString ? e.toString() : e);
  }

  // If market limits available, ensure we respect minimum
  if (market && market.limits && market.limits.amount && market.limits.amount.min) {
    const minAmt = market.limits.amount.min;
    if (!isNaN(buyAmount) && buyAmount > 0 && buyAmount < minAmt) buyAmount = 0;
    if (!isNaN(sellAmount) && sellAmount > 0 && sellAmount < minAmt) sellAmount = 0;
  }

  return {
    symbol,
    base,
    quote,
    price,
    buyAmount,
    sellAmount,
    freeQuote,
    freeBase,
    rawBuyAmount,
    rawSellAmount
  };
}

// optional: attempt to set leverage (best-effort, depends on exchange/ccxt)
async function setLeverageIfNeeded(symbol) {
  if (EXCHANGE_TYPE !== 'swap' || !USE_LEVERAGE_FOR_SWAPS || !LEVERAGE || LEVERAGE <= 1) return;
  try {
    if (typeof exchange.setLeverage === 'function') {
      await exchange.setLeverage(LEVERAGE, symbol);
      console.log("setLeverage called via ccxt.setLeverage for", symbol, "=>", LEVERAGE);
    } else {
      // heuristics for some exchanges may require different calls; we just log and continue
      console.log("exchange.setLeverage not available on this ccxt build — skipping explicit setLeverage");
    }
  } catch (e) {
    console.warn("setLeverage failed (non-fatal):", e && e.toString ? e.toString() : e);
  }
}

// ---------- ENDPOINTS ----------
app.get("/", (_req, res) => res.send(`${EXCHANGE_ID} Bot LIVE`));

app.get("/markets", async (_req, res) => {
  try {
    if (!marketsReady) await loadMarkets();
    const mk = exchange.markets || {};
    const list = Object.keys(mk).map(k => {
      const m = mk[k];
      return {
        key: k,
        id: m.id || null,
        base: m.base || null,
        quote: m.quote || null,
        type: m.type || null,
        info: m.info || null,
        precision: m.precision || null,
        limits: m.limits || null
      };
    });
    return res.json({ count: list.length, markets: list });
  } catch (err) {
    console.error("markets endpoint error:", err && err.toString ? err.toString() : err);
    return res.status(500).json({ error: err && err.toString ? err.toString() : String(err) });
  }
});

app.get("/balance", async (_req, res) => {
  try {
    const balances = await exchange.fetchBalance();
    return res.json({ balances });
  } catch (err) {
    console.error("balance error:", err && err.toString ? err.toString() : err);
    return res.status(500).json({ error: err && err.toString ? err.toString() : String(err) });
  }
});

// webhook handler
app.post("/webhook", async (req, res) => {
  try {
    // compute string body for HMAC & duplicate check
    const rawText = (typeof req.body === "string") ? req.body : JSON.stringify(req.body || {});
    // HMAC verification (optional)
    if (WEBHOOK_SECRET) {
      const sig = (req.headers[WEBHOOK_HEADER] || req.headers[WEBHOOK_HEADER.toLowerCase()] || "").toString();
      const computed = computeHmac(WEBHOOK_SECRET, rawText);
      if (!sig) {
        console.warn("Missing webhook signature header:", WEBHOOK_HEADER);
        return res.status(401).json({ error: "missing_signature" });
      }
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(computed))) {
        console.warn("Invalid webhook signature", { got: sig, expected: computed });
        return res.status(401).json({ error: "invalid_signature" });
      }
    }

    // duplicate guard
    const dupKey = crypto.createHash("sha256").update(rawText).digest("hex");
    if (isDuplicate(dupKey)) {
      console.log("Duplicate webhook ignored");
      return res.status(200).json({ ok: true, duplicate: true });
    }

    // parse payload (supports JSON or plain text "buy SYMBOL")
    let payload = {};
    if (req.is("application/json") && typeof req.body === "object") {
      payload = req.body;
    } else {
      const text = rawText.trim();
      try {
        payload = JSON.parse(text);
      } catch (e) {
        const parts = text.split(/\s+/).filter(Boolean);
        if (parts.length === 0) return res.status(400).json({ error: "Empty payload" });
        const action = parts[0].toLowerCase();
        if (action !== "buy" && action !== "sell") return res.status(400).json({ error: "Unknown action" });
        const symbol = parts[1] ? normalizeSymbol(parts[1]) : DEFAULT_SYMBOL;
        payload = { action, symbol };
      }
    }

    const action = (payload.action || "").toLowerCase();
    let symbol = payload.symbol ? normalizeSymbol(payload.symbol) : DEFAULT_SYMBOL;

    if (!action || (action !== "buy" && action !== "sell")) return res.status(400).json({ error: "Action must be buy or sell" });
    if (!symbol) return res.status(400).json({ error: "Missing symbol" });

    if (!marketsReady) await loadMarkets();

    const amounts = await computeAllInAmounts(symbol);

    console.log("Webhook:", action, "symbol:", amounts.symbol, "computed:", {
      buyAmount: amounts.buyAmount,
      sellAmount: amounts.sellAmount,
      price: amounts.price,
      freeQuote: amounts.freeQuote,
      freeBase: amounts.freeBase,
      rawBuyAmount: amounts.rawBuyAmount
    });

    if (!API_KEY || !API_SECRET) {
      return res.status(500).json({ error: "API keys not set in environment" });
    }

    // verify market object & type
    const market = exchange.markets && exchange.markets[amounts.symbol] ? exchange.markets[amounts.symbol] : null;
    console.log("Market check:", { symbol: amounts.symbol, marketType: market && market.type, limits: market && market.limits, precision: market && market.precision });

    if (EXCHANGE_TYPE === 'swap' && market && market.type !== 'swap') {
      console.error("Refusing to place order: market is not swap as expected", amounts.symbol, market.type);
      return res.status(400).json({ error: "market_type_mismatch", marketType: market.type });
    }

    // attempt to set leverage (best-effort) for swaps
    await setLeverageIfNeeded(amounts.symbol);

    if (action === "buy") {
      const qty = parseFloat(amounts.buyAmount);
      console.log("Computed buy qty:", qty);
      if (isNaN(qty) || qty <= MIN_ORDER_AMOUNT) {
        console.error("Computed buy size too small or invalid", { qty, MIN_ORDER_AMOUNT });
        return res.status(400).json({ error: "Computed buy size too small", qty });
      }

      try {
        const order = await exchange.createMarketOrder(amounts.symbol, "buy", qty);
        console.log("Buy order full response:", order);
        try { const openOrders = await exchange.fetchOpenOrders(amounts.symbol); console.log("Open orders after buy:", openOrders); } catch(e){ console.warn("fetchOpenOrders failed:", e && e.toString ? e.toString() : e); }
        try { if (typeof exchange.fetchPositions === "function") { const pos = await exchange.fetchPositions([amounts.symbol]); console.log("Positions after buy (fetchPositions):", pos); } } catch(e){ console.warn("fetchPositions failed:", e && e.toString ? e.toString() : e); }
        try { const balAfter = await exchange.fetchBalance(); console.log("Balance after buy (free):", balAfter.free); } catch(e){ console.warn("fetchBalance failed after buy:", e && e.toString ? e.toString() : e); }
        return res.json({ status: "ok", action: "buy", order });
      } catch (e) {
        console.error("createMarketOrder BUY failed:", e && e.toString ? e.toString() : e);
        return res.status(500).json({ error: "order_failed", detail: e && e.toString ? e.toString() : String(e) });
      }
    } else {
      const qty = parseFloat(amounts.sellAmount);
      console.log("Computed sell qty:", qty);
      if (isNaN(qty) || qty <= MIN_ORDER_AMOUNT) {
        console.error("Computed sell size too small or invalid", { qty, MIN_ORDER_AMOUNT });
        return res.status(400).json({ error: "Computed sell size too small", qty });
      }

      try {
        const order = await exchange.createMarketOrder(amounts.symbol, "sell", qty);
        console.log("Sell order full response:", order);
        try { const openOrders = await exchange.fetchOpenOrders(amounts.symbol); console.log("Open orders after sell:", openOrders); } catch(e){ console.warn("fetchOpenOrders failed:", e && e.toString ? e.toString() : e); }
        try { if (typeof exchange.fetchPositions === "function") { const pos = await exchange.fetchPositions([amounts.symbol]); console.log("Positions after sell (fetchPositions):", pos); } } catch(e){ console.warn("fetchPositions failed:", e && e.toString ? e.toString() : e); }
        try { const balAfter = await exchange.fetchBalance(); console.log("Balance after sell (free):", balAfter.free); } catch(e){ console.warn("fetchBalance failed after sell:", e && e.toString ? e.toString() : e); }
        return res.json({ status: "ok", action: "sell", order });
      } catch (e) {
        console.error("createMarketOrder SELL failed:", e && e.toString ? e.toString() : e);
        return res.status(500).json({ error: "order_failed", detail: e && e.toString ? e.toString() : String(e) });
      }
    }
  } catch (err) {
    console.error("Webhook handler error:", err && err.toString ? err.toString() : err);
    return res.status(500).json({ error: err.toString ? err.toString() : String(err) });
  }
});

// ---------- START ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`BOT LIVE on port ${port}`));
