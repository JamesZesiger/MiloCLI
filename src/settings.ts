// Milo's own settings, kept in ~/.milo/settings.toml. Each line is
// key = "value"; # starts a comment. Claude Code's settings stay in ~/.claude.
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { CHARACTER_NAMES, findCharacter, setCharacter, type CharacterName } from './characters.js'
import { findTheme, setTheme, THEME_NAMES, type ThemeName } from './theme.js'

export const SETTINGS_FILE = join(homedir(), '.milo', 'settings.toml')

/** The permission modes Milo switches between, in Shift+Tab order. */
export const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto']

const TEMPLATE = `# Milo settings. Each line looks like: key = "value"

# The permission mode Milo starts in: Default, Accept edits, Plan or Auto.
# default_mode = "Auto"

# Milo's colors: ${THEME_NAMES.join(', ')}. /theme shows them.
# theme = "milo"

# The mascot and the personality it gives Claude: ${CHARACTER_NAMES.join(', ')}.
# none is Claude's own voice. /char shows them.
# character = "milo"
`

export type Settings = {
  defaultMode?: PermissionMode
  theme?: ThemeName
  character?: CharacterName
}

/** Matches "Auto", "auto mode", "accept_edits", "acceptEdits" and so on. */
export const parseMode = (value: string) => {
  const key = value.toLowerCase().replace(/[\s_-]+/g, '').replace(/mode$/, '')
  return MODES.find(m => m.toLowerCase() === (key || 'default'))
}

// Each setting: what it means, its current value, and how to read a value
// into the settings (returning a problem if it can't).
type Known = { about: string; get: (from: Settings) => string | undefined; apply: (value: string, into: Settings) => string | void }
const KNOWN: Record<string, Known> = {
  default_mode: {
    about: 'the permission mode Milo starts in: Default, Accept edits, Plan or Auto',
    get: from => from.defaultMode,
    apply: (value, into) => {
      const mode = parseMode(value)
      if (!mode) return 'default_mode should be Default, Accept edits, Plan or Auto'
      into.defaultMode = mode
    },
  },
  theme: {
    about: `Milo's colors: ${THEME_NAMES.join(', ')}`,
    get: from => from.theme,
    apply: (value, into) => {
      const theme = findTheme(value)
      if (!theme) return `theme should be one of ${THEME_NAMES.join(', ')}`
      into.theme = theme
    },
  },
  character: {
    about: `the mascot and its personality: ${CHARACTER_NAMES.join(', ')} (none is Claude's own voice)`,
    get: from => from.character,
    apply: (value, into) => {
      const character = findCharacter(value)
      if (!character) return `character should be one of ${CHARACTER_NAMES.join(', ')}`
      into.character = character
    },
  },
}

export const SETTING_NAMES = Object.keys(KNOWN)

const unquote = (value: string) => value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')

const KEY_VALUE = /^([A-Za-z_][\w-]*)\s*=\s*(.+)$/

/** Reads the settings file, writing a commented example the first time. */
const read = () => {
  if (!existsSync(SETTINGS_FILE)) {
    mkdirSync(dirname(SETTINGS_FILE), { recursive: true })
    writeFileSync(SETTINGS_FILE, TEMPLATE)
  }
  return readFileSync(SETTINGS_FILE, 'utf8')
}

const load = (): { settings: Settings; problems: string[] } => {
  const settings: Settings = {}
  const problems: string[] = []
  let text: string
  try {
    text = read()
  } catch (err) {
    return { settings, problems: [`Couldn't read ${SETTINGS_FILE}: ${err instanceof Error ? err.message : String(err)}`] }
  }
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '').trim()
    if (!line || line.startsWith('#')) return
    const match = KEY_VALUE.exec(line)
    if (!match) return problems.push(`${SETTINGS_FILE} line ${i + 1}: expected key = "value"`)
    const [, key, value] = match as unknown as [string, string, string]
    const known = KNOWN[key]
    const problem = known ? known.apply(unquote(value), settings) : `unknown setting ${key}`
    if (problem) problems.push(`${SETTINGS_FILE}: ${problem}`)
  })
  return { settings, problems }
}

export const { settings, problems: settingsProblems } = load()
if (settings.theme) setTheme(settings.theme)
if (settings.character) setCharacter(settings.character)

/**
 * Saves one setting to the file and to the running settings. Replaces the
 * key's line (or its commented-out example) and keeps everything else.
 * Returns a problem, or nothing when it worked.
 */
export const saveSetting = (key: string, value: string): string | void => {
  const known = KNOWN[key]
  if (!known) return `Unknown setting ${key}. Milo has: ${SETTING_NAMES.join(', ')}`
  const updated: Settings = { ...settings }
  const problem = known.apply(unquote(value.trim()), updated)
  if (problem) return problem
  try {
    const lines = read().split(/\r?\n/)
    const keyOf = (line: string, commented: boolean) =>
      KEY_VALUE.exec(commented ? line.trim().replace(/^#\s*/, '') : line.trim())?.[1]
    const at = lines.findIndex(l => !l.trim().startsWith('#') && keyOf(l, false) === key)
    const example = lines.findIndex(l => l.trim().startsWith('#') && keyOf(l, true) === key)
    const entry = `${key} = ${JSON.stringify(unquote(value.trim()))}`
    if (at >= 0) lines[at] = entry
    else if (example >= 0) lines[example] = entry
    else lines.splice(lines.at(-1) === '' ? -1 : lines.length, 0, entry)
    writeFileSync(SETTINGS_FILE, lines.join('\n'))
  } catch (err) {
    return `Couldn't save ${SETTINGS_FILE}: ${err instanceof Error ? err.message : String(err)}`
  }
  Object.assign(settings, updated)
  // A new theme or mascot shows at once; the other settings wait for the next start.
  if (key === 'theme' && updated.theme) setTheme(updated.theme)
  if (key === 'character' && updated.character) setCharacter(updated.character)
}

/** Every setting, its value (or "not set") and what it means. */
export const describeSettings = () =>
  SETTING_NAMES.map(key => ({ key, value: KNOWN[key]!.get(settings), about: KNOWN[key]!.about }))
