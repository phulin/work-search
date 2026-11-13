import { tokenize } from "./tokenize.js";
export class QuerySyntaxError extends Error {}
export type Node =
  | { kind: "empty" }
  | { kind: "all" }
  | { kind: "term"; term: string }
  | { kind: "phrase"; terms: string[] }
  | { kind: "not"; child: Node }
  | { kind: "and" | "or" | "except"; left: Node; right: Node }
  | {
      kind: "near";
      left: Node;
      right: Node;
      distance: number;
      ordered: boolean;
    };
type Token =
  | { kind: "atom"; node: Node }
  | { kind: "open" | "close" | "not" }
  | {
      kind: "op";
      op: "and" | "or" | "except" | "near";
      priority: number;
      distance?: number;
      ordered?: boolean;
    };
export function parse(q: string, mode: "and" | "or" = "and"): Node {
  if (!["and", "or"].includes(mode))
    throw new QuerySyntaxError("Unknown implicit search mode");
  q = q.replace(/[“”]/g, '"');
  if (q.length > 2048) throw new QuerySyntaxError("Query too long");
  const tokens: Token[] = [];
  let i = 0;
  const op = (name: "and" | "or" | "except") =>
    tokens.push({
      kind: "op",
      op: name,
      priority: name === "or" ? 2000 : name === "and" ? 200 : 100,
    });
  while (i < q.length) {
    const c = q[i];
    if (/\s/u.test(c)) {
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      tokens.push({ kind: c === "(" ? "open" : "close" });
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      let text = "",
        closed = false;
      while (i < q.length) {
        const x = q[i++];
        if (x === '"') {
          closed = true;
          break;
        }
        if (x === "\\") {
          if (i >= q.length || !['"', "\\"].includes(q[i]))
            throw new QuerySyntaxError("Invalid quote escape");
          text += q[i++];
        } else text += x;
      }
      if (!closed) throw new QuerySyntaxError("Unclosed quote");
      const terms = tokenize(text);
      if (!terms.length) throw new QuerySyntaxError("Empty phrase");
      if (terms.length > 256)
        throw new QuerySyntaxError("Phrase exceeds 256 tokens");
      tokens.push({
        kind: "atom",
        node:
          terms.length === 1
            ? { kind: "term", term: terms[0] }
            : { kind: "phrase", terms },
      });
      continue;
    }
    const proximity = q
      .slice(i)
      .match(
        /^(?:\/(\d+|s|p)|w\/(\d+|s|p)|(?:pre\/|\+)(\d+|s|p))(?=$|\s|[()"])/i,
      );
    if (proximity) {
      const raw = (proximity[1] ?? proximity[2] ?? proximity[3]).toLowerCase(),
        distance = raw === "s" ? 25 : raw === "p" ? 75 : Number(raw);
      if (!Number.isInteger(distance) || distance < 1 || distance > 255)
        throw new QuerySyntaxError("Proximity distance must be 1–255");
      tokens.push({
        kind: "op",
        op: "near",
        distance,
        ordered: !!proximity[3],
        priority: raw === "s" ? 500 : raw === "p" ? 400 : 1000 - distance,
      });
      i += proximity[0].length;
      continue;
    }
    if (c === "&" || c === "%") {
      op(c === "&" ? "and" : "except");
      i++;
      continue;
    }
    if ("/+!*?:#[]{}".includes(c))
      throw new QuerySyntaxError(
        "Unsupported query syntax near " + q.slice(i, i + 12),
      );
    const word = q.slice(i).match(/^[^\s()"/&%+!*?:#\[\]{}]+/u)?.[0];
    if (!word) throw new QuerySyntaxError("Unexpected character");
    i += word.length;
    const upper = word.toUpperCase();
    if (q[i] === "(" && !["AND", "OR", "NOT", "BUT"].includes(upper))
      throw new QuerySyntaxError("Inline fields and functions are unsupported");
    if (upper === "AND" || upper === "OR") {
      op(upper.toLowerCase() as "and" | "or");
      continue;
    }
    if (upper === "BUT") {
      if (!/^\s+NOT\b/i.test(q.slice(i)))
        throw new QuerySyntaxError("BUT requires NOT");
      i += q.slice(i).match(/^\s+NOT\b/i)![0].length;
      op("except");
      continue;
    }
    if (upper === "NOT") {
      tokens.push({ kind: "not" });
      continue;
    }
    const words = tokenize(word);
    if (!words.length) throw new QuerySyntaxError("Expected searchable term");
    for (const term of words)
      tokens.push({ kind: "atom", node: { kind: "term", term } });
  }
  // AND NOT is a single, lowest-priority exclusion connector.
  for (let j = 0; j < tokens.length - 1; j++)
    if (
      tokens[j].kind === "op" &&
      (tokens[j] as any).op === "and" &&
      tokens[j + 1].kind === "not"
    ) {
      tokens.splice(j, 2, { kind: "op", op: "except", priority: 100 });
    }
  if (tokens.length > 256)
    throw new QuerySyntaxError("Query expression too complex");
  let cursor = 0;
  const atom = (depth: number): Node => {
    if (depth > 32) throw new QuerySyntaxError("Query nesting exceeds 32");
    const t = tokens[cursor++];
    if (!t) throw new QuerySyntaxError("Missing operand");
    if (t.kind === "atom") return t.node;
    if (t.kind === "not") return { kind: "not", child: atom(depth + 1) };
    if (t.kind === "open") {
      const n = expression(0, depth + 1);
      if (tokens[cursor++]?.kind !== "close")
        throw new QuerySyntaxError("Unclosed parenthesis");
      return n;
    }
    throw new QuerySyntaxError("Expected term, phrase or group");
  };
  const expression = (minimum: number, depth: number): Node => {
    let left = atom(depth);
    while (cursor < tokens.length) {
      const t = tokens[cursor];
      if (t.kind === "close") break;
      const implicit = t.kind !== "op";
      const operator: Extract<Token, { kind: "op" }> = implicit
        ? { kind: "op", op: mode, priority: mode === "and" ? 200 : 2000 }
        : t;
      if (operator.priority < minimum) break;
      if (!implicit) cursor++;
      const right = expression(operator.priority + 1, depth + 1);
      left =
        operator.op === "near"
          ? {
              kind: "near",
              left,
              right,
              distance: operator.distance!,
              ordered: operator.ordered!,
            }
          : { kind: operator.op, left, right };
    }
    return left;
  };
  if (!tokens.length) return { kind: "empty" };
  const ast = expression(0, 0);
  if (cursor !== tokens.length)
    throw new QuerySyntaxError("Unexpected closing parenthesis");
  if (queryTerms(ast).length > 16)
    throw new QuerySyntaxError("At most 16 distinct query terms");
  return ast;
}
export function queryTerms(ast: Node, positiveOnly = false): string[] {
  const terms = new Set<string>();
  function visit(n: Node, positive: boolean) {
    if (n.kind === "term") {
      if (positive || !positiveOnly) terms.add(n.term);
    } else if (n.kind === "phrase") {
      if (positive || !positiveOnly) for (const t of n.terms) terms.add(t);
    } else if (n.kind === "not") visit(n.child, !positive);
    else if ("left" in n) {
      visit(n.left, positive);
      visit(n.right, n.kind === "except" ? !positive : positive);
    }
  }
  visit(ast, true);
  return [...terms];
}
export function positional(n: Node): boolean {
  return (
    n.kind === "near" ||
    n.kind === "phrase" ||
    (n.kind === "not"
      ? positional(n.child)
      : "left" in n && (positional(n.left) || positional(n.right)))
  );
}
export function simplify(n: Node, exists: (term: string) => boolean): Node {
  if (n.kind === "term") return exists(n.term) ? n : { kind: "empty" };
  if (n.kind === "phrase") return n.terms.every(exists) ? n : { kind: "empty" };
  if (n.kind === "not") {
    const child = simplify(n.child, exists);
    return child.kind === "empty"
      ? { kind: "all" }
      : child.kind === "all"
        ? { kind: "empty" }
        : { kind: "not", child };
  }
  if (!("left" in n)) return n;
  const left = simplify(n.left, exists),
    right = simplify(n.right, exists);
  if (n.kind === "or") {
    if (left.kind === "empty") return right;
    if (right.kind === "empty") return left;
  } else if (
    left.kind === "empty" ||
    (n.kind !== "except" && right.kind === "empty")
  )
    return { kind: "empty" };
  if (n.kind === "except" && right.kind === "empty") return left;
  return { ...n, left, right };
}

export function needsUniverse(n: Node): boolean {
  return (
    n.kind === "not" ||
    n.kind === "all" ||
    ("left" in n && (needsUniverse(n.left) || needsUniverse(n.right)))
  );
}

/** Only terms whose occurrence locations are actually used by the expression. */
export function positionalTerms(
  ast: Node,
  knownPhrase?: (words: string[]) => boolean,
): Set<string> {
  const terms = new Set<string>();
  function visit(n: Node, spans = false) {
    if (n.kind === "term") {
      if (spans) terms.add(n.term);
    } else if (n.kind === "phrase") {
      if (!knownPhrase?.(n.terms)) for (const t of n.terms) terms.add(t);
    } else if (n.kind === "near") {
      visit(n.left, true);
      visit(n.right, true);
    } else if (n.kind === "not") visit(n.child, false);
    else if (n.kind === "except") {
      visit(n.left, spans);
      visit(n.right, false);
    } else if ("left" in n) {
      visit(n.left, spans);
      visit(n.right, spans);
    }
  }
  visit(ast);
  return terms;
}
