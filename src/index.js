import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { readdir, stat, readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises'
import { basename, relative, join, normalize, resolve, sep, dirname, extname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerWhiteboardTools } from './tools/index.js'
import { realPathSmart, isPathInside, sanitizeFilename } from './lib/paths.js'

const here = dirname(fileURLToPath(import.meta.url))
const distRoot = resolve(here, '../dist-web')
const distIndex = join(distRoot, 'index.html')

/** Retrieve the dedicated central whiteboard directory (~/.dsh/whiteboards) */
export function getWhiteboardDir() {
  const custom = process.env.DSH_WHITEBOARD_DIR
  const dir = custom ? resolve(custom) : resolve(join(homedir(), '.dsh', 'whiteboards'))
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {}
  }
  return dir
}

/** Active SSE clients connected to /drawnix/api/events */
const sseClients = new Set()

/** Broadcast an event to all connected SSE clients (e.g. host client & webview) */
function broadcastEvent(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of sseClients) {
    try {
      const ok = client.write(payload)
      if (!ok) {
        // backpressure: give it one drain cycle; if the socket is dead the
        // 'close' handler on req will remove it soon.
        client.once?.('drain', () => {})
      }
    } catch {
      sseClients.delete(client)
    }
  }
}

/** Resolve incoming file path against whiteboard library and registered workspaces */
function resolveFilePath(filePath, ctx, wsParam) {
  if (!filePath || typeof filePath !== 'string') return null
  // Callers already hand us plain strings (query param via searchParams.get,
  // JSON body fields, tool args). Do NOT decodeURIComponent again — that would
  // corrupt names that legitimately contain '%' (e.g. 'a%20b.drawnix').
  const decoded = filePath

  // Disallow null byte attacks
  if (decoded.includes('\0')) return null

  const whiteboardDir = getWhiteboardDir()
  const workspaces = getWorkspaces(ctx)
  let resolved = null

  if (isAbsolute(decoded)) {
    resolved = normalize(decoded)
  } else if (/^(Users|home|var|tmp|opt|private)\//.test(decoded)) {
    // LLM 偶尔会把绝对路径的首个 '/' 丢失（"Users/x" 而不是 "/Users/x"）。
    // 只在它确实指向已存在的文件时才当作绝对路径，否则留给相对路径解析。
    const candidate = '/' + decoded
    if (existsSync(candidate)) {
      resolved = normalize(candidate)
    }
  }

  if (!resolved) {
    if (wsParam) {
      resolved = resolve(wsParam, decoded)
    } else {
      // 优先在统一白板库中查找
      const libraryCandidate = resolve(whiteboardDir, decoded)
      if (existsSync(libraryCandidate)) {
        resolved = libraryCandidate
      } else {
        // 兼容在已注册工作区中查找
        for (const ws of workspaces) {
          if (ws && ws.path) {
            const candidate = resolve(ws.path, decoded)
            if (existsSync(candidate)) {
              resolved = candidate
              break
            }
          }
        }
        if (!resolved) {
          resolved = libraryCandidate
        }
      }
    }
  }

  // Security check 1: Extension must be .drawnix or .drawnix.json
  const lower = resolved.toLowerCase()
  if (!lower.endsWith('.drawnix') && !lower.endsWith('.drawnix.json')) {
    return null
  }

  // Security check 2: Must reside within whiteboard library or one of the registered workspaces
  // realPathSmart resolves symlinks so a symlink inside an allowed root cannot escape it.
  const allowedRoots = [whiteboardDir, ...workspaces.map(ws => ws.path).filter(Boolean)]
  const isAllowed = allowedRoots.some(root => isPathInside(resolved, root))
  if (!isAllowed) {
    return null
  }

  return resolved
}


const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export const manifest = {
  apiVersion: 'dsh-std/v1',
  kind: 'Presentation',
  name: '@kewen/dsh-whiteboard-plus',
  version: '0.2.12',
}

/** Helper to parse JSON body from incoming HTTP request */
function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body)
  }
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
    try {
      return Promise.resolve(req.body ? JSON.parse(req.body.toString()) : {})
    } catch (err) {
      return Promise.reject(err)
    }
  }
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8')
        resolveBody(text ? JSON.parse(text) : {})
      } catch (err) {
        rejectBody(err)
      }
    })
    req.on('error', rejectBody)
    if (req.isPaused && req.isPaused()) {
      req.resume()
    }
  })
}

/** Retrieve available workspaces from DSH context or process.cwd() fallback */
function getWorkspaces(ctx) {
  const list = []
  try {
    const registry = ctx.get('workspaceRegistry') || ctx.workspaceRegistry
    if (registry) {
      const active = registry.current || (typeof registry.getActive === 'function' ? registry.getActive() : null)
      if (active?.path) {
        list.push({
          id: active.id || active.path,
          path: resolve(active.path),
          title: active.title || basename(active.path),
        })
      }
      if (typeof registry.list === 'function') {
        const items = registry.list()
        for (const item of items) {
          if (item?.path && !list.some(w => w.path === resolve(item.path))) {
            list.push({
              id: item.id || item.path,
              path: resolve(item.path),
              title: item.title || basename(item.path),
            })
          }
        }
      }
    }
  } catch {}

  const cwd = process.cwd()
  if (cwd && cwd !== '/' && !list.some(w => w.path === resolve(cwd))) {
    list.push({
      id: 'cwd',
      path: resolve(cwd),
      title: basename(cwd) || cwd,
    })
  }

  if (list.length === 0) {
    const home = process.env.HOME || '/tmp'
    list.push({
      id: 'fallback',
      path: resolve(home),
      title: 'Home',
    })
  }

  return list
}

/** Recursively find .drawnix or .drawnix.json files in target directory */
async function findDrawnixFiles(dir, maxDepth = 6, currentDepth = 0) {
  if (currentDepth > maxDepth) return []
  const files = []
  const IGNORE = new Set([
    'node_modules', '.git', '.next', 'dist', 'dist-web', 'build',
    '.dsh', '.vscode', '.idea', '.cache', '.turbo', 'coverage',
  ])

  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.drawnix') continue
      if (IGNORE.has(entry.name)) continue

      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        const sub = await findDrawnixFiles(fullPath, maxDepth, currentDepth + 1)
        files.push(...sub)
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase()
        if (lower.endsWith('.drawnix') || lower.endsWith('.drawnix.json')) {
          try {
            const st = await stat(fullPath)
            files.push({
              name: entry.name,
              path: fullPath,
              relativePath: relative(dir, fullPath),
              size: st.size,
              mtime: st.mtimeMs,
            })
          } catch {}
        }
      }
    }
  } catch {}
  return files.sort((a, b) => b.mtime - a.mtime)
}

function getCorsHeaders(req) {
  const headers = {}
  const origin = req?.headers?.origin
  if (origin) {
    try {
      const u = new URL(origin)
      if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]' || u.hostname === '::1') {
        headers['access-control-allow-origin'] = origin
        headers['access-control-allow-methods'] = 'GET, POST, OPTIONS'
        headers['access-control-allow-headers'] = 'content-type'
        headers['access-control-allow-credentials'] = 'true'
      }
    } catch {}
  }
  return headers
}

function sendJson(res, statusCode, data, req) {
  const cors = getCorsHeaders(req)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache, no-store, must-revalidate',
    ...cors,
  })
  res.end(JSON.stringify(data))
}

export function apply(ctx) {
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: '/drawnix',
      handler: async (req, res) => {
        // Handle CORS Preflight
        if (req.method === 'OPTIONS') {
          const cors = getCorsHeaders(req)
          res.writeHead(204, cors)
          res.end()
          return
        }

        // CSRF guard: browsers send Origin on every cross-site request
        // (including no-cors simple POSTs). Reject mutating verbs whose
        // Origin is present and not loopback. GET/OPTIONS stay open — they
        // only read data and legitimately run from the loopback SPA.
        const reqOrigin = req?.headers?.origin
        if (req.method !== 'GET' && req.method !== 'OPTIONS' && req.method !== 'HEAD' && reqOrigin) {
          let originHost = ''
          try { originHost = new URL(reqOrigin).hostname } catch {}
          const isLoopback = originHost === '127.0.0.1' || originHost === 'localhost' || originHost === '[::1]' || originHost === '::1'
          if (!isLoopback) {
            sendJson(res, 403, { error: 'Forbidden: cross-origin mutation' }, req)
            return
          }
        }

        const rawUrl = new URL(req.url ?? '/', 'http://x')
        const rawPath = rawUrl.pathname
        let relativePath = rawPath.slice('/drawnix'.length)
        if (relativePath === '' || relativePath === '/') {
          relativePath = '/index.html'
        }

        // ============================================================
        // REST APIs: Workspace & Whiteboard Document Management
        // ============================================================
        if (relativePath.startsWith('/api/')) {
          const apiPath = relativePath.slice('/api'.length)

          try {
            // 1. GET /drawnix/api/workspace: Returns active whiteboard library & all known workspaces
            if (apiPath === '/workspace' && req.method === 'GET') {
              const whiteboardDir = getWhiteboardDir()
              const workspaces = getWorkspaces(ctx)
              const home = homedir()
              const displayPath = whiteboardDir.startsWith(home) ? ('~' + whiteboardDir.slice(home.length)) : whiteboardDir
              const current = {
                id: 'library',
                path: whiteboardDir,
                title: '我的白板库',
                displayPath,
              }
              sendJson(res, 200, { current, whiteboardDir, workspaces }, req)
              return
            }

            // 2. GET /drawnix/api/files: Lists all .drawnix files in unified whiteboard library
            if (apiPath === '/files' && req.method === 'GET') {
              const wsParam = rawUrl.searchParams.get('workspace')
              const whiteboardDir = getWhiteboardDir()
              const workspaces = getWorkspaces(ctx)

              let targetDir = whiteboardDir
              if (wsParam && wsParam !== 'all' && wsParam !== 'library') {
                targetDir = resolve(wsParam)
                const allowedRoots = [whiteboardDir, ...workspaces.map(ws => ws.path).filter(Boolean)]
                const isAllowedWs = allowedRoots.some(root => isPathInside(targetDir, root))
                if (!isAllowedWs) {
                  sendJson(res, 403, { error: 'Access denied: Directory not authorized' }, req)
                  return
                }
              }

              // Follow symlinks so findDrawnixFiles cannot escape allowed roots
              targetDir = realPathSmart(targetDir)
              const files = await findDrawnixFiles(targetDir, 2)
              sendJson(res, 200, {
                workspace: targetDir,
                whiteboardDir,
                files
              }, req)
              return
            }

            // 3. GET /drawnix/api/file: Reads a .drawnix file safely
            if (apiPath === '/file' && req.method === 'GET') {
              const filePath = rawUrl.searchParams.get('path')
              const wsParam = rawUrl.searchParams.get('workspace')
              if (!filePath) {
                sendJson(res, 400, { error: 'Missing path parameter' }, req)
                return
              }
              const resolved = resolveFilePath(filePath, ctx, wsParam)
              if (!resolved) {
                sendJson(res, 403, { error: `无权访问或路径不在工作区内: ${filePath}` }, req)
                return
              }
              if (!existsSync(resolved)) {
                sendJson(res, 404, { error: `File not found: ${filePath}` }, req)
                return
              }
              const contentStr = await readFile(resolved, 'utf-8')
              let json = null
              try {
                if (contentStr.trim()) {
                  const parsed = JSON.parse(contentStr)
                  if (Array.isArray(parsed)) {
                    json = { children: parsed }
                  } else if (parsed && typeof parsed === 'object') {
                    json = parsed
                    if (json.elements && !json.children) {
                      json.children = json.elements
                    }
                  }
                } else {
                  json = {
                    type: 'drawnix',
                    version: 1,
                    source: 'dsh',
                    children: [],
                    viewport: { zoom: 1 },
                  }
                }
              } catch (parseErr) {
                sendJson(res, 422, {
                  error: `文件 JSON 解析失败，内容可能损坏或被截断: ${parseErr.message}`,
                  corrupted: true,
                  name: basename(resolved),
                  path: resolved,
                }, req)
                return
              }

              if (!json) {
                sendJson(res, 422, {
                  error: '文件内容不是合法的画板 JSON 数据',
                  corrupted: true,
                  name: basename(resolved),
                  path: resolved,
                }, req)
                return
              }

              const st = await stat(resolved)
              sendJson(res, 200, {
                name: basename(resolved),
                path: resolved,
                content: json,
                mtime: st.mtimeMs,
              }, req)
              return
            }

            // 4. POST /drawnix/api/save: Saves whiteboard content to file safely
            if (apiPath === '/save' && req.method === 'POST') {
              const body = await readJsonBody(req)
              const { path: filePath, content, workspace: wsParam, mtime: expectedMtime, force } = body
              if (!filePath || !content || typeof content !== 'object' || Array.isArray(content)) {
                sendJson(res, 400, { error: 'Missing path or invalid content (must be a JSON object)' }, req)
                return
              }
              const resolved = resolveFilePath(filePath, ctx, wsParam)
              if (!resolved) {
                sendJson(res, 403, { error: `无权保存：目标路径超出工作区或文件类型不合法: ${filePath}` }, req)
                return
              }

              // Concurrency check: reject if the file's current mtime differs from what
              // the client last wrote/read (with a small epsilon for fs timestamp jitter).
              if (existsSync(resolved) && typeof expectedMtime === 'number' && !force) {
                try {
                  const currentSt = await stat(resolved)
                  if (Math.abs(currentSt.mtimeMs - expectedMtime) > 1000) {
                    sendJson(res, 409, {
                      error: '文件在外部已被修改，已中止保存以防止内容被覆盖。请重新加载画板以合并最新修改。',
                      conflict: true,
                      currentMtime: currentSt.mtimeMs,
                    }, req)
                    return
                  }
                } catch {}
              }

              // Preserve root metadata (type/version/source) so client edits are idempotent
              let existingMeta = {
                type: 'drawnix',
                version: 1,
                source: 'dsh',
              }
              if (existsSync(resolved)) {
                try {
                  const raw = await readFile(resolved, 'utf-8')
                  const parsed = JSON.parse(raw)
                  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    if (parsed.type) existingMeta.type = parsed.type
                    if (parsed.version) existingMeta.version = parsed.version
                    if (parsed.source) existingMeta.source = parsed.source
                  }
                } catch {}
              }

              const mergedContent = {
                ...existingMeta,
                ...content,
              }

              await mkdir(dirname(resolved), { recursive: true })
              await writeFile(resolved, JSON.stringify(mergedContent, null, 2), 'utf-8')
              const st = await stat(resolved)
              sendJson(res, 200, {
                success: true,
                path: resolved,
                name: basename(resolved),
                mtime: st.mtimeMs,
              }, req)
              return
            }

            // 5. POST /drawnix/api/create: Creates a new .drawnix file (defaults to whiteboard library)
            if (apiPath === '/create' && req.method === 'POST') {
              const body = await readJsonBody(req)
              let { workspace: wsDir, filename, content } = body
              const whiteboardDir = getWhiteboardDir()
              const workspaces = getWorkspaces(ctx)
              if (!wsDir) {
                wsDir = whiteboardDir
              }
              wsDir = resolve(wsDir)
              const allowedRoots = [whiteboardDir, ...workspaces.map(ws => ws.path).filter(Boolean)]
              const isAllowedWs = allowedRoots.some(root => isPathInside(wsDir, root))
              if (!isAllowedWs) {
                sendJson(res, 403, { error: '无权在此目录创建文件' }, req)
                return
              }
              filename = sanitizeFilename(filename) || '白板.drawnix'
              if (!filename.endsWith('.drawnix') && !filename.endsWith('.drawnix.json')) {
                filename += '.drawnix'
              }
              const targetPath = resolve(join(wsDir, filename))
              if (!isPathInside(targetPath, wsDir)) {
                sendJson(res, 403, { error: '非法路径，禁止目录穿越' }, req)
                return
              }
              if (existsSync(targetPath)) {
                sendJson(res, 409, { error: `目标文件已存在: ${filename}` }, req)
                return
              }
              await mkdir(dirname(targetPath), { recursive: true })

              const initialContent = {
                type: 'drawnix',
                version: 1,
                source: 'dsh',
                children: [],
                elements: [],
                viewport: { zoom: 1 },
                ...(content || {}),
              }
              await writeFile(targetPath, JSON.stringify(initialContent, null, 2), 'utf-8')
              const st = await stat(targetPath)
              sendJson(res, 200, {
                success: true,
                path: targetPath,
                name: basename(targetPath),
                mtime: st.mtimeMs,
              }, req)
              return
            }

            // 6. POST /drawnix/api/rename: Renames an existing file
            if (apiPath === '/rename' && req.method === 'POST') {
              const body = await readJsonBody(req)
              const { oldPath, newName } = body
              if (!oldPath || !newName) {
                sendJson(res, 400, { error: 'Missing oldPath or newName' }, req)
                return
              }
              const resolvedOld = resolveFilePath(oldPath, ctx)
              if (!resolvedOld || !existsSync(resolvedOld)) {
                sendJson(res, 404, { error: '源文件不存在或无权访问' }, req)
                return
              }
              let targetName = sanitizeFilename(newName)
              if (!targetName) {
                sendJson(res, 400, { error: '非法文件名' }, req)
                return
              }
              const targetNameLower = targetName.toLowerCase()
              if (!targetNameLower.endsWith('.drawnix') && !targetNameLower.endsWith('.drawnix.json')) {
                targetName += '.drawnix'
              }
              const resolvedNew = join(dirname(resolvedOld), targetName)
              if (!resolveFilePath(resolvedNew, ctx)) {
                sendJson(res, 403, { error: '目标路径无权访问或不合法' }, req)
                return
              }
              if (existsSync(resolvedNew) && resolvedNew !== resolvedOld) {
                sendJson(res, 409, { error: `目标文件已存在: ${targetName}` }, req)
                return
              }
              await rename(resolvedOld, resolvedNew)
              sendJson(res, 200, {
                success: true,
                oldPath: resolvedOld,
                newPath: resolvedNew,
                name: targetName,
              }, req)
              return
            }

            // 7. POST /drawnix/api/delete: Deletes an existing .drawnix file safely
            if (apiPath === '/delete' && req.method === 'POST') {
              const body = await readJsonBody(req)
              const { path: targetReqPath } = body
              if (!targetReqPath) {
                sendJson(res, 400, { error: 'Missing path parameter' }, req)
                return
              }
              const resolved = resolveFilePath(targetReqPath, ctx)
              if (!resolved || !existsSync(resolved)) {
                sendJson(res, 404, { error: '文件不存在或无权访问' }, req)
                return
              }
              const resolvedLower = resolved.toLowerCase()
              if (!resolvedLower.endsWith('.drawnix') && !resolvedLower.endsWith('.drawnix.json')) {
                sendJson(res, 403, { error: '只能删除 .drawnix 白板文件' }, req)
                return
              }
              try {
                await unlink(resolved)
                broadcastEvent('file-deleted', { path: resolved, name: basename(resolved) })
                sendJson(res, 200, {
                  success: true,
                  deletedPath: resolved,
                  name: basename(resolved),
                }, req)
              } catch (err) {
                sendJson(res, 500, { error: `删除失败: ${err.message}` }, req)
              }
              return
            }

            // 8. GET /drawnix/api/events: SSE Stream for real-time board events (auto-reveal)
            if (apiPath === '/events' && req.method === 'GET') {
              const cors = getCorsHeaders(req)
              res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache, no-transform',
                'connection': 'keep-alive',
                ...cors,
              })
              res.write(': sse connected\n\n')
              sseClients.add(res)
              req.on('close', () => {
                sseClients.delete(res)
              })
              return
            }

            sendJson(res, 404, { error: `Unknown API endpoint: ${apiPath}` }, req)
            return
          } catch (err) {
            scope.logger?.warn?.(`[drawnix] api error: ${err.message}`)
            sendJson(res, 500, { error: 'Internal server error' }, req)
            return
          }
        }

        // ============================================================
        // Static Web Resource Serving
        // ============================================================
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }

        const target = resolve(normalize(join(distRoot, relativePath)))
        if (!target.startsWith(distRoot + sep) && target !== distIndex) {
          res.writeHead(403)
          res.end('Forbidden')
          return
        }

        try {
          const body = await readFile(target)
          const ext = extname(target).toLowerCase()
          const type = MIME[ext] ?? 'application/octet-stream'
          res.writeHead(200, {
            'content-type': type,
            'cache-control': (ext === '.html' || ext === '.css' || ext === '.js') ? 'no-cache, no-store, must-revalidate' : 'public, max-age=31536000, immutable',
          })
          if (req.method === 'HEAD') {
            res.end()
          } else {
            res.end(body)
          }
        } catch (error) {
          if (error.code === 'ENOENT') {
            res.writeHead(404)
            res.end('Not Found')
            return
          }
          scope.logger?.warn?.(`[drawnix] static file error: ${error.message}`)
          res.writeHead(500)
          res.end('Internal Server Error')
        }
      },
    }), 'drawnix: web static server route')
  })

  // 2. Register DSH Agent Whiteboard Tools
  registerWhiteboardTools(ctx, {
    broadcastEvent,
    getWorkspaces,
    resolveFilePath,
    getWhiteboardDir,
  })
}
