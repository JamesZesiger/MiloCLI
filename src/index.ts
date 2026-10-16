#!/usr/bin/env node
// Milo: a cat-themed front end. Claude Code runs in the background through the
// Agent SDK. In a terminal Milo runs full screen; piped, or with --plain, it
// runs line by line.
const fullScreen = process.stdout.isTTY && process.stdin.isTTY && !process.argv.includes('--plain')

if (fullScreen) await (await import('./tui.js')).main()
else await import('./plain.js')
