/** @type {import('next').NextConfig} */
export default {
  // The workspace packages ship TypeScript-built ESM; let Next compile them.
  transpilePackages: [
    "@ccgrapher/core",
    "@ccgrapher/layout",
    "@ccgrapher/lint",
    "@ccgrapher/trace",
  ],
  // Static HTML/JS/CSS, no Node server: the app has always been client-only
  // (the canvas loads with ssr:false, and the only network call is an
  // optional fetch to a `ccg serve` trace server the reader points it at),
  // so this changes nothing about how the page runs — only where it can be
  // hosted from. `next build` writes the exportable output to `out/`.
  output: "export",
};
