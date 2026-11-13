import { stem } from "stemr";
import { tokenize } from "./tokenize.js";

/** Part of the immutable index contract, shared by ingestion and queries. */
export const ENGLISH_ANALYSIS = "nfkc-lower-porter2-v1" as const;
export type Analysis = typeof ENGLISH_ANALYSIS | undefined;

export function normalizeTerm(word: string, analysis: Analysis) {
  if (analysis === undefined) return word;
  if (analysis !== ENGLISH_ANALYSIS) throw Error("Unknown index analysis");
  return stem(word);
}

export function analyze(text: string, analysis: Analysis = ENGLISH_ANALYSIS) {
  return tokenize(text).map((word) => normalizeTerm(word, analysis));
}

export function tokenizerFor(analysis: Analysis) {
  if (analysis === undefined) return tokenize;
  if (analysis !== ENGLISH_ANALYSIS) throw Error("Unknown index analysis");
  return (text: string) => analyze(text, analysis);
}
