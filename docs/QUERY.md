# Terms-and-connectors query language

This is a documented **Lexis-style subset**, not an exact clone of every Lexis product or its automatic linguistic expansions. Matching is deterministic over Unicode letter/number tokens. The index generation selects analysis: NFKC normalization and lowercasing, with English Porter2 stemming for `nfkc-lower-porter2-v1`. Queries use the same analysis as ingestion. Stop words are retained and counted in distances.

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

## Ranking and execution

The AST determines the exact matching set. BM25 ranks matches using distinct
positive query terms, body/title frequencies, and the configured title boost.
Negated-only terms contribute no score; double negation restores positive
scoring. Phrases and proximity add no separate score bonus. Ties use internal
document order. Field restriction applies to matching and scoring.

The columnar planner simplifies impossible clauses, then chooses complete term
packets, anchor/document verification, or block retrieval. Conservative filters
never discard an unknown match. Positional conditions use exact spans; only
verified matches update the competitive threshold. Metadata filters apply before
top-K selection. See [architecture](ARCHITECTURE.md) for storage and execution.

`total=false` omits the count and permits exact top-K pruning. `total=true`
computes an exact count. Both retain exact ranking and tie order. Generation-bound
search-after supports pagination. Resource limits return an explicit error;
they never silently truncate matching documents.

## Examples

```sh
yarn search-local INDEX_DIR '(negligence OR malpractice) AND "standard of care"'
yarn search-local INDEX_DIR '(contract OR agreement) /p breach AND NOT "criminal law"'
yarn search-local INDEX_DIR 'jurisdiction' '{"exactTotal":true,"field":"title"}'
yarn dev INDEX_DIR
curl --get 'http://localhost:8787/search' \
  --data-urlencode 'q=(red OR blue) /s "fox jumps"' \
  --data-urlencode 'limit=20'
```

Unsupported syntax includes root expansion `!`, wildcards `*`/`?`, fuzzy search,
inline field/segment functions, occurrence-count functions, and negative proximity
such as `NOT /n`. Field and typed metadata filters are request options rather
than inline query syntax. Quotes specify exact analyzed token sequences, not
exact character substrings.
