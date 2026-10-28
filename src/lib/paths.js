import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path'

/**
 * Resolve a path to its canonical form, following symlinks for the deepest
 * existing ancestor so that not-yet-created files inside symlinked
 * directories are still evaluated against their real location.
 */
export function realPathSmart(p) {
  let cur = resolve(p)
  const missing = []
  while (!existsSync(cur)) {
    const parent = dirname(cur)
    if (parent === cur) break
    missing.push(basename(cur))
    cur = parent
  }
  try {
    cur = realpathSync(cur)
  } catch {}
  for (let i = missing.length - 1; i >= 0; i--) {
    cur = join(cur, missing[i])
  }
  return cur
}

/**
 * Check if `child` resolves to a location inside `parent`.
 * Symlink-aware via `realPathSmart`, which already canonicalizes case on
 * case-insensitive filesystems (macOS/Windows realpathSync returns the
 * on-disk casing). No case-folded string compare — that would bypass
 * containment on case-sensitive filesystems (Linux, case-sensitive APFS).
 */
export function isPathInside(child, parent) {
  if (!child || !parent) return false
  const rParent = realPathSmart(parent)
  const rChild = realPathSmart(child)
  if (rParent === rChild) return true
  const rel = relative(rParent, rChild)
  return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Sanitize an incoming file name: strip directory segments on both
 * `/` and `\\` separators, reject control / traversal names.
 */
export function sanitizeFilename(rawName) {
  const cleaned = String(rawName || '').trim().replace(/\\/g, '/')
  const base = basename(cleaned)
  if (!base || base === '.' || base === '..' || base.includes('\0')) return ''
  // Reject characters that break HTML rendering or shell quoting in the file
  // list UI (dist-web renderFileList injects names into innerHTML).
  if (/[<>&"']/.test(base)) return ''
  return base
}

/**
 * Turn an absolute path into a `~`-abbreviated display form when under $HOME.
 */
export function toDisplayPath(targetPath) {
  try {
    const home = process.env.HOME || homedir()
    if (home && targetPath.startsWith(home)) {
      return '~' + targetPath.slice(home.length)
    }
  } catch {}
  return basename(targetPath)
}
