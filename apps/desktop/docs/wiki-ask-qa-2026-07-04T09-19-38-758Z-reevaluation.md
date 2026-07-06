# Wiki Ask QA Re-evaluation

- Source report: `docs/wiki-ask-qa-2026-07-04T09-19-38-758Z.md`
- Original live run: 10 UniPort questions through real Railway Hermes `wiki-curator`
- Original report result: 9 pass / 1 fail
- Re-evaluated result after citation-ending truncation fix: 10 pass / 0 fail

## Why the Result Changed

The original QA evaluator treated answers ending with citation blocks such as `[1][2][5]` as possible truncation. Question #5 ended with a complete Korean sentence followed by citations:

> 이 파일이 edu-show의 정본이 된다. [1][2][5]

That is a complete answer, not a truncated one. The evaluator now strips trailing citation markers before checking Korean sentence endings.

## Quality Notes

- No gateway fallback occurred in the run.
- Answers were grounded in local wiki sources and generated through Railway Hermes.
- The answers used natural Korean prose rather than a fixed "요약/근거/다음 행동" template.
- The remaining risk is latency: average 72,997ms, p95 173,507ms. The retry path improves reliability but can make a single question slow when Railway relay stalls once.

