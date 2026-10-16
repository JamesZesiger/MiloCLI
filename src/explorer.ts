// The file explorer: the working folder as a tree of rows, with the folders
// the user has opened listed under their parent.
import { readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

export type Row = { path: string; name: string; depth: number; dir: boolean }

// Git's own files are never worth browsing.
const HIDDEN = new Set(['.git'])

const isDir = (entry: Dirent, path: string) => {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return statSync(path).isDirectory()
  } catch {
    return false // a broken link
  }
}

/** A folder's entries: folders first, then files, each sorted by name. */
const list = (folder: string, depth: number): Row[] => {
  let entries: Dirent[]
  try {
    entries = readdirSync(folder, { withFileTypes: true })
  } catch {
    return [] // gone, or not ours to read
  }
  return entries
    .filter(entry => !HIDDEN.has(entry.name))
    .map(entry => {
      const path = join(folder, entry.name)
      return { path, name: entry.name, depth, dir: isDir(entry, path) }
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }))
}

/** Every row to show: `root`'s entries, and those of each open folder under it. */
export const treeRows = (root: string, open: ReadonlySet<string>): Row[] => {
  const walk = (folder: string, depth: number): Row[] =>
    list(folder, depth).flatMap(row => [row, ...(row.dir && open.has(row.path) ? walk(row.path, depth + 1) : [])])
  return walk(root, 0)
}
