import { normalizeReconciliationMerchant } from "./reconciliation-engine";

function characters(value: string): string[] {
  return Array.from(value);
}

/** Deterministic Jaro-Winkler similarity over normalized merchant text. */
export function merchantJaroWinkler(left: string, right: string): number {
  const a = characters(normalizeReconciliationMerchant(left));
  const b = characters(normalizeReconciliationMerchant(right));
  if (a.length === 0 || b.length === 0) return 0;
  if (a.join("") === b.join("")) return 1;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = Array<boolean>(a.length).fill(false);
  const bMatches = Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = Math.max(0, i - range); j <= Math.min(i + range, b.length - 1); j += 1) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  for (let i = 0, j = 0; i < a.length; i += 1) {
    if (!aMatches[i]) continue;
    while (!bMatches[j]) j += 1;
    if (a[i] !== b[j]) transpositions += 1;
    j += 1;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

function ngrams(value: string, size: number): Map<string, number> {
  const chars = characters(normalizeReconciliationMerchant(value));
  const counts = new Map<string, number>();
  for (let i = 0; i + size <= chars.length; i += 1) {
    const gram = chars.slice(i, i + size).join("");
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/** Corpus-fitted character n-gram TF-IDF cosine, with smoothed IDF. */
export class MerchantNgramTfidf {
  private readonly documentCount: number;
  private readonly documentFrequency: Map<string, number>;

  constructor(corpus: readonly string[], private readonly n = 2) {
    if (!Number.isInteger(n) || n < 1) throw new Error("n must be a positive integer");
    this.documentCount = corpus.length;
    this.documentFrequency = new Map();
    for (const text of corpus) {
      for (const gram of ngrams(text, n).keys()) {
        this.documentFrequency.set(gram, (this.documentFrequency.get(gram) ?? 0) + 1);
      }
    }
  }

  similarity(left: string, right: string): number {
    const a = this.vector(left);
    const b = this.vector(right);
    let dot = 0;
    for (const [gram, weight] of a) dot += weight * (b.get(gram) ?? 0);
    const normA = Math.sqrt([...a.values()].reduce((sum, value) => sum + value * value, 0));
    const normB = Math.sqrt([...b.values()].reduce((sum, value) => sum + value * value, 0));
    return normA === 0 || normB === 0 ? 0 : dot / (normA * normB);
  }

  private vector(text: string): Map<string, number> {
    const vector = new Map<string, number>();
    for (const [gram, termFrequency] of ngrams(text, this.n)) {
      const frequency = this.documentFrequency.get(gram) ?? 0;
      const idf = Math.log((this.documentCount + 1) / (frequency + 1)) + 1;
      vector.set(gram, termFrequency * idf);
    }
    return vector;
  }
}
