// server.js — Bitget futures: only longs (open long on BUY, close long on SELL)
import express from "express";
import bodyParser from "body-parser";
import ccxt from "ccxt";

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.text({ type: "*/*" }));

// ===== CONFIG (ENV) =====
const EXCHANGE_ID = process.env.EXCHANGE_ID || "bitget";
const API_KEY = process.env.EXCHANGE_KEY || "";
const API_SECRET = process.env.EXCHANGE_SECRET || "";
const API_PASSWORD = process.env.EXCHANGE_PASSPHRASE || ""; // passphrase
const DEFAULT_SYMBOL = process.env.DEFAULT_SYMBOL || "BTC/USDT:USDT";
const EXCHANGE_TYPE = (process.env.EXCHANGE_TYPE || "swap").toLowerCase(); // swap expected
const MIN_AMOUNT = parseFloat(process.env.MIN_ORDER_AMOUNT || "0.00000001");

if (!API_KEY || !API_SECRET) {
  console.warn("⚠️ WARNING: EXCHANGE_KEY / EXCHANGE_SECRET not set in ENV");
}

// ===== INIT EXCHANGE =====
let exchange;
try {
  const ExchangeClass = ccxt[EXCHANGE_ID];
  if (!ExchangeClass) {
    console.error("Exchange class not found in ccxt:", EXCHANGE_ID);
    process.exit(1);
  }
  exchange = new ExchangeClass({
    apiKey: API_KEY,
    secret: API_SECRET,
    password: API_PASSWORD || undefined,
    enableRateLimit: true,
    options: { defaultType: EXCHANGE_TYPE === "spot" ? "spot" : "swap" }
  });
  // optional hint
  try { exchange.options.defaultType = exchange.options.defaultType || (EXCHANGE_TYPE === "spot" ? "spot" : "swap"); } catch(e){}

} catch (e) {
  console.error("Failed to init exchange:", e && e.toString ? e.toString() : e);
  process.exit(1);
}

// ===== Load markets =====
let marketsReady = false;
async function loadMarkets(retry = 0) {
  try {
    await exchange.loadMarkets(true);
    marketsReady = true;
    console.log("Markets loaded for", EXCHANGE_ID, "type:", EXCHANGE_TYPE);
  } catch (err) {
    console.error("loadMarkets error:", err && err.toString ? err.toString() : err);
    if (retry < 3) {
      await new Promise(r => setTimeout(r, 2000));
      return loadMarkets(retry + 1);
    }
  }
}
loadMarkets();

// ===== Helpers =====
function normalizeSymbol(s) {
  if (!s) return DEFAULT_SYMBOL;
  let sym = String(s).trim();
  sym = sym.replace("-", "/").replace("_", "/");
  if (!sym.includes("/") && sym.length >= 6) sym = sym.slice(0,3) + "/" + sym.slice(3);
  return sym.toUpperCase();
}

async function getPriceAndBalances(symbol) {
  if (!marketsReady) await loadMarkets();
  const market = exchange.markets && exchange.markets[symbol] ? exchange.markets[symbol] : null;
  // fetch balance
  const balance = await exchange.fetchBalance();
  // price (ticker)
  const ticker = await exchange.fetchTicker(symbol).catch(e => { console.warn("fetchTicker failed", e && e.toString ? e.toString() : e); return null; });
  const price = ticker && (ticker.last || ticker.close || ticker.bid) ? (ticker.last || ticker.close || ticker.bid) : null;
  return { market, balance, price };
}

// Try to compute buy amount = all-in on quote (USDT) / price
async function computeBuyAmount(symbol) {
  const { market, balance, price } = await getPriceAndBalances(symbol);
  if (!price) throw new Error("Cannot fetch price for " + symbol);
  const quote = market ? market.quote : (symbol.split("/")[1]);
  const freeQuote = (balance && balance.free && balance.free[quote]) ? balance.free[quote] : 0;
  let qty = freeQuote / price;
  try { qty = parseFloat(exchange.amountToPrecision(symbol, qty)); } catch(e){ /* fallthrough */ }
  return { qty, price, freeQuote };
}

// Try to compute sell amount = position size for long (fetchPositions) or free base
async function computeSellAmount(symbol) {
  // prefer fetchPositions if available (for futures)
  try {
    if (typeof exchange.fetchPositions === "function") {
      const pos = await exchange.fetchPositions([symbol]).catch(e => { console.warn("fetchPositions failed:", e && e.toString ? e.toString() : e); return null; });
      if (pos && Array.isArray(pos) && pos.length > 0) {
        // find long position (depends on exchange response)
        // try to extract size/positionAmt/positionSize
        for (const p of pos) {
          // p may contain fields: contracts, size, positionAmt, amount, notional
          const sizeCandidates = [p.contracts, p.size, p.amount, p.positionAmt, p.position_size, p[ 'position' ]].filter(Boolean);
          if (sizeCandidates.length > 0) {
            const raw = Number(sizeCandidates[0]);
            if (!isNaN(raw) && raw > 0) {
              let qty = raw;
              try { qty = parseFloat(exchange.amountToPrecision(symbol, qty)); } catch(e){}
              return { qty, from: "position", raw };
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn("fetchPositions exception:", e && e.toString ? e.toString() : e);
  }

  // fallback: use free base balance
  const { market, balance } = await getPriceAndBalances(symbol);
  const base = market ? market.base : (symbol.split("/")[0]);
  const freeBase = (balance && balance.free && balance.free[base]) ? balance.free[base] : 0;
  let qty = freeBase;
  try { qty = parseFloat(exchange.amountToPrecision(symbol, qty)); } catch(e){}
  return { qty, from: "balance", freeBase };
}

// robust market order placer with fallback
async function placeMarketOrder(symbol, side, amount, extraParams = {}) {
  const params = Object.assign({}, extraParams);
  if (EXCHANGE_ID === 'bitget' && EXCHANGE_TYPE === 'swap') {
    params.orderType = 'market';
    params.type = 'market';
  }
  try {
    if (typeof exchange.createMarketOrder === 'function') {
      return await exchange.createMarketOrder(symbol, side, amount, params);
    }
  } catch (err) {
    console.warn("createMarketOrder failed, fallback to createOrder('market'):", err && err.toString ? err.toString() : err);
  }
  // fallback
  return await exchange.createOrder(symbol, 'market', side, amount, undefined, params);
}

// ===== Endpoints =====
app.get("/", (_req, res) => res.send(`${EXCHANGE_ID} long-only bot LIVE`));

app.post("/webhook", async (req, res) => {
  try {
    // parse payload JSON or plain text
    let payload = {};
    if (req.is("application/json") && typeof req.body === "object") {
      payload = req.body;
    } else {
      const text = (req.body || "").toString().trim();
      try { payload = JSON.parse(text); } catch(e) {
        const parts = text.split(/\s+/).filter(Boolean);
        if (parts.length === 0) return res.status(400).json({ error: "Empty payload" });
        payload.action = parts[0].toLowerCase();
        payload.symbol = parts[1] ? parts[1] : DEFAULT_SYMBOL;
      }
    }

    const action = (payload.action || "").toLowerCase();
    const symbol = normalizeSymbol(payload.symbol || DEFAULT_SYMBOL);

    if (!action || (action !== "buy" && action !== "sell")) return res.status(400).json({ error: "Action must be buy or sell" });
    if (!symbol) return res.status(400).json({ error: "Missing symbol" });

    if (!marketsReady) await loadMarkets();

    console.log("Received webhook:", action, symbol);

    if (action === "buy") {
      // compute buy qty (all-in)
      const { qty, price, freeQuote } = await computeBuyAmount(symbol);
      console.log("Computed BUY qty:", { qty, price, freeQuote });
      if (!qty || isNaN(qty) || qty <= MIN_AMOUNT) {
        return res.status(400).json({ error: "Buy amount too small or zero", qty });
      }
      // place market buy
      const order = await placeMarketOrder(symbol, "buy", qty);
      console.log("Buy order response:", order);
      return res.json({ ok: true, action: "buy", order });
    } else { // sell -> close long
      const sellInfo = await computeSellAmount(symbol);
      const qty = parseFloat(sellInfo.qty);
      console.log("Computed SELL qty:", sellInfo);
      if (!qty || isNaN(qty) || qty <= MIN_AMOUNT) {
        return res.status(400).json({ error: "Sell amount too small or zero", qty });
      }
      // For swap: mark reduceOnly if supported to ensure closing long
      const extraParams = {};
      if (EXCHANGE_TYPE === "swap") {
        extraParams.reduceOnly = true;
      }
      const order = await placeMarketOrder(symbol, "sell", qty, extraParams);
      console.log("Sell (close long) order response:", order);
      return res.json({ ok: true, action: "sell", order });
    }
  } catch (err) {
    console.error("Webhook error:", err && err.toString ? err.toString() : err);
    return res.status(500).json({ error: err && err.toString ? err.toString() : String(err) });
  }
});

// ===== Start =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BOT LIVE on port ${PORT}`));
