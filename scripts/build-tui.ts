import solidPlugin from '@opentui/solid/bun-plugin';

const result = await Bun.build({
  entrypoints: ['./src/tui/index.tsx'],
  outdir: './dist',
  naming: 'tui.[ext]',
  target: 'bun',
  external: ['solid-js', '@opentui/*'],
  plugins: [solidPlugin],
});

if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}
