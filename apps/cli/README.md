# @ccgrapher/cli

Command line interface for [ccgrapher](https://github.com/artfusion/ccgrapher) — a linter for agent workflows.

```bash
npx @ccgrapher/cli lint my-workflow.yaml
```

```
ccg lint    <spec.yaml>...            find fake edges and wasted sequencing
ccg render  <spec.yaml> -o out.svg    draw it (svg | mermaid | excalidraw)
ccg codegen <spec.yaml> -t <target>   emit orchestration code
ccg ingest  <orchestration.ts>        reconstruct a spec from existing code
ccg plan    <spec.yaml>               what can run at once, wave by wave
ccg retro   <owner/repo>              rebuild the as-merged workflow from PR history
ccg run     <spec.yaml> --impl <mod>  execute the spec and write a trace
```

An edge only exists if real data passes along it. Most workflows are typed as a
straight chain out of habit, so most edges are fake; delete them and the graph
goes wide instead of tall.

```
  error  FAKE_EDGE      review_a -> review_b carries nothing
  error  MISSING_INPUT  review_b requires 'repo' but no inbound edge carries it

  Critical path: 6 layers -> 4 layers (2 fewer after repair)
```

Exit code is 0 when clean, 1 when there are errors, 2 on bad usage.

---

Part of [ccgrapher](https://github.com/artfusion/ccgrapher). Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
