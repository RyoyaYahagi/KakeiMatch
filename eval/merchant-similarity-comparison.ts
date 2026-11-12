import { reconciliationMerchantSimilarity as dice } from "../src/lib/reconciliation-engine";
import { MerchantNgramTfidf, merchantJaroWinkler } from "../src/lib/merchant-similarity";

type Example = { family: string; query: string; truth: string; decoys: [string, string] };

const bases = [
  ["青空食堂", "青空カフェ", "青空書店"], ["北口ベーカリー", "北口食堂", "北口薬局"],
  ["みどりスーパー", "みどり薬局", "みどり食堂"], ["港町文具", "港町食堂", "港町書店"],
  ["丘の上カフェ", "丘の上薬局", "丘の上食堂"], ["つばさ書店", "つばさ食堂", "つばさ薬局"],
  ["湖畔ベーカリー", "湖畔食堂", "湖畔薬局"], ["星空映画館", "星空書店", "星空食堂"],
  ["南町クリニック", "南町薬局", "南町食堂"], ["駅前八百屋", "駅前食堂", "駅前書店"],
  ["山川電器", "山川薬局", "山川食堂"], ["つきのわ菓子店", "つきのわ食堂", "つきのわ書店"],
];

const examples: Example[] = [];
for (const [truth, decoyA, decoyB] of bases) {
  examples.push({ family: "statement-prefix", query: `VISA国内利用${truth}`, truth: truth!, decoys: [decoyA!, decoyB!] });
  examples.push({ family: "numeric-code", query: `${truth} 1234`, truth: truth!, decoys: [decoyA!, decoyB!] });
  const kanaToLatin: Record<string, string> = { 青空: "AOZORA", 北口: "KITAGUCHI", みどり: "MIDORI", 港町: "MINATOMACHI", 丘の上: "OKANOUe", つばさ: "TSUBASA", 湖畔: "KOHAN", 星空: "HOSHIZORA", 南町: "MINAMIMACHI", 駅前: "EKIMAE", 山川: "YAMAKAWA", つきのわ: "TSUKINOWA" };
  const prefix = Object.keys(kanaToLatin).find((item) => truth!.startsWith(item))!;
  examples.push({ family: "kana-latin", query: `${kanaToLatin[prefix]}${truth!.slice(prefix.length)}`, truth: truth!, decoys: [decoyA!, decoyB!] });
}

const model = new MerchantNgramTfidf(examples.flatMap((row) => [row.query, row.truth, ...row.decoys]), 2);
const metrics = {
  "Dice": (a: string, b: string) => dice(a, b),
  "Jaro-Winkler": (a: string, b: string) => merchantJaroWinkler(a, b),
  "TF-IDF cosine": (a: string, b: string) => model.similarity(a, b),
  "Dice + Jaro-Winkler": (a: string, b: string) => (dice(a, b) + merchantJaroWinkler(a, b)) / 2,
  "Dice + TF-IDF": (a: string, b: string) => (dice(a, b) + model.similarity(a, b)) / 2,
  "3-way mean": (a: string, b: string) => (dice(a, b) + merchantJaroWinkler(a, b) + model.similarity(a, b)) / 3,
} as const;

const report: Record<string, unknown> = { dataset: "synthetic merchant variants v1", caseCount: examples.length, candidateCountPerCase: 3, metrics: {} };
const byMetric = report.metrics as Record<string, unknown>;
for (const [name, score] of Object.entries(metrics)) {
  const families: Record<string, { top1Credit: number; reciprocalRank: number }> = {};
  let top1 = 0;
  let reciprocalRank = 0;
  let scoreMargin = 0;
  for (const row of examples) {
    const scores = [row.truth, ...row.decoys].map((candidate) => ({ candidate, score: score(row.query, candidate) }));
    const truthScore = scores[0]!.score;
    const bestDecoy = Math.max(scores[1]!.score, scores[2]!.score);
    const bestScore = Math.max(...scores.map((item) => item.score));
    const tieCount = scores.filter((item) => item.score === bestScore).length;
    const truthWinsTie = truthScore === bestScore;
    const credit = truthWinsTie ? 1 / tieCount : 0;
    const rank = truthWinsTie ? (tieCount + 1) / 2 : 1 + scores.filter((item) => item.score > truthScore).length;
    const bucket = families[row.family] ??= { top1Credit: 0, reciprocalRank: 0 };
    top1 += credit;
    bucket.top1Credit += credit;
    reciprocalRank += 1 / rank;
    bucket.reciprocalRank += 1 / rank;
    scoreMargin += truthScore - bestDecoy;
  }
  for (const value of Object.values(families)) {
    value.top1Credit /= 12;
    value.reciprocalRank /= 12;
  }
  byMetric[name] = { tieAdjustedTop1: `${top1.toFixed(1)}/${examples.length}`, tieAdjustedTop1Rate: top1 / examples.length, meanReciprocalRank: reciprocalRank / examples.length, meanTrueMinusBestDecoy: scoreMargin / examples.length, families };
}
console.log(JSON.stringify(report, null, 2));
