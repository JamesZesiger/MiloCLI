// Renders the app once with a sample state and prints the frame: npm run frame -- [columns] [rows]
import React from 'react'
import { renderToString } from 'ink'
import { App } from '../src/tui.js'
import { setState } from '../src/store.js'

const [cols, rows] = [Number(process.argv[2] ?? 110), Number(process.argv[3] ?? 32)]
setState({
  model: 'Opus 5.5', contextPct: 2, busy: true, mood: 'working', status: 'Sniffing', turnStarted: Date.now(), turnTools: 1, currentTool: 'Read',
  entries: [{ kind: 'user', text: 'x'.repeat(170) }, { kind: 'assistant', text: 'Edit requires a prior Read.' }, { kind: 'tool', id: '1', name: 'Read', detail: '/home/' + 'y'.repeat(84), status: 'running' }],
  pending: { kind: 'permission', tool: 'Read', detail: '/home/' + 'y'.repeat(84), reason: 'Path is outside allowed working directories', canAlways: true, resolve: () => {} },
})
const out = renderToString(<App columns={cols} rows={rows} />, { columns: cols })
const lines = out.split('\n')
console.log('height', lines.length)
lines.forEach((l, i) => console.log(String(i).padStart(2), l.replace(/\x1b\[[0-9;]*m/g, '')))
