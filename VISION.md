# Where ccgrapher is going

**The short version: free to read, paid to run. The toolkit is open and stays open. The service that runs your workflows for you is the business.**

## The finding that set the direction

I wrote the rule that says every fan-in needs a count guard, and about an hour later I planned a session containing an unguarded fan-in. The linter caught it. It has since caught the same shape on our own boards several times, twice in plans I had already read and approved.

So the product is not speed. Everyone promises speed, nobody believes it, and the wave counts were honestly re-derivable by eye. The product is the moment a tool tells you, mechanically, that the step you trusted to verify the work was never checking it. A verifier grading its own homework. A join reporting success while one branch died quietly. Those are the expensive misses, and you cannot find them by rereading your own plan, because you wrote it.

## Two tracks, deliberately

**ccgrapher OSS.** Apache-2.0, all of it, permanently. Everything a single developer needs: the schema, the six lint rules, layout and three renderers, code generation for Claude Code, plain TypeScript and LangGraph, ingest, the retrospective mode, the local canvas. Next on top of that: a trace contract so a run can say what actually happened, a runner that turns `expects` from a logged apology into a thrown error, a canvas where nodes light up as the run proceeds, heat overlays from your own git history, and cost projections drawn only from recorded runs. If there is no data we say so on the screen. We do not invent constants.

**ccgrapher Cloud.** A managed orchestration service. You bring the spec, we run it: the queue, the worktrees, the timeouts, the trace store, the live dashboard, the gate that waits for a human to click approve. It is built on the same `@ccgrapher/runner` and `@ccgrapher/trace` packages you can read in this repo, unchanged. The open half establishes the standard, the paid half sells the running of it.

I want both, and I am putting that in the repo on purpose. The open track is for the craft, and I would build it anyway. The commercial track is a real product aimed at a real market, and if what it finally earns is credibility, a portfolio and a conversation with an acquirer rather than a subscription business, that was part of the plan and not a consolation. You cannot side a house that is not framed, so the framing comes first: contract, runner, canvas, in that order.

## The plan lints itself

The whole roadmap is a ccgrapher spec: [plans/vision-rollout.yaml](plans/vision-rollout.yaml). Twenty-five steps, eight waves, seventeen fewer than doing them one at a time. The first lint pass caught two pairs of stories writing the same file in the same wave, which is exactly the class of collision the tool exists to catch, so the tool got to review its own roadmap before any human did. It found things. That felt about right.

## Where it lives

The site will sit at ccgrapher.artfusion.com for now, an OSS front door with the Cloud offer beside it. The first paid thing is small and honest: a workflow audit, run with `ccg retro` against your merged pull requests, showing which of your steps were never waiting and which of your checks never checked. The method has already worked on our own boards.

If you read the schema and something feels wrong, open an issue and say so plainly, I genuinely want the pushback. And if a verifier has ever passed work it never saw, I would like to hear that story. Do you know what I mean?
