# @ccgrapher/ingest

Reconstructs a workflow spec from existing TypeScript orchestration code.

```ts
import { ingest } from "@ccgrapher/ingest";

const { spec, warnings } = ingest(readFileSync("orchestration.ts", "utf8"));
```

The other direction: what does my workflow actually do, rather than what did I
intend? Uses ts-morph to recover nodes, dependencies and concurrency from real
code, which is where a fake-edge audit finds waste that was never in a diagram.

Round-tripping is lossless — `spec -> codegen -> ingest -> spec` returns a
deeply-equal spec, asserted for every fixture in the test suite.

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
