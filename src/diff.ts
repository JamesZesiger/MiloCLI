// Lines up the old and new text of an edit row by row for the side-by-side view.

export type Side = { n: number; text: string }
export type Row = { kind: 'same' | 'del' | 'add' | 'change'; left?: Side; right?: Side }

const MAX_CELLS = 4_000_000

export const align = (before: string, after: string): Row[] => {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')

  // Too big to diff properly: show the two sides next to each other.
  if (a.length * b.length > MAX_CELLS) {
    return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => ({
      kind: 'change' as const,
      left: i < a.length ? { n: i + 1, text: a[i]! } : undefined,
      right: i < b.length ? { n: i + 1, text: b[i]! } : undefined,
    }))
  }

  // Longest common subsequence, filled from the end.
  const width = b.length + 1
  const lcs = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * width + j] =
        a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)

  const rows: Row[] = []
  let dels: Side[] = []
  let adds: Side[] = []
  // A run of removed lines followed by added lines pairs up as changed lines.
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const left = dels[k]
      const right = adds[k]
      rows.push({ kind: left && right ? 'change' : left ? 'del' : 'add', left, right })
    }
    dels = []
    adds = []
  }

  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush()
      rows.push({ kind: 'same', left: { n: i + 1, text: a[i]! }, right: { n: j + 1, text: b[j]! } })
      i++
      j++
    } else if (j < b.length && (i >= a.length || lcs[i * width + j + 1]! >= lcs[(i + 1) * width + j]!)) {
      adds.push({ n: j + 1, text: b[j]! })
      j++
    } else {
      dels.push({ n: i + 1, text: a[i]! })
      i++
    }
  }
  flush()
  return rows
}
