// The mascot's portrait: pixel art drawn with half blocks (▀ ▄), two pixels
// per character cell, in 24-bit color with a 256-color fallback. The cats
// share one sprite and differ in coat; with no mascot it's Claude's spark.
import { characterName } from './characters.js'
import type { Mood } from './milo.js'
import { to256, truecolor, type RGB } from './theme.js'

type Palette = Record<string, RGB>

const MILO: Palette = {
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

// Boo is a tortoiseshell: black fur brindled with brown, a peach blaze over
// one side of her forehead and down her nose, a peach chin, pale yellow-green
// eyes, pale tufts in big dark ears, and a blue collar with a round tag.
const BOO: Palette = {
  k: [10, 8, 8], //      outline
  O: [62, 50, 47], //    black fur
  o: [44, 35, 33], //    black fur, shaded
  W: [67, 54, 50], //    black fur, where Milo is white
  w: [132, 90, 62], //   brown brindle
  P: [80, 63, 60], //    inner ear
  T: [206, 196, 184], // ear tufts
  E: [220, 230, 168], // yellow-green eye
  e: [172, 188, 116], // yellow-green eye, shaded
  K: [8, 6, 6], //       pupil
  H: [255, 255, 255], // eye highlight
  N: [18, 14, 14], //    nose
  n: [30, 24, 24], //    nose, shaded
  m: [14, 11, 11], //    mouth
  F: [224, 168, 116], // peach
  f: [170, 114, 72], //  peach, shaded
  V: [236, 234, 228], // whiskers
  B: [56, 82, 156], //   collar
  D: [196, 66, 88], //   collar pattern
  S: [176, 178, 184], // tag ring
  G: [236, 230, 204], // tag
}

const CLAUDE: Palette = {
  C: [217, 119, 87], //  Claude's orange
  c: [158, 92, 70], //   thinking
  R: [214, 72, 64], //   error
}

// Left halves are mirrored to full width. '.' is transparent; '-' marks the
// cells each eye is drawn over.

type Sprite = {
  left: string[]
  eyeRow: number
  eyeCol: number
  /** Eye cells per mood. */
  eyes: Record<Mood, string[]>
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
}

export type Size = 'tiny' | 'small' | 'big'
const SPRITES: Record<Size, Sprite> = { tiny: TINY, small: SMALL, big: BIG }

// --- Coats: each cat's colors and the markings that aren't symmetric --------

type Mark = [row: number, column: number, color: string]

/** A run of one color along a row, from one column to another. */
const run = (row: number, from: number, to: number, color: string): Mark[] =>
  Array.from({ length: to - from + 1 }, (_, i) => [row, from + i, color])

/** The same marks on both sides of a sprite `width` pixels wide. */
const both = (width: number, marks: Mark[]): Mark[] => marks.flatMap(([r, c, ch]): Mark[] => [[r, c, ch], [r, width - 1 - c, ch]])

type Coat = { palette: Palette; markings: Record<Size, Mark[]> }

const COATS = {
  // Freckles beside the nose, on the muzzle, under one eye and on the chin.
  milo: {
    palette: MILO,
    markings: {
      big: [
        [25, 16, 'F'],
        [25, 17, 'F'],
        [26, 16, 'F'],
        [27, 28, 'F'],
        [28, 30, 'F'],
        [23, 24, 'F'],
        [30, 23, 'F'],
        [30, 24, 'F'],
      ],
      small: [
        [12, 8, 'F'],
        [13, 14, 'F'],
        [16, 11, 'F'],
      ],
      tiny: [
        [7, 3, 'F'],
        [8, 8, 'F'],
        [10, 6, 'F'],
      ],
    },
  },
  // Her blaze covers the left of the forehead, from the ear to the middle,
  // and narrows to a stripe down the nose; the rest is brindle, the chin, the
  // collar and its tag. Tufts and whiskers are drawn on both sides.
  boo: {
    palette: BOO,
    markings: {
      big: [
        ...both(44, [[6, 7, 'T'], [7, 7, 'T'], [8, 8, 'T'], [9, 8, 'T'], [9, 9, 'T'], [10, 9, 'T'], [11, 10, 'T']]),
        ...both(44, [[25, 0, 'V'], [25, 1, 'V'], [27, 0, 'V'], [27, 1, 'V']]),
        ...run(7, 17, 21, 'F'),
        ...run(8, 15, 21, 'F'),
        ...run(9, 14, 21, 'F'),
        ...run(10, 13, 21, 'F'),
        ...run(11, 13, 21, 'F'),
        ...run(12, 12, 21, 'F'),
        ...run(13, 12, 21, 'F'),
        ...run(14, 14, 21, 'F'),
        ...run(15, 16, 21, 'F'),
        ...run(16, 18, 21, 'F'),
        ...run(17, 18, 21, 'F'),
        ...run(18, 19, 21, 'F'),
        ...run(19, 19, 21, 'F'),
        ...run(20, 20, 21, 'F'),
        ...run(21, 20, 21, 'F'),
        ...run(22, 20, 21, 'F'),
        ...run(23, 21, 21, 'F'),
        ...run(24, 21, 21, 'f'),
        [11, 12, 'f'],
        [12, 11, 'f'],
        [13, 11, 'f'],
        [14, 12, 'f'],
        [14, 13, 'f'],
        [15, 13, 'f'],
        [15, 15, 'f'],
        [16, 17, 'f'],
        [12, 22, 'f'],
        [14, 27, 'w'],
        [13, 30, 'w'],
        [15, 32, 'w'],
        [12, 33, 'w'],
        [23, 7, 'w'],
        [24, 9, 'w'],
        [26, 35, 'w'],
        [27, 33, 'w'],
        ...run(29, 21, 22, 'F'),
        ...run(30, 19, 24, 'F'),
        ...run(31, 1, 42, 'B'),
        ...[4, 9, 14, 19, 29, 34, 39].map((col): Mark => [31, col, 'D']),
        ...run(32, 25, 26, 'S'),
        ...run(33, 24, 27, 'G'),
        ...run(34, 24, 27, 'G'),
        ...run(35, 25, 26, 'G'),
        [33, 6, 'w'],
        [34, 14, 'w'],
        [33, 35, 'w'],
      ],
      small: [
        ...both(22, [[3, 3, 'T'], [4, 4, 'T']]),
        ...run(4, 6, 10, 'F'),
        ...run(5, 6, 10, 'F'),
        ...run(6, 7, 10, 'F'),
        ...run(7, 8, 10, 'F'),
        ...run(8, 9, 10, 'F'),
        ...run(9, 9, 10, 'F'),
        ...run(10, 10, 10, 'F'),
        ...run(11, 10, 10, 'f'),
        [6, 5, 'f'],
        [6, 14, 'w'],
        [12, 17, 'w'],
        ...run(15, 10, 11, 'F'),
        ...run(16, 1, 20, 'B'),
        ...[3, 7, 15, 18].map((col): Mark => [16, col, 'D']),
        ...run(17, 12, 13, 'G'),
      ],
      tiny: [
        ...both(12, [[1, 1, 'T']]),
        ...run(3, 2, 5, 'F'),
        ...run(4, 4, 5, 'F'),
        [5, 5, 'F'],
        [6, 5, 'f'],
        [4, 8, 'w'],
        ...run(9, 5, 6, 'F'),
        ...run(10, 1, 10, 'B'),
        [10, 3, 'D'],
        [10, 8, 'D'],
        ...run(11, 6, 7, 'G'),
      ],
    },
  },
} satisfies Record<string, Coat>

// --- Claude's spark, drawn to fill the same box as the cats ----------------

// Twelve rays of uneven length, like Claude's mark.
const RAYS = [1, 0.78, 0.94, 0.72, 1, 0.84, 0.9, 0.76, 0.98, 0.8, 0.92, 0.74]

const spark = (mood: Mood, size: Size): string[][] => {
  const w = width(size)
  const h = SPRITES[size].left.length
  const radius = Math.min(w, h) / 2
  const color = mood === 'error' ? 'R' : mood === 'thinking' ? 'c' : 'C'
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => {
      const dx = x + 0.5 - w / 2
      const dy = y + 0.5 - h / 2
      const d = Math.hypot(dx, dy) / radius
      if (d < 0.15) return color
      // How far around the circle, in rays, and so the nearest ray and how
      // many pixels off its center line this one is.
      const at = ((Math.atan2(dy, dx) / (2 * Math.PI) + 1) * RAYS.length) % RAYS.length
      const ray = Math.round(at) % RAYS.length
      const off = (Math.abs(at - Math.round(at)) * 2 * Math.PI * d * radius) / RAYS.length
      const length = RAYS[ray]!
      const half = 0.35 + radius * 0.09 * (1 - d / length)
      return d < length && off < half ? color : '.'
    }),
  )
}

const mirror = (row: string) => row + [...row].reverse().join('')

export const width = (size: Size = 'tiny') => SPRITES[size].left[0]!.length * 2

export const pixels = (mood: Mood, size: Size = 'tiny'): string[][] => {
  const name = characterName()
  if (name === 'none') return spark(mood, size)
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
  for (const [r, c, ch] of COATS[name].markings[size]) full[r]![c] = ch
  return full
}

// --- Terminal rendering ----------------------------------------------------

const fg = (c: RGB) => (truecolor ? `\x1b[38;2;${c.join(';')}m` : `\x1b[38;5;${to256(c)}m`)
const bg = (c: RGB) => (truecolor ? `\x1b[48;2;${c.join(';')}m` : `\x1b[48;5;${to256(c)}m`)
const RESET = '\x1b[0m'

const currentPalette = (): Palette => {
  const name = characterName()
  return name === 'none' ? CLAUDE : COATS[name].palette
}

/** The portrait as terminal lines, each `width(size)` columns wide. */
export const portrait = (mood: Mood = 'idle', size: Size = 'tiny'): string[] => {
  const grid = pixels(mood, size)
  const palette = currentPalette()
  const lines: string[] = []
  for (let y = 0; y < grid.length; y += 2) {
    let out = ''
    for (let x = 0; x < width(size); x++) {
      const top = palette[grid[y]![x]!]
      const bottom = palette[grid[y + 1]?.[x] ?? '.']
      if (top && bottom) out += fg(top) + bg(bottom) + '▀' + RESET
      else if (top) out += fg(top) + '▀' + RESET
      else if (bottom) out += fg(bottom) + '▄' + RESET
      else out += ' '
    }
    lines.push(out)
  }
  return lines
}
