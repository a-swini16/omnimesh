import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bundle the router's Worker entry (packages/router/src/index.ts) into one ES module. */
export async function bundleRouter(): Promise<string> {
  const { build } = await import('esbuild');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entry = path.resolve(here, '../../../router/src/index.ts');
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'browser', 'import'],
    minify: true,
    legalComments: 'none',
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}
