// Turns log entries into wrapped terminal lines for the workspace, so it can
// show any slice of them when scrolled.
import wrapAnsi from 'wrap-ansi'
import { basename } from 'node:path'
import { c } from './milo.js'
import type { Entry } from './store.js'

const wrap = (text: string, width: number) => wrapAnsi(text, Math.max(10, width), { hard: true, trim: false }).split('\n')

/** Light Markdown: headings, **bold** and `code`. */
const markdown = (text: string) =>
  text
    .split('\n')
    .map(line =>
      /^#{1,6} /.test(line)
        ? c.bold(c.orange(line.replace(/^#+ /, '')))
        : line.replace(/\*\*([^*\n]+)\*\*/g, (_, s: string) => c.bold(s)).replace(/`([^`\n]+)`/g, (_, s: string) => c.cyan(s)),
    )
    .join('\n')

const ICONS = { running: c.dim('⋯'), done: c.green('✓'), error: c.red('✗') }

const linesFor = (entry: Entry, width: number, labelled: boolean): string[] => {
  switch (entry.kind) {
    case 'user':
      return [
        '',
        ...wrap(c.bold(`❯ ${entry.text}`), width),
        ...(entry.images ?? []).flatMap(image => wrap(c.dim(`  🖼  ${basename(image)}`), width)),
      ]
    case 'assistant':
      return [...(labelled ? ['', c.bold(c.orange('Milo'))] : []), ...wrap(markdown(entry.text.trim()), width)]
    case 'tool': {
      const head = wrap(`  ${ICONS[entry.status]} ${c.bold(entry.name)}  ${c.dim(entry.detail)}`, width)
      if (!entry.error) return head
      const error = entry.error.split('\n').slice(0, 3).map(line => c.red(`    ${line}`))
      return [...head, ...error.flatMap(line => wrap(line, width))]
    }
    case 'note':
      if (entry.tone === 'raw') return entry.text.split('\n')
      return wrap(entry.tone === 'error' ? c.red(entry.text) : c.dim(entry.text), width)
  }
}

const cache = new WeakMap<Entry, { width: number; labelled: boolean; lines: string[] }>()

export const logLines = (entries: Entry[], width: number): string[] => {
  const out: string[] = []
  let replied = false
  entries.forEach(entry => {
    // Label Milo's reply once per prompt, not again after each tool call.
    if (entry.kind === 'user') replied = false
    const labelled = entry.kind === 'assistant' && !replied
    if (entry.kind === 'assistant') replied = true
    let hit = cache.get(entry)
    if (!hit || hit.width !== width || hit.labelled !== labelled) {
      hit = { width, labelled, lines: linesFor(entry, width, labelled) }
      cache.set(entry, hit)
    }
    out.push(...hit.lines)
  })
  return out
}
