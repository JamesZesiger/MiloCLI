// Bundles Milo into one file. Loading Ink's hundreds of small files is slow
// on some filesystems (WSL reading /mnt/c took 5s); one file loads at once.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/milo.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // The SDKs start Claude Code and Codex from files next to them, so they stay packages.
  external: ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk'],
  alias: { 'react-devtools-core': './build/devtools-stub.js' },
  banner: { js: "import { createRequire as __milo_require } from 'node:module'; const require = __milo_require(import.meta.url);" },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})
