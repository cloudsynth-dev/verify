#!/usr/bin/env node
/**
 * One self-contained file, dist/cloudsynth.mjs.
 *
 * This is what a GitHub Action actually runs: no install step, no
 * node_modules, no private workspace packages to resolve. It is only possible
 * because the intent evaluator was decoupled from aws-cdk-lib — bundling
 * verifies that too, and the assertion below fails loudly if the CDK ever
 * creeps back into this path and turns a 400KB file into a 40MB one.
 */
import { build } from 'esbuild';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, 'dist', 'cloudsynth.mjs');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile,
  // Stamped in rather than read from a sibling package.json at runtime: the
  // published package is one file that a GitHub Action runs straight out of
  // github.action_path, where resolving a neighbouring manifest is exactly the
  // kind of thing that works locally and fails there. A report says which build
  // produced it, so this has to survive bundling.
  define: { __CLOUDSYNTH_VERSION__: JSON.stringify(version) },
  // `yaml` ships a CJS build that calls require('process'). ESM output has no
  // require, so without this the bundle dies on its first parse with "Dynamic
  // require of \"process\" is not supported" — and only outside the monorepo,
  // where nothing else provides it.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

const source = readFileSync(outfile, 'utf8');
for (const forbidden of ['aws-cdk-lib', 'cdk-nag', '@aws-sdk']) {
  if (source.includes(forbidden)) {
    throw new Error(
      `${forbidden} ended up in the CLI bundle. The intent evaluator must stay free of it — ` +
        'that is what makes this a single small file a customer can run anywhere.',
    );
  }
}

if (!source.includes(JSON.stringify(version))) {
  throw new Error(`the bundle does not carry its own version (${version}) — define failed`);
}

console.log(
  `Bundled ${(statSync(outfile).size / 1024).toFixed(0)}KB -> dist/cloudsynth.mjs (v${version})`,
);
