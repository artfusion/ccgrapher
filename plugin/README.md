# ccgrapher

A skill that checks a multi-step plan before it is carried out. Most plans are
written as a straight chain, in the order the steps occurred to the author. Very
few are actually shaped that way. The skill has Claude write the plan down as a
small spec saying what each step reads and what it produces, then finds the
steps that were never waiting on anything, so the independent ones can run at the
same time.

It applies to plans of roughly five steps or more, and to work that is about to
be fanned out to subagents. Below that it stays out of the way.

## What it runs

Nothing, unless you agree. The skill can use the ccgrapher command line to lint
the plan, work out the order of execution and draw it before and after. Those
commands run `npx @ccgrapher/cli@0.5.0`, which downloads that exact version of
the package from the npm registry and runs it on your machine against a plan file
Claude has just written. Claude asks before doing this. If you decline, it does
the same analysis by hand.

## What it sends and keeps

The plugin sends no data anywhere and stores nothing. The commands it uses
(`lint`, `plan` and `render`) make no network requests of their own. They read
the plan file and write their result to the terminal or to an image file. The
only network use is the one-off package download described above.

## Source and support

The source, the command line tool and the examples are in the
[ccgrapher repository](https://github.com/artfusion/ccgrapher), licensed under
Apache-2.0. Questions and bug reports go to the repository's
[issue tracker](https://github.com/artfusion/ccgrapher/issues).
