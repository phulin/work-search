# Terms-and-connectors query language

This is a documented **Lexis-style subset**, not an exact clone of every Lexis product or its automatic linguistic expansions. Matching is deterministic over the engine's NFKC-normalized, lowercased Unicode letter/number tokens. Stop words are retained and counted in distances.

## Supported expressions

| Syntax                                            | Meaning                                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `red AND fox`, `red & fox`                        | Both conditions must match the document                                                                  |
| `red OR fox`                                      | Either condition may match                                                                               |
| `red AND NOT fox`, `red BUT NOT fox`, `red % fox` | Left condition matches and right condition does not                                                      |
| `NOT fox`                                         | Document-level complement; documents matching only negative conditions score zero                        |
| `(red OR blue) AND fox`                           | Parentheses override connector priority                                                                  |
| `"red fox"`                                       | Exact adjacent token sequence in order, within one field                                                 |
| `red /5 fox`, `red w/5 fox`                       | Non-overlapping occurrences whose nearest endpoints are at most five token positions apart, either order |
| `red /s fox`, `red w/s fox`                       | Distance 25; no sentence-boundary detection                                                              |
| `red /p fox`, `red w/p fox`                       | Distance 75; no paragraph-boundary detection                                                             |
| `red +5 fox`, `red pre/5 fox`                     | Ordered proximity: the left occurrence precedes the right within distance five                           |

Adjacent tokens have distance **1**: `red fox` matches `red /1 fox`, while `red x fox` requires `/2`. For phrases, distance is measured between the nearest phrase endpoints. Both operands must have distinct, non-overlapping occurrences; `red /1 red` requires two adjacent instances. A phrase can contain repeated terms. Punctuation does not create boundaries: `red. fox` matches `"red fox"`, and `/s` may cross actual sentence boundaries.

Title and body positions are independent. A phrase or proximity match never crosses from one field to the other. Boolean AND may match terms in different fields. The existing global `field=title` or `field=body` restriction applies to every clause, including exclusions.

Operators are case-insensitive. ASCII and curly double quotes are accepted for phrases. Quote a reserved word to search it literally: `"AND"`. Inside quoted text, `\"` and `\\` are valid escapes; the resulting text still uses normal tokenization. Use spaces around word/proximity connectors. Empty, unmatched, malformed, and unsupported syntax returns HTTP **400**, never a silently altered query.

## Connector priority

From strongest to weakest:

1. Prefix `NOT` (extension), quoted phrases and parenthesized groups.
2. `OR`.
3. Numeric proximity (`/n`, `w/n`, `+n`, `pre/n`), smallest n first.
4. `/s` and its ordered/alternative spellings.
5. `/p` and its ordered/alternative spellings.
6. `AND`, `&` and implicit AND.
7. `AND NOT`, `BUT NOT`, `%`.

Identical priority is left-associative. Thus `a AND b OR c` means `a AND (b OR c)`, and `a /10 b /2 c` means `a /10 (b /2 c)`. `/s` and `/p` are aliases for **matching distance**, while retaining their grammatical-connector precedence; `/s` and `/25` can therefore group differently in a mixed unparenthesized expression. Parenthesize to make the intended grouping explicit.

Unquoted adjacent text retains this engine's existing default AND behavior: `search engine` means `search AND engine`. `mode=or` changes only the implicit connector; explicit operators always retain their documented priority. Unlike some Lexis interfaces, unquoted multiword text between connectors is not automatically treated as a phrase. Use quotes explicitly. There is no automatic detection of recognized legal phrases.

Grouped proximity supports OR alternatives, phrases, nested proximity, and conjunctions: `(red OR blue) /5 (fox OR dog)`, `"red fox" /5 dog`, `(red /3 fox) /5 dog`, `(red AND fox) /5 dog`. Conjunctions produce within-field covering spans; nested proximity uses the covering span of each successful child expression. `AND NOT` is a document-wide exclusion filter. A pure complement has no occurrence location and cannot by itself satisfy proximity. Negative clauses may filter an anchored group, for example `(red AND NOT blue) /5 fox`.

The basic order follows [Lexis connector priority](https://www.lexisnexis.com/documents/pdf/20110823020727_large.pdf); fixed distances follow [Lexis Advance's /25 and /75 definitions](https://www.lexisnexis.com/pdf/advance-your-research/search-commands-comparisons.pdf?P05=). Product-specific behavior beyond the rules above is not claimed.

## Ranking, I/O and limits

The AST determines the exact matching document set; BM25 then ranks matching documents using the distinct positively occurring query terms and the existing title boost. Negated-only terms do not add score. A double negation restores positive scoring. Scores are term-based, with no extra phrase/proximity bonus. Ties use internal input order. `total` remains exact. Pure complement-only matches have score zero.

The dictionary stays bundled. The planner prunes missing-term clauses before fetching postings: an impossible AND/phrase/proximity returns without R2 reads, while an OR can retain its other branches. Referenced surviving terms are fetched once each with concurrency four. Positions use the same local/remote decoder. ID-only queries still need no metadata reads, and fully embedded phrase/connector queries can make zero R2 requests. Metadata remains a separate opt-in step.

Plain Boolean queries do not allocate positional-offset arrays. Phrase/proximity queries allocate one u32 byte offset per posting, retain compressed position bytes, and decode positions only for one candidate document at a time into reusable per-term buffers. Boolean existence checks stop at the first valid phrase/proximity match, while nested compound expressions retain the locations their parents need. Scratch retains at most the observed per-term field-frequency peaks; conservative guard accounting includes buffer growth. No positions are expanded for the full corpus. Candidate sets are sorted; evaluation never stores a corpus-sized map of spans. Lengths keep their compressed block cache and reusable scoring result.

Safeguards: 2,048 query characters, 16 distinct terms, 256 lexer tokens, 256 tokens per phrase, 32 nesting levels, numeric distance 1–255, limit 1–100, at most 4,096 materialized compound spans per field/operand/document and 32,768 retained compound-span slots per query and ten million span comparisons/checks per query. Estimated encoded/decoded working sets are bounded by the lesser of 56 MiB and `104 MiB - bundle bytes`, with an additional per-document position-allocation check. Resource exhaustion returns **503**, not partial results or a false zero count. Common-term positional queries can be expensive, and the per-query guard cannot guarantee safety for many concurrent requests in one isolate. Large corpora/common phrases generally need Workers Paid CPU allowances.

## Examples

```sh
npm run build-index -- --input corpus.jsonl --out indexes/terms-v3 --budget-mib 8
npm run search-local -- --out indexes/terms-v3 \
  --query '(negligence OR malpractice) AND "standard of care"'
npm run search-local -- --out indexes/terms-v3 \
  --query '(contract OR agreement) /p breach AND NOT "criminal law"'
npm run dev -- --out indexes/terms-v3
curl --get 'http://localhost:8787/search' \
  --data-urlencode 'q=(red OR blue) /s "fox jumps"' \
  --data-urlencode 'limit=20'
```

Unsupported: stemming/automatic plurals, root expansion `!`, wildcards `*`/`?`, fuzzy search, inline field/segment functions, occurrence-count functions, metadata filters, and negative-proximity operators such as `NOT /n`. Quotes provide exact token sequences rather than exact character substrings. The parser rejects wildcard/field punctuation instead of pretending to execute it.

## Version migration

Container format **v3** adds positional payloads. Rebuild the entire index generation, upload its immutable objects, and deploy the v3 Worker with its matching bundle. v1/v2 bundles are rejected. Existing v2 indexes cannot recover discarded positions and cannot be upgraded solely by deploying new query code. The compressed document-table subformat remains DTC2; it does not need separate migration. Keep old Workers and generations together for rollback.
