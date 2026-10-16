// Milo's portrait: pixel art drawn with half blocks (▀ ▄), two pixels per
// character cell, in 24-bit color with a 256-color fallback.
import type { Mood } from './milo.js'
import { to256, truecolor, type RGB } from './theme.js'

const PALETTE: Record<string, RGB> = {
  k: [74, 42, 20], //    outline
  O: [232, 145, 63], //  orange fur
  o: [196, 111, 42], //  orange fur, shaded
  W: [251, 247, 242], // white fur
  w: [220, 211, 201], // white fur, shaded
  P: [244, 176, 168], // inner ear
  E: [227, 163, 59], //  amber eye
  e: [184, 122, 30], //  amber eye, shaded
  K: [28, 20, 16], //    pupil
  H: [255, 255, 255], // eye highlight
  N: [238, 154, 158], // nose
  n: [204, 116, 122], // nose, shaded
  m: [107, 59, 42], //   mouth
  F: [208, 122, 53], //  freckles
}

// Left halves are mirrored to full width. '.' is transparent; '-' marks the
// cells each eye is drawn over.

type Sprite = {
  left: string[]
  eyeRow: number
  eyeCol: number
  /** Eye cells per mood. */
  eyes: Record<Mood, string[]>
  /** Milo's own markings, which are not symmetric. [row, column, color] */
  markings: [number, number, string][]
}

// 44×36 pixels: 44 columns, 18 lines.
const BIG: Sprite = {
  left: [
  '......k...............',
  '.....kOk..............',
  '.....kOOk.............',
  '.....kOPOk............',
  '....kOPPOOk...........',
  '....kOPPPOOk..........',
  '....kOPWPPOOk....kkkkk',
  '....kOPWPPPOOk.kkOOOOO',
  '....kOPPWPPPOOkOOOOOOW',
  '....kOPPWWPPOOOOOoOOOW',
  '....kOOPPWPPOOOOOOOOWW',
  '....kOOPPPPOOOoOOOOOWW',
  '...kOOOOPPOOOOOOOOOOWW',
  '...kOOOOOOOOOOOOOOOWWW',
  '...kOoOOOOOOOOOOOOOWWW',
  '...kOOOOOOooooooOOOWWW',
  '...kOOOOOO--------OWWW',
  '...kOOOOOO--------OWWW',
  '..kOOOOOOO--------OWWW',
  '..kOoOOOOO--------OWWW',
  '..kOOOOOOO--------OWWW',
  '..kOOOOOOO--------OWWW',
  '..kOOOOOOO--------OWWW',
  '..kOOOOOOOOOOOOOOOOWWW',
  '..kOOOOOOOOOOOOOOWWWWW',
  'wwkOOOOOOOOOOWWWWWWNNN',
  '..kOOOOOOOWWWWWWWWWWnN',
  'wwkOOOOOWWWWWWWWWWWWWn',
  '..kOOOWWWWWWWWWWWmWWWm',
  '..kOOWWWWWWWWWWWWWmmmW',
  '.kOWWWWWWWWWWWWWWWWWWW',
  'kWWWWWWWWWWWWWWWWWWWWW',
  'kWWwWWWWWWWWWWWWWWWWWW',
  '.kWWwWWWWWWwWWWWWWWWWW',
  '..kWWWwWWWWWWwWWWWWWWW',
  '...kk.kkWkk.kkWkkk.kkk',
],
  eyeRow: 16,
  eyeCol: 10,
  eyes: {
  idle: ['OOkkkkOO', 'OkEEEEkO', 'kEHKKKEk', 'kEKKKKEk', 'kEKKKKEk', 'OkeKKekO', 'OOkkkkOO'],
  working: ['OOkkkkOO', 'OkEEEEkO', 'kEHKKEEk', 'kEEKKEEk', 'kEEKKEEk', 'OkeKKekO', 'OOkkkkOO'],
  thinking: ['OOOOOOOO', 'OOOOOOOO', 'OOOOOOOO', 'kOOOOOOk', 'OkkkkkkO', 'OOOOOOOO', 'OOOOOOOO'],
  error: ['OOOOOOOO', 'OkOOOOkO', 'OOkOOkOO', 'OOOkkOOO', 'OOkOOkOO', 'OkOOOOkO', 'OOOOOOOO'],
},
  // Freckles beside the nose, on the muzzle, under one eye and on the chin.
  markings: [
  [25, 16, 'F'],
  [25, 17, 'F'],
  [26, 16, 'F'],
  [27, 28, 'F'],
  [28, 30, 'F'],
  [23, 24, 'F'],
  [30, 23, 'F'],
  [30, 24, 'F'],
],
}

// 22×18 pixels: 22 columns, 9 lines.
const SMALL: Sprite = {
  left: [
    '..k........',
    '..kOk......',
    '.kOPOk.....',
    '.kOPPOkkkkk',
    '.kOPWPOOOOW',
    '.kOOPOOOOOW',
    'kOOOOooooOW',
    'kOO-----OWW',
    'kOO-----OWW',
    'kOO-----OWW',
    'kOO-----OWW',
    'kOOOOOOOWWW',
    'kOOOOWWWWNN',
    'kOOWWWWWWWn',
    'kOWWWWWWWWm',
    'kWWWWWWWmmW',
    '.kWWwWWWWWW',
    '..kkWkkWkkk',
  ],
  eyeRow: 7,
  eyeCol: 3,
  eyes: {
    idle: ['OkkkO', 'kEHKk', 'kEKKk', 'OkkkO'],
    working: ['OkkkO', 'kHKEk', 'kEKEk', 'OkkkO'],
    thinking: ['OOOOO', 'OOOOO', 'kOOOk', 'OkkkO'],
    error: ['OOOOO', 'OkOkO', 'OOkOO', 'OkOkO'],
  },
  markings: [
    [12, 8, 'F'],
    [13, 14, 'F'],
    [16, 11, 'F'],
  ],
}

// 12×12 pixels: 12 columns, 6 lines.
const TINY: Sprite = {
  left: [
    '.k....',
    'kPk...',
    'kPOkkk',
    'kOOOOW',
    'kOOOOW',
    'kO--OW',
    'kO--OW',
    'kOOWWN',
    'kOWWWm',
    'kWWWmW',
    '.kWWWW',
    '..kkkk',
  ],
  eyeRow: 5,
  eyeCol: 2,
  eyes: {
    idle: ['HK', 'KK'],
    working: ['EK', 'EK'],
    thinking: ['OO', 'kk'],
    error: ['kO', 'Ok'],
  },
  markings: [
    [7, 3, 'F'],
    [8, 8, 'F'],
    [10, 6, 'F'],
  ],
}

export type Size = 'tiny' | 'small' | 'big'
const SPRITES: Record<Size, Sprite> = { tiny: TINY, small: SMALL, big: BIG }

const mirror = (row: string) => row + [...row].reverse().join('')

export const width = (size: Size = 'tiny') => SPRITES[size].left[0]!.length * 2

export const pixels = (mood: Mood, size: Size = 'tiny'): string[][] => {
  const sprite = SPRITES[size]
  const full = sprite.left.map(row => [...mirror(row)])
  // Both eyes drawn unmirrored, so the highlights sit on the same side as
  // one light source would put them.
  const eye = sprite.eyes[mood]
  const rightCol = width(size) - sprite.eyeCol - eye[0]!.length
  eye.forEach((row, r) =>
    [...row].forEach((ch, i) => {
      full[sprite.eyeRow + r]![sprite.eyeCol + i] = ch
      full[sprite.eyeRow + r]![rightCol + i] = ch
    }),
  )
  for (const [r, c, ch] of sprite.markings) full[r]![c] = ch
  return full
}

// --- Terminal rendering ----------------------------------------------------

const fg = (c: RGB) => (truecolor ? `\x1b[38;2;${c.join(';')}m` : `\x1b[38;5;${to256(c)}m`)
const bg = (c: RGB) => (truecolor ? `\x1b[48;2;${c.join(';')}m` : `\x1b[48;5;${to256(c)}m`)
const RESET = '\x1b[0m'

/** The portrait as terminal lines, each `width(size)` columns wide. */
export const portrait = (mood: Mood = 'idle', size: Size = 'tiny'): string[] => {
  const grid = pixels(mood, size)
  const lines: string[] = []
  for (let y = 0; y < grid.length; y += 2) {
    let out = ''
    for (let x = 0; x < width(size); x++) {
      const top = PALETTE[grid[y]![x]!]
      const bottom = PALETTE[grid[y + 1]?.[x] ?? '.']
      if (top && bottom) out += fg(top) + bg(bottom) + '▀' + RESET
      else if (top) out += fg(top) + '▀' + RESET
      else if (bottom) out += fg(bottom) + '▄' + RESET
      else out += ' '
    }
    lines.push(out)
  }
  return lines
}

export { PALETTE }
