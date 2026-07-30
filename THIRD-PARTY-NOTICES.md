# Third-party notices

`ccgrapher` is licensed under Apache-2.0 (see [LICENSE](LICENSE)). It depends on, and in one case
redistributes, third-party work listed here.

## Redistributed inside generated output

### Caveat (typeface) — SIL Open Font License 1.1

This is the only third-party work that leaves the repository inside a `ccgrapher` artefact.
`@ccgrapher/render-svg` base64-inlines the Caveat woff2 into every SVG it produces so the diagram
renders identically on a machine that has never installed the font. Each generated SVG therefore
redistributes the font, and carries this attribution as an XML comment near the top of the file.

    Caveat
    Copyright 2014 The Caveat Project Authors (https://github.com/googlefonts/caveat)

The font is redistributed unmodified, and is not sold on its own. Rendering with
`--no-embed-font` (or `renderSvg(..., { embedFont: false })`) references the family by name
instead, producing an SVG that contains no font data and no notice.

The full licence text follows.

```
Copyright 2014 The Caveat Project Authors (https://github.com/googlefonts/caveat)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## Runtime dependencies

| Package | Licence | Used by |
| --- | --- | --- |
| [zod](https://github.com/colinhacks/zod) | MIT | `core` — spec schema and validation |
| [yaml](https://github.com/eemeli/yaml) | ISC | `core` — YAML parse and serialise |
| [@dagrejs/dagre](https://github.com/dagrejs/dagre) | MIT | `layout` — coordinate assignment |
| [roughjs](https://github.com/rough-stuff/rough) | MIT | `render-svg` — hand-drawn strokes |
| [@fontsource/caveat](https://github.com/fontsource/font-files) | OFL-1.1 | `render-svg` — embedded typeface |
| [ts-morph](https://github.com/dsherret/ts-morph) | MIT | `ingest` — TypeScript AST traversal |
| [@xyflow/react](https://github.com/xyflow/xyflow) | MIT | `web` — interactive canvas |
| [next](https://github.com/vercel/next.js), [react](https://github.com/facebook/react) | MIT | `web` |

## Development dependencies

`typescript` (Apache-2.0), `vitest` (MIT) and `mermaid` (MIT) are used for building, testing and
verifying Mermaid output. They are not redistributed.

## Notes on the wider tree

Two transitive packages are worth naming explicitly for anyone running a licence scan:

- **`@img/sharp-libvips-*` (LGPL-3.0-or-later)** arrives through Next.js, which uses `sharp` for
  image optimisation. It is a prebuilt native binary loaded dynamically at runtime, is never
  statically linked into `ccgrapher` code, and none of the image-optimisation paths that would
  invoke it are used. It is not present in the CLI or library dependency trees — only the web app's.
- **`dompurify` (MPL-2.0 OR Apache-2.0)** arrives only through `mermaid`, a development dependency
  used by `tools/mermaid-check.html`. It is dual-licensed and the Apache-2.0 option applies.

Everything else in the installed tree is MIT, ISC, Apache-2.0, BSD-2/3-Clause, 0BSD, CC0-1.0 or
Unlicense. No copyleft obligation attaches to `ccgrapher`'s own source.
