// The mascots Milo can show: each one's name, faces, spinner words and the
// personality it gives Claude. "none" is Claude's own voice with no mascot.
import type { Mood } from './milo.js'

export type Character = {
  /** What replies and the header are labelled with. */
  name: string
  about: string
  /** Appended to Claude Code's system prompt; none keeps Claude's own voice. */
  voice?: string
  /** The status-line face for each mood. */
  faces: Record<Mood, string>
  /** Paws on the input box, under the status-line face. */
  paws: boolean
  /** The five-line face drawn when there's no room or color for the portrait. */
  face: (mood: Mood) => string[]
  /** The one-word face plain mode puts before its lines. */
  small: (mood: Mood) => string
  verbs: string[]
  past: string[]
}

const EYES: Record<Mood, string> = { idle: 'o o', thinking: '- -', working: '0 0', error: 'x x' }

const catFace = (mood: Mood) => [
  '  /\\_____/\\  ',
  ` (  ${EYES[mood]}  ) `,
  ' (  =^=  )  ',
  '  )     (   ',
  ' (__)-(__)  ',
]

const catSmall = (mood: Mood) => `=^${EYES[mood].replace(' ', '')}^=`

export const CHARACTERS = {
  milo: {
    name: 'Milo',
    about: 'your coding cat, powered by Claude Code',
    voice: `You are Milo, a friendly, curious cat who is also a sharp coding companion, speaking through a custom terminal front end. Keep every engineering standard from your coding instructions; Milo only changes how you sound.
- Warm and brief. Lead with the answer. Light cat flavor ("pounced on it", "sniffed this out") at most once per reply, and never in code, commit messages or files.
- When you finish a task, end with one line starting with "Caught:" that sums up what changed.`,
    faces: { idle: '|ᐠ｡ꞈ｡ᐟ|', thinking: '|ᐠ-ꞈ-ᐟ|', working: '|ᐠ•ꞈ•ᐟ|', error: '|ᐠ×ꞈ×ᐟ|' },
    paws: true,
    face: catFace,
    small: catSmall,
    verbs: [
      'Purring',
      'Kneading',
      'Stalking the bug',
      'Chasing the cursor',
      'Batting at it',
      'Pouncing',
      'Sniffing the stack trace',
      'Grooming the code',
    ],
    past: ['caught it', 'pounced on it', 'dragged it in', 'knocked it off the table', 'sniffed it out'],
  },
  boo: {
    name: 'Boo',
    about: 'a tortoiseshell with opinions, powered by Claude Code',
    voice: `You are Boo, a tortoiseshell cat with plenty of tortitude who is also a sharp coding companion, speaking through a custom terminal front end. Keep every engineering standard from your coding instructions; Boo only changes how you sound.
- Dry, confident and a little sassy, but never unkind to the user. Lead with the answer and keep it short. At most one wry cat aside per reply ("knocked that off the desk", "not impressed by this regex"), and never in code, commit messages or files.
- When you finish a task, end with one line starting with "Swatted:" that sums up what changed.`,
    faces: { idle: '|ᐠ¬ꞈ¬ᐟ|', thinking: '|ᐠ-ꞈ-ᐟ|', working: '|ᐠ•ꞈ•ᐟ|', error: '|ᐠ×ꞈ×ᐟ|' },
    paws: true,
    face: catFace,
    small: catSmall,
    verbs: [
      'Judging the code',
      'Side-eyeing the bug',
      'Swatting at it',
      'Loafing on the keyboard',
      'Knocking things off the desk',
      'Plotting',
      'Tail flicking',
      'Stalking the stack trace',
    ],
    past: ['swatted it', 'handled it', 'knocked it out', 'made it look easy', 'sorted it'],
  },
  none: {
    name: 'Claude',
    about: 'Claude Code, with no mascot',
    faces: { idle: '✻', thinking: '✻', working: '✻', error: '✗' },
    paws: false,
    face: mood => {
      const mid = { idle: '*', thinking: '-', working: '+', error: 'x' }[mood]
      return ['   \\  |  /   ', '    \\ | /    ', ` ---- ${mid} ---- `, '    / | \\    ', '   /  |  \\   ']
    },
    small: mood => (mood === 'error' ? '✗' : '✻'),
    verbs: ['Thinking', 'Working', 'Considering', 'Pondering', 'Mulling it over'],
    past: ['finished', 'wrapped it up', 'got it done'],
  },
} satisfies Record<string, Character>

export type CharacterName = keyof typeof CHARACTERS
export const CHARACTER_NAMES = Object.keys(CHARACTERS) as CharacterName[]

/** Matches a character's key or name in any case, so "claude" finds none. */
export const findCharacter = (name: string) => {
  const wanted = name.trim().toLowerCase()
  return CHARACTER_NAMES.find(n => n === wanted || CHARACTERS[n].name.toLowerCase() === wanted)
}

let current: CharacterName = 'milo'

export const characterName = () => current
export const mascot = (): Character => CHARACTERS[current]
export const setCharacter = (name: CharacterName) => {
  current = name
}

/** What goes on the end of Claude Code's system prompt for the current character. */
export const persona = () => mascot().voice
