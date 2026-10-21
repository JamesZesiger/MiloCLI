// The explorer view's command line: runs shell commands in the background and
// gathers their output as lines for the terminal pane.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { readdirSync, statSync, type Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const MAX_LINES = 5000

// Colors stay; cursor moves, window titles and other escapes would garble the pane.
const ESCAPES = /\x1b\[[0-9;?]*[A-Za-ln-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]/g
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g

/** A carriage return rewrites its line, as progress bars do: keep what came last. */
const settle = (line: string) => {
  const i = line.replace(/\r+$/, '').lastIndexOf('\r')
  return i < 0 ? line : line.slice(i + 1)
}

/** Adds a chunk of output to the lines. The last line is the one still being written. */
export const appendOutput = (lines: string[], chunk: string): string[] => {
  const parts = chunk.replace(ESCAPES, '').replace(CONTROLS, '').replace(/\r\n/g, '\n').split('\n')
  const out = lines.length ? lines.slice(0, -1) : []
  out.push(settle((lines.at(-1) ?? '') + parts[0]), ...parts.slice(1).map(settle))
  return out.length > MAX_LINES ? out.slice(-MAX_LINES) : out
}

/**
 * A plain `cd` changes the command line's own folder, since each command runs
 * in a shell of its own. Returns the new folder, a problem, or undefined when
 * the command isn't a cd.
 */
export const changeDir = (command: string, cwd: string): { cwd: string } | { problem: string } | undefined => {
  // Anything with shell operators, like `cd src && ls`, runs in the shell as typed.
  const match = /^cd(?:\s+([^;&|<>$`]+))?$/.exec(command.trim())
  if (!match) return undefined
  const target = (match[1] ?? '~').trim().replace(/^(["'])(.*)\1$/, '$2')
  const path = target === '~' ? homedir() : target.startsWith('~/') ? join(homedir(), target.slice(2)) : resolve(cwd, target)
  try {
    if (statSync(path).isDirectory()) return { cwd: path }
  } catch {
    // Missing: fall through to the problem.
  }
  return { problem: `cd: no such folder: ${target}` }
}

const running = new Set<ChildProcess>()

/** Stops a command and everything it started; `force` kills instead of interrupting. */
export const stopCommand = (child: ChildProcess, force = false) => {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, force ? 'SIGKILL' : 'SIGINT')
    else child.kill(force ? 'SIGKILL' : 'SIGINT')
  } catch {
    child.kill('SIGKILL') // the group is already gone
  }
}

// Commands shouldn't outlive Milo.
process.once('exit', () => running.forEach(child => stopCommand(child, true)))

/** Runs a command in the user's shell, passing its output along as it arrives. */
export const runCommand = (
  command: string,
  cwd: string,
  onOutput: (chunk: string) => void,
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void,
): ChildProcess => {
  // No stdin, so a command that waits for input gets end-of-file instead of
  // hanging; pagers would wait too, so print straight through.
  const windows = process.platform === 'win32'
  const child = spawn(windows ? command : process.env.SHELL || '/bin/sh', windows ? [] : ['-c', command], {
    cwd,
    env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: windows,
    detached: !windows, // its own process group, so Ctrl+C reaches what it starts
  })
  running.add(child)
  child.stdout.setEncoding('utf8').on('data', onOutput)
  child.stderr.setEncoding('utf8').on('data', onOutput)
  let done = false
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (done) return
    done = true
    running.delete(child)
    onExit(code, signal)
  }
  child.on('error', (err: Error) => {
    onOutput(`${err.message}\n`)
    finish(127, null)
  })
  child.on('close', finish)
  return child
}

// --- Oh My Posh ------------------------------------------------------------

// Set by `oh-my-posh init` in the shell Milo started from; without it the
// command line keeps its own prompt.
const poshConfig = process.env.POSH_CONFIG || process.env.POSH_THEME
let poshMissing = !poshConfig

/** How the last command went, for the prompt's status and timing segments. */
export type LastRun = { code: number; ms: number }

/**
 * The user's oh-my-posh prompt for `cwd`, colors kept, or undefined when
 * oh-my-posh isn't installed or set up.
 */
export const poshPrompt = (cwd: string, width: number, last?: LastRun): Promise<string | undefined> => {
  if (poshMissing) return Promise.resolve(undefined)
  const args = ['print', 'primary', `--config=${poshConfig}`, `--pwd=${cwd}`, '--escape=false', `--terminal-width=${width}`]
  args.push(...(last ? [`--status=${last.code}`, `--execution-time=${last.ms}`] : ['--no-status']))
  return new Promise(done =>
    execFile('oh-my-posh', args, { cwd, timeout: 2000 }, (err, stdout) => {
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') poshMissing = true
      const prompt = stdout.replace(ESCAPES, '').replace(CONTROLS, '').replaceAll('\r', '').trimEnd()
      done(err || !prompt ? undefined : prompt)
    }),
  )
}

// --- Completion ------------------------------------------------------------

// Shell builtins aren't files on PATH, but they're commands all the same.
const BUILTINS = ['alias', 'cd', 'clear', 'echo', 'exit', 'export', 'pwd', 'source', 'type', 'unset', 'which']
const pathCommands = new Set<string>(BUILTINS)
let loading: Promise<void> | undefined

/** Reads the command names on PATH once, in the background. Resolves when done. */
export const loadCommands = () =>
  (loading ??= Promise.all(
    (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir =>
      readdir(dir)
        .then(names => names.forEach(name => pathCommands.add(name)))
        .catch(() => {}), // missing or unreadable: skip it
    ),
  ).then(() => {}))

// A backslash keeps a space or shell character part of a word.
const escapeWord = (word: string) => word.replace(/([\s'"\\$`&|;<>()*?!#])/g, '\\$1')
const unescapeWord = (word: string) => word.replace(/\\(.)/g, '$1')

/** Where the last word starts: after the last space that isn't escaped. */
const wordStart = (input: string) => {
  let start = 0
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '\\') i++
    else if (/\s/.test(input[i]!)) start = i + 1
  }
  return start
}

const isDirEntry = (entry: Dirent, path: string) => {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Paths that finish `word`, folders ending in / and files in a space. */
const completePath = (word: string, cwd: string, foldersOnly: boolean) => {
  const raw = unescapeWord(word)
  const typedDir = raw.slice(0, raw.lastIndexOf('/') + 1)
  const name = raw.slice(typedDir.length)
  const dir = typedDir.startsWith('~/') ? join(homedir(), typedDir.slice(2)) : resolve(cwd, typedDir || '.')
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry.name.startsWith(name) && (name.startsWith('.') || !entry.name.startsWith('.')))
    .map(entry => ({ entry, folder: isDirEntry(entry, join(dir, entry.name)) }))
    .filter(({ folder }) => folder || !foldersOnly)
    .map(({ entry, folder }) => escapeWord(typedDir + entry.name) + (folder ? '/' : ' '))
}

const commonPrefix = (words: string[]) =>
  words.reduce((common, word) => {
    let i = 0
    while (i < common.length && common[i] === word[i]) i++
    return common.slice(0, i)
  })

export type Completion = {
  /** What to show dimmed after the cursor, and add on Tab or →. */
  ghost: string
  /** Every word that could finish the last one, when there's more than one. */
  choices: string[]
}

/**
 * Completes the last word of a command line: a command name where a command
 * goes, otherwise a path (only folders after cd). Failing that, suggests the
 * rest of the latest earlier command that starts the same way.
 */
export const completeCommand = (input: string, cwd: string, history: string[]): Completion => {
  if (!input.trim()) return { ghost: '', choices: [] }
  const start = wordStart(input)
  const word = input.slice(start)
  const before = input.slice(0, start).trim()
  const commandSpot = !before || /(\|\||&&|;|\|)$/.test(before)
  let choices: string[] = []
  if (commandSpot && word && !word.includes('/')) {
    choices = [...pathCommands].filter(name => name.startsWith(word)).map(name => `${escapeWord(name)} `)
  } else if (!commandSpot || word.includes('/')) {
    choices = completePath(word, cwd, /^cd$/.test(before.split(/\s+/).at(-1) ?? ''))
  }
  choices.sort((a, b) => a.localeCompare(b))
  const common = choices.length ? commonPrefix(choices) : ''
  let ghost = common.length > word.length ? common.slice(word.length) : ''
  if (!ghost) ghost = history.find(past => past.startsWith(input) && past !== input)?.slice(input.length) ?? ''
  return { ghost, choices: choices.length > 1 ? choices : [] }
}
