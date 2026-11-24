// Runner Rider — a paper-trading bot for pump.fun bonding curves.
//
// Strategy (written from the dev dataset's own behaviour; no coin is named):
//   - Most new coins die fast; a minority run 2x-10x from their early low, and
//     once a coin has doubled it typically keeps running (median peak after
//     the first 2x is ~1.6x the 2x price). Pullbacks after a run almost never
//     recover to the old peak (~8%), so this bot does NOT buy dips. It buys
//     the breakout itself.
//   - Entry: the first batch where a coin's price crosses 2x its own lowest
//     price since creation. One entry per coin, ever. Stake is capped by the
//     harness's per-order size cap (a share of the curve's real SOL reserves).
//   - Exit: a take-profit at +50% banks the run and frees the position slot;
//     a trailing stop (25% below the peak since entry) rides winners that
//     keep going; a hard stop (30% below entry) cuts losers. The position is
//     sold whole when any of the three trips.
//   - Discipline: at most five open positions, a hard budget of 80 buys, and
//     a bank target — once total equity is +1 SOL over starting capital, no
//     new entries are opened and the open positions trail out on their own.
//
// Protocol: agent-fun/replay/v2 over stdin/stdout (hello / batch / done, one
// reply per batch). Pure Node 22 standard library: no imports beyond node:*,
// no network, no clock, no randomness, no environment reads — the run is
// fully deterministic, so the grader's two executions agree byte for byte.
// All amounts are lamports (u64 decimal strings on the wire); prices are
// virtual-quote / virtual-token reserve ratios, computed from the events the
// harness delivers.

const LAMPORTS_PER_SOL = 1_000_000_000n;

// ---- strategy parameters (round numbers, chosen for robustness across
// ---- halves of the dev window, not fitted to any single coin) ----
const ENTRY_MULT = 2.0; // price must cross this multiple of the coin's own low
const TRAIL = 0.25; // sell when price falls this far below its peak since entry
const STOP = 0.3; // sell when price falls this far below the entry price
const TAKE_PROFIT = 1.5; // sell when price reaches this multiple of the entry price
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 5n) / 100n; // 0.05 SOL per entry
const MAX_BUYS = 80; // hard trade budget for the whole run
const BANK_SOL = 1.0; // stop opening new entries once equity is this far above start
const MAX_SLIPPAGE_BPS = 10_000; // wide open: never refuse a fill for a 2-slot move

// ---------------------------------------------------------------------------
// Minimal protocol types (only the fields this bot reads or writes).
// ---------------------------------------------------------------------------

type U64 = string;

interface Hello {
  type: 'hello';
  protocol: string;
  seed: U64;
  capital: { lamports: U64 };
  caps: { max_open_positions: number; max_order_bps_of_real_reserve: number; max_orders_per_batch: number };
  latency_slots: number;
  fees: { base_fee_lamports: U64; priority_fee_lamports: U64 };
}

interface TradeEvent {
  event: 'TradeEvent';
  mint: string;
  virtual_sol_reserves: U64;
  virtual_token_reserves: U64;
  real_sol_reserves: U64;
  slot: number;
}

interface CreateEvent {
  event: 'CreateEvent';
  mint: string;
  virtual_sol_reserves: U64;
  virtual_token_reserves: U64;
  real_token_reserves: U64;
  slot: number;
}

interface CompleteEvent {
  event: 'CompleteEvent';
  mint: string;
  slot: number;
}

type ChainEvent = TradeEvent | CreateEvent | CompleteEvent;

interface Mark {
  mint: string;
  slot: number;
  virtual_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_token_reserves: U64;
  real_quote_reserves: U64;
}

interface Fill {
  client_id: string;
  mint: string;
  side: 'buy' | 'sell';
  status: 'filled' | 'rejected' | 'failed';
}

interface Account {
  cash_lamports: U64;
  positions: { mint: string; token_amount: U64; cost_lamports: U64 }[];
}

interface Batch {
  type: 'batch';
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: Mark[];
  fills: Fill[];
  account: Account;
}

interface Done {
  type: 'done';
  seq: number;
  reason: string;
  account: Account;
}

// ---------------------------------------------------------------------------
// Per-coin bookkeeping.
// ---------------------------------------------------------------------------

interface Curve {
  vSol: bigint;
  vTok: bigint;
  realSol: bigint;
  complete: boolean;
}

interface CoinStat {
  min: number; // lowest price seen since first sighting
  last: number; // price at the previous trade event
  trades: number;
  entries: number; // buys sent for this coin
}

interface Held {
  tokens: bigint;
  cost: bigint;
  entry: number; // price at which the position was filled (mark price)
  peak: number; // highest price since entry
}

function priceOf(c: Curve): number {
  if (c.vTok === 0n) return 0;
  return Number(c.vSol) / Number(c.vTok);
}

// ---------------------------------------------------------------------------
// Line reader: split stdin into newline-delimited strings without quadratic
// rescans (the dev window is ~25 MB of JSON lines).
// ---------------------------------------------------------------------------

async function* readLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of process.stdin) {
    buf += decoder.decode(chunk as Buffer, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
    }
  }
  buf += decoder.decode();
  if (buf.length > 0) yield buf;
}

// ---------------------------------------------------------------------------
// The bot.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let hello: Hello | null = null;
  let startCapital = 0n;
  let cash = 0n;
  let txFee = 0n;

  const curves = new Map<string, Curve>();
  const coins = new Map<string, CoinStat>();
  const held = new Map<string, Held>();
  const pendingBuys = new Map<string, bigint>(); // mint -> quote lamports in flight
  const pendingSells = new Set<string>(); // mints with a sell in flight: never re-exit
  let buysSent = 0;
  let nextClient = 1;

  const out = process.stdout;
  const writeReply = (seq: number, orders: unknown[]): void => {
    out.write(`${JSON.stringify({ type: 'reply', seq, orders })}\n`);
  };

  for await (const line of readLines()) {
    if (line.trim() === '') continue;
    const msg = JSON.parse(line) as Hello | Batch | Done;
    if (msg.type === 'hello') {
      hello = msg;
      startCapital = BigInt(msg.capital.lamports);
      cash = startCapital;
      txFee = BigInt(msg.fees.base_fee_lamports) + BigInt(msg.fees.priority_fee_lamports);
      continue;
    }
    if (msg.type === 'done') {
      return;
    }
    if (msg.type !== 'batch' || hello === null) continue;
    const batch = msg;

    // ---- sync the account (authoritative): cash and open positions ----
    cash = BigInt(batch.account.cash_lamports);
    const live = new Map<string, bigint>();
    for (const p of batch.account.positions) {
      live.set(p.mint, BigInt(p.token_amount));
    }
    for (const [mint, tokens] of live) {
      const rec = held.get(mint);
      if (rec === undefined) {
        if (pendingSells.has(mint)) continue; // sell in flight: do not re-anchor
        // A buy filled since the last batch: anchor entry/peak at the mark price.
        const curve = curves.get(mint);
        const px = curve !== undefined ? priceOf(curve) : 0;
        held.set(mint, { tokens, cost: 0n, entry: px, peak: px });
      } else {
        rec.tokens = tokens;
      }
    }
    for (const mint of [...held.keys()]) {
      if (!live.has(mint)) held.delete(mint); // sold, completed, or flattened
    }
    // Fills clear pending orders (filled, rejected, or failed — all are resolved).
    for (const f of batch.fills) {
      if (f.side === 'buy') pendingBuys.delete(f.mint);
      if (f.side === 'sell') pendingSells.delete(f.mint);
    }

    // ---- fold marks in (latest reserves for held / pending mints) ----
    for (const m of batch.marks) {
      const curve = curves.get(m.mint);
      if (curve === undefined) continue;
      curve.vTok = BigInt(m.virtual_token_reserves);
      curve.vSol = BigInt(m.virtual_quote_reserves);
      curve.realSol = BigInt(m.real_quote_reserves);
    }

    const orders: unknown[] = [];
    let freeCash = cash - txFee * BigInt(pendingBuys.size + 1);
    for (const amt of pendingBuys.values()) freeCash -= amt;
    let openSlots =
      hello.caps.max_open_positions - held.size - pendingBuys.size;

    const tryExit = (mint: string): void => {
      const rec = held.get(mint);
      if (rec === undefined || rec.tokens <= 0n) return;
      if (pendingSells.has(mint)) return;
      if (orders.length >= hello!.caps.max_orders_per_batch) return;
      orders.push({
        side: 'sell',
        client_id: `o${nextClient++}`,
        mint,
        token_amount: rec.tokens.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pendingSells.add(mint);
      held.delete(mint);
    };

    const banked = (): boolean => {
      // Equity = cash + marked value of open positions, all in lamports.
      // price is SOL per token, so tokens * price * 1e9 = value in lamports.
      let equity = cash;
      for (const [mint, rec] of held) {
        const curve = curves.get(mint);
        if (curve === undefined) continue;
        const px = priceOf(curve);
        if (px > 0) equity += (rec.tokens * BigInt(Math.floor(px * 1e12))) / 1000n;
      }
      return equity >= startCapital + BigInt(Math.floor(BANK_SOL * 1e9));
    };
    const bankReached = banked();

    // ---- fold events in, in chain order; decide as each event lands ----
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const px = Number(e.virtual_sol_reserves) / Number(e.virtual_token_reserves);
        curves.set(e.mint, {
          vSol: BigInt(e.virtual_sol_reserves),
          vTok: BigInt(e.virtual_token_reserves),
          realSol: 0n,
          complete: false,
        });
        coins.set(e.mint, { min: px, last: px, trades: 0, entries: 0 });
        continue;
      }
      if (e.event === 'CompleteEvent') {
        const curve = curves.get(e.mint);
        if (curve !== undefined) curve.complete = true;
        continue;
      }
      // TradeEvent
      const curve = curves.get(e.mint) ?? {
        vSol: BigInt(e.virtual_sol_reserves),
        vTok: BigInt(e.virtual_token_reserves),
        realSol: BigInt(e.real_sol_reserves),
        complete: false,
      };
      curve.vSol = BigInt(e.virtual_sol_reserves);
      curve.vTok = BigInt(e.virtual_token_reserves);
      curve.realSol = BigInt(e.real_sol_reserves);
      curves.set(e.mint, curve);
      const px = priceOf(curve);

      let stat = coins.get(e.mint);
      if (stat === undefined) {
        stat = { min: px, last: px, trades: 0, entries: 0 };
        coins.set(e.mint, stat);
      }
      stat.trades += 1;
      const prevPrice = stat.last;
      if (px < stat.min) stat.min = px;
      stat.last = px;

      // Exits first: a held coin that trips its trailing stop, hard stop, or
      // take-profit.
      const rec = held.get(e.mint);
      if (rec !== undefined) {
        if (px > rec.peak) rec.peak = px;
        if (
          px <= rec.peak * (1 - TRAIL) ||
          px <= rec.entry * (1 - STOP) ||
          px >= rec.entry * TAKE_PROFIT
        ) {
          tryExit(e.mint);
        }
        continue;
      }

      // Entries: a fresh cross of ENTRY_MULT times the coin's own low.
      if (
        bankReached ||
        buysSent >= MAX_BUYS ||
        openSlots <= 0 ||
        pendingBuys.has(e.mint) ||
        stat.entries >= 1 ||
        curve.complete ||
        orders.length >= hello.caps.max_orders_per_batch
      ) {
        continue;
      }
      const prevMult = stat.min > 0 ? prevPrice / stat.min : 0;
      const mult = stat.min > 0 ? px / stat.min : 0;
      if (!(prevMult < ENTRY_MULT && mult >= ENTRY_MULT)) continue;
      const cap =
        (curve.realSol * BigInt(hello.caps.max_order_bps_of_real_reserve)) / 10000n;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (amount < LAMPORTS_PER_SOL / 100n) continue; // round trips must be >= 0.01 SOL
      if (freeCash < amount + txFee) continue;
      orders.push({
        side: 'buy',
        client_id: `o${nextClient++}`,
        mint: e.mint,
        quote_lamports: amount.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pendingBuys.set(e.mint, amount);
      stat.entries += 1;
      buysSent += 1;
      openSlots -= 1;
      freeCash -= amount + txFee;
    }

    // ---- exits for held coins that had no trade event this batch ----
    // (their price moved only via marks — re-check every exit rule).
    for (const [mint, rec] of [...held.entries()]) {
      const curve = curves.get(mint);
      if (curve === undefined) continue;
      const px = priceOf(curve);
      if (px <= 0) continue;
      if (px > rec.peak) rec.peak = px;
      if (
        px <= rec.peak * (1 - TRAIL) ||
        px <= rec.entry * (1 - STOP) ||
        px >= rec.entry * TAKE_PROFIT
      ) {
        tryExit(mint);
      }
    }

    writeReply(batch.seq, orders);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
