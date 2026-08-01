/** @type {import('next').NextConfig} */
export default {
  // The workspace packages ship TypeScript-built ESM; let Next compile them.
  transpilePackages: [
    "@ccgrapher/core",
    "@ccgrapher/layout",
    "@ccgrapher/lint",
    "@ccgrapher/trace",
  ],
};
