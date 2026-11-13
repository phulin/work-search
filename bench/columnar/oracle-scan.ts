import { tokenize } from "../../src/query/tokenize.js";
import { parse, queryTerms, type Node } from "../../src/query/parser.js";
import { exhaustive } from "./exhaustive.js";

export interface OracleContract {
  q: string;
  kind: string;
  page?: number;
  options?: {
    mode?: "and" | "or";
    field?: "all" | "body" | "title";
    titleBoost?: number;
    limit?: number;
  };
}
export interface OracleStatistics {
  count: number;
  avgBody: number;
  avgTitle: number;
  names: string[];
  df: number[];
}
interface Ranked {
  doc: number;
  id: string;
  score: number;
  title?: string;
  metadata?: unknown;
}
// This is a source-token oracle. It deliberately imports no serving format,
// score decoder, candidate planner, heap or production positional matcher.
function mandatory(n: Node): Set<string> {
  if (n.kind === "term") return new Set([n.term]);
  if (n.kind === "phrase") return new Set(n.terms);
  if (!("left" in n)) return new Set();
  const a = mandatory(n.left),
    b = mandatory(n.right);
  if (n.kind === "or") return new Set([...a].filter((word) => b.has(word)));
  if (n.kind === "except") return a;
  return new Set([...a, ...b]);
}
export class OracleScan {
  readonly indexes: Map<string, number>;
  readonly idf: Float64Array;
  readonly observed: Float64Array;
  readonly bodyFrequency: Uint32Array;
  readonly titleFrequency: Uint32Array;
  readonly bodyScore: Float64Array;
  readonly titleScore: Float64Array;
  readonly plans;
  bodySum = 0;
  titleSum = 0;
  documents = 0;
  constructor(
    readonly statistics: OracleStatistics,
    contracts: OracleContract[],
  ) {
    const { names, df, count } = statistics;
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      names.length !== df.length ||
      new Set(names).size !== names.length ||
      df.some((n) => !Number.isInteger(n) || n < 0 || n > count) ||
      !Number.isFinite(statistics.avgBody) ||
      statistics.avgBody < 0 ||
      !Number.isFinite(statistics.avgTitle) ||
      statistics.avgTitle < 0
    )
      throw Error("Invalid oracle corpus statistics");
    this.indexes = new Map(names.map((name, i) => [name, i]));
    this.idf = Float64Array.from(df, (n) =>
      Math.log(1 + (count - n + 0.5) / (n + 0.5)),
    );
    this.observed = new Float64Array(names.length);
    this.bodyFrequency = new Uint32Array(names.length);
    this.titleFrequency = new Uint32Array(names.length);
    this.bodyScore = new Float64Array(names.length);
    this.titleScore = new Float64Array(names.length);
    const index = (word: string) => {
      const i = this.indexes.get(word);
      if (i === undefined) throw Error("Missing oracle query term " + word);
      return i;
    };
    this.plans = contracts.map((contract) => {
      const ast = parse(contract.q, contract.options?.mode),
        k = (contract.options?.limit ?? 20) * ((contract.page ?? 0) + 1);
      if (!Number.isInteger(k) || k < 1 || k > 1000)
        throw Error("Invalid oracle result limit");
      return {
        contract,
        ast,
        k,
        scoring: queryTerms(ast, true).map(index),
        required: [...mandatory(ast)].map(index),
        ranked: [] as Ranked[],
      };
    });
  }
  add(d: {
    doc: number;
    id: string;
    body: string;
    title?: string;
    metadata?: unknown;
  }) {
    const body = tokenize(d.body),
      title = tokenize(d.title ?? ""),
      bf = this.bodyFrequency,
      tf = this.titleFrequency,
      b = this.bodyScore,
      t = this.titleScore;
    this.documents++;
    this.bodySum += body.length;
    this.titleSum += title.length;
    bf.fill(0);
    tf.fill(0);
    b.fill(0);
    t.fill(0);
    for (const word of body) {
      const i = this.indexes.get(word);
      if (i !== undefined) bf[i]++;
    }
    for (const word of title) {
      const i = this.indexes.get(word);
      if (i !== undefined) tf[i]++;
    }
    for (let i = 0; i < bf.length; i++) {
      if (bf[i] || tf[i]) this.observed[i]++;
      if (bf[i])
        b[i] =
          (this.idf[i] * (bf[i] * 2.2)) /
          (bf[i] +
            1.2 *
              (0.25 + (0.75 * body.length) / (this.statistics.avgBody || 1)));
      if (tf[i])
        t[i] =
          (this.idf[i] * (tf[i] * 2.2)) /
          (tf[i] +
            1.2 *
              (0.25 + (0.75 * title.length) / (this.statistics.avgTitle || 1)));
    }
    for (const p of this.plans) {
      const field = p.contract.options?.field ?? "all",
        boost = p.contract.options?.titleBoost ?? 2;
      if (
        p.required.some((i) =>
          field === "body"
            ? !bf[i]
            : field === "title"
              ? !tf[i]
              : !bf[i] && !tf[i],
        )
      )
        continue;
      let score = 0;
      for (const i of p.scoring)
        score +=
          (field !== "title" ? b[i] : 0) +
          (field !== "body" ? boost * t[i] : 0);
      const last = p.ranked.at(-1);
      // Exact per-document score is known before expensive exhaustive span
      // evaluation. This can reject only a document that cannot enter top K.
      if (
        p.ranked.length === p.k &&
        last &&
        (score < last.score || (score === last.score && d.doc > last.doc))
      )
        continue;
      if (
        !exhaustive(
          p.ast,
          field === "all" ? [body, title] : field === "body" ? [body] : [title],
        )
      )
        continue;
      p.ranked.push({
        doc: d.doc,
        id: d.id,
        score,
        title: d.title,
        metadata: d.metadata,
      });
      p.ranked.sort((a, b) => b.score - a.score || a.doc - b.doc);
      if (p.ranked.length > p.k) p.ranked.pop();
    }
  }
  result() {
    return {
      count: this.documents,
      bodySum: this.bodySum,
      titleSum: this.titleSum,
      names: this.statistics.names,
      observedDf: [...this.observed],
      expectedDf: this.statistics.df,
      plans: this.plans.map((p) => ({ ...p.contract, ranked: p.ranked })),
    };
  }
}
