import {
  calculateTaxes,
  type TaxCalculationResult,
} from '../../core/tax/calculator.js';
import { isinToCountry } from '../../core/tax/country.js';
import type {
  CarryInPosition,
  EnrichedCorporateAction,
  EnrichedCreditInterest,
  EnrichedRawDividend,
  EnrichedTrade,
  EnrichedWithholdingTax,
  TaxPeriod,
} from '../../core/types.js';
import { db } from '../db.js';
import { fetchRatesForSession, getFixingRate } from './rates.js';
import { updateSession } from './session.js';

/** Format a Date as YYYY-MM-DD for rate lookups */
function toDateString(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${String(year)}-${month}-${day}`;
}

/** Run tax calculation for a session and persist results */
export async function calculateSessionTaxes(args: {
  sessionId: string;
}): Promise<TaxCalculationResult> {
  // 1. Load session
  const session = await db.sessions.get(args.sessionId);
  if (!session) {
    throw new Error(`Session ${args.sessionId} not found`);
  }

  // 2. Load parsed data from DB
  const [
    trades,
    dividends,
    creditInterests,
    withholdingTaxes,
    corporateActions,
    storedCarryIns,
  ] = await Promise.all([
    db.trades.where('sessionId').equals(args.sessionId).toArray(),
    db.dividends.where('sessionId').equals(args.sessionId).toArray(),
    db.creditInterests.where('sessionId').equals(args.sessionId).toArray(),
    db.withholdingTaxes.where('sessionId').equals(args.sessionId).toArray(),
    db.corporateActions.where('sessionId').equals(args.sessionId).toArray(),
    db.carryInPositions.where('sessionId').equals(args.sessionId).toArray(),
  ]);

  // 2a. Merge prior-year session's openLots as carry-ins (with full PLN cost
  // basis). Stored carry-ins with cost basis (user-entered) win over the
  // snapshot; stored carry-ins without cost basis (parser-derived MtM
  // placeholders) defer to the snapshot — otherwise the placeholder's 0 PLN
  // basis would shadow the real numbers from the prior year.
  const inheritedCarryIns = await loadInheritedCarryIns({
    currentYear: session.year,
    storedCarryIns,
  });
  const inheritedKeys = new Set(inheritedCarryIns.map((c) => carryInKey(c)));
  const usefulStoredCarryIns = storedCarryIns.filter((c) => {
    if (c.costPerSharePln !== undefined) return true; // user-entered → keep
    // Placeholder (no cost basis): drop if a snapshot covers this key.
    return !inheritedKeys.has(carryInKey(c));
  });
  const carryInPositions: CarryInPosition[] = [
    ...inheritedCarryIns,
    ...usefulStoredCarryIns,
  ];

  // 3. Build symbol → country map
  const overrides = await db.symbolCountryOverrides
    .where('sessionId')
    .equals(args.sessionId)
    .toArray();

  const symbolCountryMap = new Map<string, string>();

  // Start with ISIN-based detection from trades
  for (const trade of trades) {
    if (trade.isin && !symbolCountryMap.has(trade.symbol)) {
      symbolCountryMap.set(trade.symbol, isinToCountry({ isin: trade.isin }));
    }
  }

  // Add from dividends (in case a symbol only has dividends)
  for (const div of dividends) {
    if (div.isin && !symbolCountryMap.has(div.symbol)) {
      symbolCountryMap.set(div.symbol, isinToCountry({ isin: div.isin }));
    }
  }

  // Apply manual overrides (highest priority)
  for (const override of overrides) {
    symbolCountryMap.set(override.symbol, override.country);
  }

  // 4. Prefetch and cache NBP rates
  await fetchRatesForSession({ sessionId: args.sessionId });

  // 5. Enrich trades with fixing rates
  const enrichedTrades: EnrichedTrade[] = await Promise.all(
    trades.map(async (trade) => {
      const dateStr = toDateString(trade.datetime);
      let exchangeRate = 0;
      let commissionExchangeRate = 0;
      let rateUnavailable = false;

      try {
        const rate = await getFixingRate({
          currency: trade.currency,
          date: dateStr,
        });
        exchangeRate = rate.rate;
      } catch {
        rateUnavailable = true;
      }

      try {
        const comRate = await getFixingRate({
          currency: trade.commissionCurrency,
          date: dateStr,
        });
        commissionExchangeRate = comRate.rate;
      } catch {
        rateUnavailable = true;
      }

      return {
        ...trade,
        exchangeRate,
        commissionExchangeRate,
        rateUnavailable,
      };
    }),
  );

  // 6. Enrich dividends with fixing rates
  const enrichedDividends: EnrichedRawDividend[] = await Promise.all(
    dividends.map(async (div) => {
      const dateStr = toDateString(div.date);
      let exchangeRate = 0;
      let rateUnavailable = false;

      try {
        const rate = await getFixingRate({
          currency: div.currency,
          date: dateStr,
        });
        exchangeRate = rate.rate;
      } catch {
        rateUnavailable = true;
      }

      return { ...div, exchangeRate, rateUnavailable };
    }),
  );

  // 7. Enrich credit interest with fixing rates
  const enrichedCreditInterests: (EnrichedCreditInterest & {
    fxDate: string;
  })[] = await Promise.all(
    creditInterests.map(async (interest) => {
      const dateStr = toDateString(interest.date);
      let exchangeRate = 0;
      let fxDate = '';
      let rateUnavailable = false;

      try {
        const rate = await getFixingRate({
          currency: interest.currency,
          date: dateStr,
        });
        exchangeRate = rate.rate;
        fxDate = rate.date;
      } catch {
        rateUnavailable = true;
      }

      return { ...interest, exchangeRate, fxDate, rateUnavailable };
    }),
  );

  // 8. Enrich withholding taxes with fixing rates
  const enrichedWithholding: EnrichedWithholdingTax[] = await Promise.all(
    withholdingTaxes.map(async (tax) => {
      const dateStr = toDateString(tax.date);
      let exchangeRate = 0;
      let rateUnavailable = false;

      try {
        const rate = await getFixingRate({
          currency: tax.currency,
          date: dateStr,
        });
        exchangeRate = rate.rate;
      } catch {
        rateUnavailable = true;
      }

      return { ...tax, exchangeRate, rateUnavailable };
    }),
  );

  // 9. Enrich corporate actions with fixing rates for cash component
  const enrichedCorporateActions: EnrichedCorporateAction[] = await Promise.all(
    corporateActions.map(async (ca) => {
      let cashExchangeRate = 0;
      let cashRateUnavailable = false;

      if (ca.cashPerShare && ca.cashPerShare > 0 && ca.cashCurrency) {
        const dateStr = toDateString(ca.datetime);
        try {
          const rate = await getFixingRate({
            currency: ca.cashCurrency,
            date: dateStr,
          });
          cashExchangeRate = rate.rate;
        } catch {
          cashRateUnavailable = true;
        }
      }

      return { ...ca, cashExchangeRate, cashRateUnavailable };
    }),
  );

  // 10. Build tax period
  const taxPeriod: TaxPeriod = {
    year: session.year,
    from: new Date(session.year, 0, 1),
    to: new Date(session.year, 11, 31),
  };

  // Load prior-year losses (art. 9 ust. 3 updof). Each entry tracks its
  // own residual via `alreadyDeductedPln`.
  const priorLosses = await db.priorLosses
    .where('sessionId')
    .equals(args.sessionId)
    .toArray();

  // 11. Calculate taxes
  const result = calculateTaxes({
    trades: enrichedTrades,
    dividends: enrichedDividends,
    creditInterests: enrichedCreditInterests,
    withholdingTaxes: enrichedWithholding,
    corporateActions: enrichedCorporateActions,
    carryInPositions,
    priorLosses: priorLosses.map((p) => ({
      year: p.year,
      totalLossPln: p.totalLossPln,
      alreadyDeductedPln: p.alreadyDeductedPln,
    })),
    taxPeriod,
    symbolCountryMap,
    includeAllInPitZg: session.includeAllInPitZg ?? false,
  });

  // 12. Persist results
  await db.transaction(
    'rw',
    [
      db.tradeResults,
      db.dividendResults,
      db.creditInterestResults,
      db.taxSummaries,
      db.sessions,
    ],
    async () => {
      // Clear previous results
      await Promise.all([
        db.tradeResults.where('sessionId').equals(args.sessionId).delete(),
        db.dividendResults.where('sessionId').equals(args.sessionId).delete(),
        db.creditInterestResults
          .where('sessionId')
          .equals(args.sessionId)
          .delete(),
        db.taxSummaries.delete(args.sessionId),
      ]);

      // Store new results
      await db.tradeResults.bulkAdd(
        result.trades.map((t) => ({ ...t, sessionId: args.sessionId })),
      );
      await db.dividendResults.bulkAdd(
        result.dividends.map((d) => ({ ...d, sessionId: args.sessionId })),
      );
      await db.creditInterestResults.bulkAdd(
        result.creditInterests.map((row) => ({
          ...row,
          sessionId: args.sessionId,
        })),
      );
      await db.taxSummaries.put({
        sessionId: args.sessionId,
        ...result.summary,
        pit38: result.pit38,
        pitZg: result.pitZg,
        lossDeduction: result.lossDeduction,
        openLots: result.openLots,
      });

      // 13. Update session status
      await updateSession({
        id: args.sessionId,
        changes: {
          status: 'calculated',
          calculatedAt: new Date(),
        },
      });
    },
  );

  // 14. Mark next-year session(s) stale — their inherited carry-ins changed.
  await markNextYearSessionsStale({
    currentYear: session.year,
  });

  return result;
}

/**
 * When a session's calculation finishes, bump dataUpdatedAt on any session
 * whose year is the next one — its inherited carry-ins (read from this
 * session's openLots) may have changed, so the stale banner should fire.
 */
async function markNextYearSessionsStale(args: {
  currentYear: number;
}): Promise<void> {
  const nextSessions = await db.sessions
    .where('year')
    .equals(args.currentYear + 1)
    .toArray();
  const now = new Date();
  await Promise.all(
    nextSessions.map((s) =>
      updateSession({ id: s.id, changes: { dataUpdatedAt: now } }),
    ),
  );
}

/**
 * Load carry-ins inherited from the prior-year session's openLots snapshot.
 *
 * Picks the most recently updated session whose `year = currentYear - 1`. If
 * that session hasn't been calculated yet, calculates it transparently first
 * (recursively — so a chain of years all get computed in one user action).
 * Reads its `taxSummaries.openLots` and converts each into a CarryInPosition
 * with full PLN cost basis. Stored carry-ins with cost basis (user-entered)
 * shadow inherited lots for the same key; stored carry-ins without cost
 * basis (parser MtM placeholders) defer to the snapshot.
 */
async function loadInheritedCarryIns(args: {
  currentYear: number;
  storedCarryIns: CarryInPosition[];
}): Promise<CarryInPosition[]> {
  const priorSessions = await db.sessions
    .where('year')
    .equals(args.currentYear - 1)
    .toArray();

  if (priorSessions.length === 0) return [];

  // Prefer most recently calculated; fall back to most recently updated.
  priorSessions.sort(
    (a, b) =>
      (b.calculatedAt?.getTime() ?? b.updatedAt.getTime()) -
      (a.calculatedAt?.getTime() ?? a.updatedAt.getTime()),
  );
  const priorSession = priorSessions[0];

  // If the prior session has no snapshot yet, calculate it now so we can
  // inherit. Year strictly decreases, so recursion terminates.
  let summary = await db.taxSummaries.get(priorSession.id);
  if (!summary?.openLots) {
    await calculateSessionTaxes({ sessionId: priorSession.id });
    summary = await db.taxSummaries.get(priorSession.id);
  }

  if (!summary?.openLots || summary.openLots.length === 0) return [];

  // Only stored carry-ins with explicit cost basis suppress the snapshot.
  const overrideKeys = new Set(
    args.storedCarryIns
      .filter((c) => c.costPerSharePln !== undefined)
      .map((c) => carryInKey(c)),
  );

  const inherited: CarryInPosition[] = [];
  for (const lot of summary.openLots) {
    const key = carryInKey(lot);
    if (overrideKeys.has(key)) continue;
    inherited.push({
      symbol: lot.symbol,
      isin: lot.isin,
      lotId: lot.lotId,
      quantity: lot.quantity,
      costPerSharePln: lot.costPerSharePln,
      commissionPerSharePln: lot.commissionPerSharePln,
      acquisitionDate: lot.acquisitionDate,
      year: args.currentYear - 1,
    });
  }
  return inherited;
}

function carryInKey(args: {
  symbol: string;
  isin?: string;
  lotId?: string;
}): string {
  const base = (args.isin ?? args.symbol).toUpperCase();
  return args.lotId ? `${base}::${args.lotId}` : base;
}

/** Clear calculated results for a session (keep parsed data) */
export async function clearSessionResults(args: {
  sessionId: string;
}): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.tradeResults,
      db.dividendResults,
      db.creditInterestResults,
      db.taxSummaries,
      db.sessions,
    ],
    async () => {
      await Promise.all([
        db.tradeResults.where('sessionId').equals(args.sessionId).delete(),
        db.dividendResults.where('sessionId').equals(args.sessionId).delete(),
        db.creditInterestResults
          .where('sessionId')
          .equals(args.sessionId)
          .delete(),
        db.taxSummaries.delete(args.sessionId),
      ]);
      await updateSession({
        id: args.sessionId,
        changes: {
          status: 'draft',
          calculatedAt: undefined,
        },
      });
    },
  );
}
