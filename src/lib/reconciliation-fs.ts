/** Fixed feature bins and constants for the offline-fitted Fellegi–Sunter score. */

export const RECONCILIATION_FS_CATEGORIES = [
  "amount:exact", "amount:close", "amount:mid", "amount:edge",
  "date:same", "date:auto", "date:near", "date:edge",
  "merchant:alias", "merchant:exact", "merchant:high", "merchant:auto", "merchant:candidate", "merchant:low",
  "source:match", "source:mismatch", "source:unknown",
] as const;

export type ReconciliationFSCategory = typeof RECONCILIATION_FS_CATEGORIES[number];
export type ReconciliationFSWeights = Record<ReconciliationFSCategory, number>;

export type ReconciliationFSObservation = {
  amountDeltaYen: number;
  amountToleranceYen: number;
  dateDistanceDays: number;
  merchantSimilarity: number;
  samePaymentSource: boolean;
  paymentSourceKnown: boolean;
  aliasMatch: boolean;
  waiver: boolean;
};

export function reconciliationFSFeatures(input: ReconciliationFSObservation): ReconciliationFSCategory[] {
  const amountScore = input.amountDeltaYen === 0
    ? 1
    : Math.max(0, 1 - input.amountDeltaYen / input.amountToleranceYen);
  const amount: ReconciliationFSCategory = input.amountDeltaYen === 0
    ? "amount:exact"
    : amountScore >= 0.8 ? "amount:close" : amountScore >= 0.5 ? "amount:mid" : "amount:edge";
  const date: ReconciliationFSCategory = input.dateDistanceDays === 0
    ? "date:same"
    : input.dateDistanceDays <= 2 ? "date:auto"
      : input.dateDistanceDays <= 4 ? "date:near" : "date:edge";
  const merchant: ReconciliationFSCategory = input.aliasMatch
    ? "merchant:alias"
    : input.merchantSimilarity === 1 ? "merchant:exact"
      : input.merchantSimilarity >= 0.85 ? "merchant:high"
        : input.merchantSimilarity >= 0.72 ? "merchant:auto"
          : input.merchantSimilarity >= 0.70 ? "merchant:candidate" : "merchant:low";
  const source: ReconciliationFSCategory = !input.paymentSourceKnown
    ? "source:unknown" : input.samePaymentSource ? "source:match" : "source:mismatch";
  return input.waiver ? [amount, date, source] : [amount, date, merchant, source];
}

export function reconciliationFSScore(
  features: readonly ReconciliationFSCategory[],
  weights: ReconciliationFSWeights,
): number {
  return features.reduce((sum, category) => sum + weights[category], 0);
}

// Fitted by `pnpm eval:reconciliation-calibrate -- --write`; see the checked-in artifact.
export const RECONCILIATION_FS_WEIGHTS: ReconciliationFSWeights = {
  "amount:exact": -0.009888543929522566,
  "amount:close": 1.2186210334322527,
  "amount:mid": 1.1367141956443065,
  "amount:edge": -1.625141754638835,
  "date:same": 2.1604844371235155,
  "date:auto": -0.5311453091487714,
  "date:near": -2.8602712413931917,
  "date:edge": -2.2693663678735825,
  "merchant:alias": 0.8687724418107423,
  "merchant:exact": 2.4134281980713483,
  "merchant:high": 0.8687724418107421,
  "merchant:auto": -3.1444510186512784,
  "merchant:candidate": 0.2996779099207757,
  "merchant:low": -0.026365915058186154,
  "source:match": 4,
  "source:mismatch": 0.22104340987250465,
  "source:unknown": -1.2637993299595196,
};
