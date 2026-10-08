// Bundles the API into dist/server.js (and dist/seed.js, run as a pre-deploy
// step in production). npm dependencies stay external (installed in the
// image); the workspace's TypeScript package is inlined.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/server.ts', 'src/seed.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  plugins: [
    {
      name: 'externalize-npm-packages',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith('@bidrush/') ? undefined : { path: args.path, external: true },
        )
      },
    },
  ],
})
console.log('dist/server.js and dist/seed.js built')
