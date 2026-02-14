// Build UMD bundle for <script> tag usage
// Output: dist/umd/receptionist-sdk.js + .min.js

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

async function main() {
  // Full (unminified) bundle
  await build({
    entryPoints: [join(root, 'src/index.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'ReceptionistSDK',
    outfile: join(root, 'dist/umd/receptionist-sdk.js'),
    platform: 'browser',
    target: ['es2020'],
    sourcemap: true,
  });

  // Minified bundle
  await build({
    entryPoints: [join(root, 'src/index.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'ReceptionistSDK',
    outfile: join(root, 'dist/umd/receptionist-sdk.min.js'),
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    sourcemap: true,
  });

  console.log('✅ UMD bundles built:');
  console.log('   dist/umd/receptionist-sdk.js');
  console.log('   dist/umd/receptionist-sdk.min.js');
}

main().catch((err) => {
  console.error('UMD build failed:', err);
  process.exit(1);
});
