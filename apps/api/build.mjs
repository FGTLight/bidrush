// Bundles the API into dist/server.js. npm dependencies stay external
// (installed in the image); the workspace's TypeScript package is inlined.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
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
console.log('dist/server.js built')
