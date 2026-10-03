# ccgrapher

Nine pull requests went out in one session, one after another, then a release.
Twelve steps in a row. Asked what each of them actually needed, only three were
waiting on anything. The other six only needed the week's scope, and could have
gone out side by side.

```
Before: twelve steps in a row
scope → P1 fix → landing → credit line → site 2 → copy → pricing → links → own key → compare → CI → release

After: five waves
1  scope
2  P1 fix · landing · site 2 · pricing · own key · compare
3  credit line · copy · links
4  CI
5  release
```

That is what this skill does. It takes a plan, or a brain dump of features,
fixes and ideas in whatever order they came to mind, and works out what each
piece really needs from the others. Then it shows the plan as it was given next
to the order the work actually has. The shape it is after is a diamond: narrow
at the top, as wide as the dependencies honestly allow in the middle, narrow
again at the end.

It is the same as building a house. You cannot side it before it is framed, but
the plumber and the electrician do not need to wait for each other.

Along the way it points out a step that checks its own work, a step that
collects results without checking they all arrived, and two steps that would
write the same file at the same time.

For a small change it stays out of the way. Three steps in a row are usually
just three steps.

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
Apache-2.0. The diamond comes from Anatoli Kopadze's article
[Graph Engineering explained](https://x.com/anatolikopadze/status/2080668775796314331).
Questions and bug reports go to the repository's
[issue tracker](https://github.com/artfusion/ccgrapher/issues).
