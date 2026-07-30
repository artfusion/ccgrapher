// SPDX-License-Identifier: Apache-2.0
/**
 * roughjs points `types` at `bin/`, but `bin/`'s ESM uses extensionless
 * relative imports that Node will not resolve outside a bundler. We load the
 * bundled single-file build instead and re-declare just the surface we use.
 */
declare module "roughjs/bundled/rough.esm.js" {
  import type { Config } from "roughjs/bin/core.js";
  import type { RoughGenerator } from "roughjs/bin/generator.js";

  const rough: {
    generator(config?: Config): RoughGenerator;
  };
  export default rough;
}
