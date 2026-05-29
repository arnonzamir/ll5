# DECISION-005 — Cross-entity search scoring via raw BM25 + single global normalization

Date: 2026-05-29
Status: Accepted
Scope: personal-knowledge MCP (`tools/search.ts`, `repositories/elasticsearch/{fact,person,place}.repository.ts`)

## Context

`search_knowledge` merges hits from three ES repositories (facts, people, places). Each repository normalized its own `_score` against its own top hit (`score = hit._score / hits[0]._score`), so the best fact, best person, and best place all came back as `1.0`. The cross-entity merge then sorted and applied a `min_score` cutoff over these per-type-normalized numbers — making both the cross-type ranking and the `min_score` threshold meaningless (every type's best result tied at the top, and `min_score` couldn't distinguish a strong match from a weak one).

## Decision

- The three repositories now carry the **raw BM25 `_score`** instead of per-repo normalizing. The scores are comparable across these repos because each issues the same `multi_match` + `fuzziness: AUTO` query shape for the same query string.
- `search_knowledge` normalizes **once**, against the single global max across all merged candidates, so the emitted `score` is a comparable `0..1` value and the documented `min_score` (0..1) semantics hold.
- The tool logs its scoring basis: `info Scoring basis { scoringBasis: 'raw_bm25_global_normalized', globalMax, candidates }`.

## Alternatives considered

- **Per-type normalization** (the bug) — non-comparable across types.
- **A synthetic re-rank / learned weighting across entity types** — rejected as over-engineering for the current need; raw BM25 with a single global normalization is the minimal change that makes scores genuinely comparable while preserving the existing `0..1` API contract.

## Consequences

- Cross-entity ordering now reflects real relative relevance; `min_score` meaningfully drops weak matches.
- If entity-specific query shapes diverge in the future (different fields/boosts/analyzers), BM25 comparability weakens — revisit then.
