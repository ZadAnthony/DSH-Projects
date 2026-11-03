# Stock UI Host compatibility templates

Source: deepseek-harness commit `639ed015397290b3745d163aafe02ffee4aa3f84` (MIT).

- `readonly-history.ts`: `packages/api/session-controller/src/history.ts`; imports use public package types. Projects directory cuts and selected event reads replace native full cold observations. Message/turn pagination, exact sequence continuity and assistant-stream watermarks remain. `ui-port.ts` owns ordinary post-snapshot activation through the existing Projects control/factory; read-only follows never activate.
- `history-observation.ts`: Projects-owned directory/window adapter. Cold native projections bootstrap through the public registry's exact-cut `restore` using the explicit read-only run view and streamed event transformation. Each bootstrap reads the selected cut without retaining checkpoint or wire caches. This does not create or announce a Session, synthesize recovery suffixes, or retain canonical events/request bodies. Four Projects-only legacy raw evidence types and their reference successors have explicit UI metadata markers; native display messages and tool results remain original selected records.
- `assistant-stream.ts`: `packages/api/session-controller/src/assistant-stream.ts`; types import uses public package export.

These templates are bundled plugin code. No runtime deep import into a host source tree.
