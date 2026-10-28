import { useState, useRef, useEffect, createElement } from 'react'

const DRAWNIX_ID = '@kewen/dsh-whiteboard-plus'
const LEGACY_DRAWNIX_ID = '@kewen/dsh-drawnix'
const DRAWNIX_KIND = 'drawnix'
/** 主区全局面板 id（和「扩展」「定时任务」同级，layout.selectPanel 用它切换） */
const WHITEBOARD_PANEL_ID = 'whiteboard'
/** 全局面板里的白板没有右侧栏 Tab，给它一个固定的身份，用来隔离它自己的「当前文件」记录 */
const PANEL_TAB_INFO = { tab: { id: 'whiteboard-panel' } }

let activeThemeSnapshotScheme: 'dark' | 'light' | null = null
const activeWhiteboardPanes = new Set<(forcedTheme?: 'dark' | 'light') => void>()

function broadcastThemeToAllWhiteboards(theme: 'dark' | 'light') {
  activeWhiteboardPanes.forEach((sync) => {
    try { sync(theme) } catch {}
  })
}

function getHostTheme(): 'dark' | 'light' {
  if (activeThemeSnapshotScheme === 'dark' || activeThemeSnapshotScheme === 'light') {
    return activeThemeSnapshotScheme
  }
  if (typeof document === 'undefined') return 'light'
  const doc = document.documentElement
  const body = document.body

  // 1. DSH 官方 ThemePresenter 规范探针（最高优先级）：
  // DSH 在深色模式下：body 具有 'data-ds-dark-theme'，且 doc.style.colorScheme 为 'dark'
  // DSH 在浅色模式下：body 会被彻底移除 'data-ds-dark-theme'，且 doc.style.colorScheme 为 'light'
  const colorScheme = doc?.style?.colorScheme
  if (colorScheme === 'dark') return 'dark'
  if (colorScheme === 'light') return 'light'

  const themeSource = doc?.getAttribute('data-ds-theme-source')
  if (themeSource === 'dark') return 'dark'
  if (themeSource === 'light') return 'light'

  if (body?.hasAttribute('data-ds-dark-theme')) return 'dark'

  // 2. 通用属性与 class 适配（兼容外部/独立模式）
  const docTheme = doc?.getAttribute('data-theme')
  const bodyTheme = body?.getAttribute('data-theme')
  if (docTheme === 'dark' || bodyTheme === 'dark' || doc?.getAttribute('data-color-mode') === 'dark') return 'dark'
  if (docTheme === 'light' || bodyTheme === 'light' || doc?.getAttribute('data-color-mode') === 'light') return 'light'

  if (doc?.classList?.contains('dark') || body?.classList?.contains('dark')) return 'dark'
  if (doc?.classList?.contains('light') || body?.classList?.contains('light')) return 'light'

  // 3. 在 DSH 宿主环境下，若已初始化渲染但 body 无 'data-ds-dark-theme'，确证为浅色模式
  if (body && (themeSource !== null || doc?.querySelector('meta[name="theme-color"]') || body.style.getPropertyValue('--dsw-content-font-size'))) {
    return 'light'
  }

  // 4. 仅在宿主完全未声明任何主题倾向时才兜底系统外观
  try {
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark'
    }
  } catch {}
  return 'light'
}

interface SlotsApi {
  inject(key: string, callback: () => () => void): void
  register(
    entry: {
      name: string
      id?: string
      key?: string
      order?: number
      priority?: number
      label?: string
      locale?: string
      inject?: (...args: any[]) => Record<string, unknown>
    },
    component: unknown,
  ): () => void
}

interface SidebarRightTabsApi {
  register(typeDef: {
    id: string
    kind: string
    multiple?: boolean
    priority?: string
    keepMounted?: boolean
    patterns?: string[]
    canOpen?: (address: string) => boolean
    title: (address?: string) => string
    guide?: Array<{
      id: string
      commandId?: string
      order?: number
      title: () => string
      description: () => string
      icon: unknown
    }>
  }): () => void
}

interface SidebarRightApi {
  openTab(kind: string, options?: { params?: Record<string, unknown>; paneId?: string }): void
  openResource(address: string, options?: { params?: Record<string, unknown>; kind?: string }): void
}

/** Parses DSH resource addresses like dsh-resource://file/session/<id>/<path> or dsh-resource://file/absolute/<path> */
function parseFileAddress(address?: string): { sessionId?: string; path?: string } | undefined {
  if (!address || typeof address !== 'string') return undefined
  if (!address.startsWith('dsh-resource://file/')) {
    if (address.toLowerCase().includes('.drawnix')) {
      try {
        const u = new URL(address)
        return { path: decodeURIComponent(u.pathname) }
      } catch {
        return { path: address }
      }
    }
    return undefined
  }
  try {
    const end = address.search(/[?#]/)
    const raw = address.slice(20, end === -1 ? undefined : end)
    const [scope, ...rest] = raw.split('/')
    if (scope === 'session') {
      const [sessionId, ...segments] = rest
      if (!sessionId || segments.length === 0) return undefined
      return {
        sessionId: decodeURIComponent(sessionId),
        path: segments.map(decodeURIComponent).join('/'),
      }
    }
    if (scope === 'absolute') {
      const unc = rest[0] === '' && rest.length > 1
      const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent)
      if (segments.length === 0 || segments[0] === '') return undefined
      if (unc) return { path: `//${segments.join('/')}` }
      const isDrive = /^[A-Za-z]:$/.test(segments[0])
      return { path: isDrive ? segments.join('/') : `/${segments.join('/')}` }
    }
    return { path: rest.map(decodeURIComponent).join('/') }
  } catch {}
  return undefined
}


/** Guide artwork icon displayed in the right sidebar new tab launcher */
export function GuideArtworkWhiteboard({ size = 36, className }: { size?: number; className?: string }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      className,
      viewBox: '0 0 36 36',
      fill: 'none',
      xmlns: 'http://www.w3.org/2000/svg',
      'aria-hidden': 'true',
    },
    createElement('rect', {
      x: 5,
      y: 7,
      width: 26,
      height: 20,
      rx: 3,
      stroke: 'var(--dsw-alias-brand, #3b82f6)',
      strokeWidth: 2,
    }),
    createElement('path', {
      d: 'M10 21L15 15L20 19L26 13',
      stroke: 'var(--dsw-alias-brand, #3b82f6)',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
    createElement('circle', {
      cx: 12,
      cy: 12,
      r: 1.5,
      fill: 'var(--dsw-alias-brand, #3b82f6)',
    }),
    createElement('path', {
      d: 'M13 27V30M23 27V30',
      stroke: 'var(--dsw-alias-brand, #3b82f6)',
      strokeWidth: 2,
      strokeLinecap: 'round',
    }),
  )
}

/** Converts an absolute or workspace path to a DSH-compliant resource URI */
export function toDshResourceAddress(filePath: string): string {
  if (!filePath || typeof filePath !== 'string') return ''
  if (filePath.startsWith('dsh-resource://')) return filePath
  const normalized = filePath.replace(/\\/g, '/')
  const unc = normalized.startsWith('//')
  const absolute = normalized.replace(/^\/+/, '')
  const encoded = absolute.split('/').map(segment => encodeURIComponent(segment).replace(/%3A/gi, ':')).join('/')
  return `dsh-resource://file/absolute/${unc ? '/' : ''}${encoded}`
}

const tabPathListeners = new Map<string, Set<() => void>>()
const tabPathMap = new Map<string, string>()

function setTabActivePath(tabId: string, path: string) {
  if (!tabId || !path) return
  if (tabPathMap.get(tabId) === path) return
  tabPathMap.set(tabId, path)
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`dsh_drawnix_tab_${tabId}`, path)
      localStorage.setItem('dsh_drawnix_active_file', path)
    }
  } catch {}
  const listeners = tabPathListeners.get(tabId)
  if (listeners) {
    listeners.forEach((fn) => {
      try { fn() } catch {}
    })
  }
}

/** Tab Title chip displayed on the tab bar */
export function DrawnixTitle(props?: { useTabInfo?: () => any }) {
  let tabInfo: any = null
  try {
    if (typeof props?.useTabInfo === 'function') {
      tabInfo = props.useTabInfo()
    }
  } catch {}

  const tabId = tabInfo?.tab?.id
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!tabId) return
    const onUpdate = () => setTick(t => t + 1)
    let set = tabPathListeners.get(tabId)
    if (!set) {
      set = new Set()
      tabPathListeners.set(tabId, set)
    }
    set.add(onUpdate)
    return () => {
      set?.delete(onUpdate)
      if (set?.size === 0) tabPathListeners.delete(tabId)
    }
  }, [tabId])

  const activeAddress = tabInfo?.tab?.navigation?.address || tabInfo?.tab?.contentId || ''
  const parsedFile = parseFileAddress(activeAddress)
  const dynamicPath = tabId ? tabPathMap.get(tabId) : null
  const localFallbackPath = typeof window !== 'undefined'
    ? ((tabId ? localStorage.getItem(`dsh_drawnix_tab_${tabId}`) : null) || localStorage.getItem('dsh_drawnix_active_file'))
    : null
  const targetPath = (tabInfo?.tab?.params?.path as string | undefined) || parsedFile?.path || dynamicPath || localFallbackPath || null

  let label: string | null = null
  if (targetPath) {
    label = targetPath.replace(/\\/g, '/').split('/').pop()?.replace(/\.drawnix(\.json)?$/i, '') || null
  }
  if (!label) {
    label = tabInfo?.tab?.title || '白板'
  }
  if (label === '白板' && dynamicPath) {
    label = dynamicPath.replace(/\\/g, '/').split('/').pop()?.replace(/\.drawnix(\.json)?$/i, '') || '白板'
  }

  return createElement(
    'span',
    {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '13px',
      },
      title: targetPath || label || 'DSH 白板',
    },
    createElement(
      'svg',
      {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        style: { flexShrink: 0 },
      },
      createElement('rect', {
        x: 2,
        y: 2,
        width: 12,
        height: 10,
        rx: 1.5,
        stroke: 'currentColor',
        strokeWidth: 1.2,
      }),
      createElement('path', {
        d: 'M5 9L7 7L10 10L12 8',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
      }),
    ),
    createElement('span', null, label),
  )
}

/** Whiteboard Body Pane hosting Drawnix */
export function DrawnixPane(props?: { useTabInfo?: () => any }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [loaded, setLoaded] = useState(false)
  const lastDispatchedPathRef = useRef<string | null>(null)
  const [currentTheme, setCurrentTheme] = useState<'dark' | 'light'>(() => getHostTheme())
  const currentThemeRef = useRef(currentTheme)
  currentThemeRef.current = currentTheme

  let tabInfo: any = null
  try {
    if (typeof props?.useTabInfo === 'function') {
      tabInfo = props.useTabInfo()
    }
  } catch {}

  const tabId = tabInfo?.tab?.id
  const activeAddress = tabInfo?.tab?.navigation?.address || tabInfo?.tab?.contentId || ''
  const parsedFile = parseFileAddress(activeAddress)
  const dynamicPath = tabId ? tabPathMap.get(tabId) : null
  const localFallbackPath = typeof window !== 'undefined'
    ? ((tabId ? localStorage.getItem(`dsh_drawnix_tab_${tabId}`) : null) || localStorage.getItem('dsh_drawnix_active_file'))
    : null
  const targetPath = (tabInfo?.tab?.params?.path as string | undefined) || parsedFile?.path || dynamicPath || localFallbackPath || null
  const targetPathRef = useRef(targetPath)
  targetPathRef.current = targetPath

  // iframe 生命周期内 src 固定（不含 file 参数）：文件切换通过 postMessage + ready 握手完成，
  // 避免改 src 触发整页 reload 导致的未决保存丢失与加载竞态。
  const [iframeSrc] = useState(() => {
    const initTheme = getHostTheme()
    return `/drawnix/index.html?theme=${initTheme}${tabId ? `&tabId=${encodeURIComponent(tabId)}` : ''}`
  })
  const iframeReadyRef = useRef(false)
  const pendingFileRef = useRef<string | null>(null)
  const dispatchSeqRef = useRef(0)

  const syncThemeToIframe = (forcedTheme?: 'dark' | 'light') => {
    try {
      const theme = forcedTheme || (activeThemeSnapshotScheme || getHostTheme())
      if (currentThemeRef.current !== theme) {
        setCurrentTheme(theme)
      }
      const iframe = iframeRef.current
      if (iframe) {
        if (iframe.contentDocument?.documentElement) {
          iframe.contentDocument.documentElement.setAttribute('data-theme', theme)
          iframe.contentDocument.documentElement.style.backgroundColor = theme === 'dark' ? '#151517' : '#ffffff'
          iframe.contentDocument.documentElement.style.colorScheme = theme
        }
        iframe.contentWindow?.postMessage({ type: 'DSH_THEME_CHANGE', theme }, '*')
      }
    } catch {}
  }

  const dispatchFileToIframe = (path: string) => {
    const seq = ++dispatchSeqRef.current
    pendingFileRef.current = path
    try {
      const iframe = iframeRef.current
      if (iframe && iframe.contentWindow && iframeReadyRef.current) {
        const msg = {
          type: 'DSH_OPEN_WHITEBOARD_FILE',
          path,
          force: true,
          seq,
        }
        iframe.contentWindow.postMessage(msg, '*')
        pendingFileRef.current = null
      }
      // 未 ready 时：pendingFileRef 保留，等 DSH_WHITEBOARD_READY 到来后补发
    } catch {}
  }

  // 监听该特定 iframe 内部发出的活动文档变更与手动主题切换通知
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // 严格校验消息来源：只接受当前 Tab 内部挂载的 iframe。
      // tabId 通过 URL 明文传入 iframe，不能作为身份凭据，只能用于日志/排查。
      const isFromMyIframe = event.source === iframeRef.current?.contentWindow
      if (!isFromMyIframe) return

      if (event.data && event.data.type === 'DSH_WHITEBOARD_READY') {
        iframeReadyRef.current = true
        // 待派发队列优先；iframe 内部仍会消费 URL 里的 ?file=/localStorage 兜底，
        // 这里只在宿主明确有 targetPath 时才主动派发，避免与 iframe 自恢复逻辑打架。
        // 用 ref 而非闭包变量——本 effect 只在 tabId 变化时重建，闭包里的 targetPath 会是旧值。
        const pending = pendingFileRef.current || targetPathRef.current
        if (pending) {
          pendingFileRef.current = null
          dispatchFileToIframe(pending)
        }
      } else if (event.data && event.data.type === 'DSH_WHITEBOARD_ACTIVE_FILE_CHANGED') {
        if (event.data.path && tabId) {
          lastDispatchedPathRef.current = event.data.path
          setTabActivePath(tabId, event.data.path)
        }
      } else if (event.data && event.data.type === 'DSH_WHITEBOARD_THEME_CHANGED' && event.data.theme) {
        const newTheme = event.data.theme
        if ((newTheme === 'dark' || newTheme === 'light') && currentThemeRef.current !== newTheme) {
          setCurrentTheme(newTheme)
        }
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [tabId])

  // 卸载时（切回会话、关闭 Tab）iframe 会被立即移除，它里面 600ms 防抖中的自动保存会丢失。
  // iframe 与宿主同源：卸载前同步取出未决保存，由宿主窗口代为写盘。
  useEffect(() => {
    const iframe = iframeRef.current
    return () => {
      try {
        const take = (iframe?.contentWindow as any)?.__dshTakePendingSave
        const pending = typeof take === 'function' ? take() : null
        if (pending && pending.path && pending.content) {
          fetch('/drawnix/api/save', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(pending),
          })
            .then((r) => {
              if (!r.ok) {
                return r.json().then((d) => {
                  console.warn('[dsh-drawnix] 卸载前保存被拒绝:', d?.error || r.status)
                })
              }
            })
            .catch((e) => console.warn('[dsh-drawnix] 卸载前保存失败:', e))
        }
      } catch {}
    }
  }, [])

  // 当外部点击文件或 Tab 地址更新时，通知 iframe 加载新文件。
  // 文件切换依赖 DSH_WHITEBOARD_READY 握手（iframe 初始化完成后主动索取），
  // 不依赖 iframe onLoad，因此 loaded 仅作为提示状态。
  useEffect(() => {
    if (!targetPath) return
    if (tabId) setTabActivePath(tabId, targetPath)
    if (lastDispatchedPathRef.current === targetPath) return

    lastDispatchedPathRef.current = targetPath
    dispatchFileToIframe(targetPath)
  }, [targetPath, tabId])

  useEffect(() => {
    const syncThisPane = (forcedTheme?: 'dark' | 'light') => {
      syncThemeToIframe(forcedTheme)
    }
    activeWhiteboardPanes.add(syncThisPane)

    let lastKnownHostTheme = getHostTheme()
    let observer: MutationObserver | null = null
    try {
      observer = new MutationObserver(() => {
        const cur = getHostTheme()
        if (cur !== lastKnownHostTheme) {
          lastKnownHostTheme = cur
          syncThemeToIframe(cur)
        }
      })
      if (typeof document !== 'undefined') {
        if (document.documentElement) {
          observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme', 'class', 'data-color-mode', 'data-ds-theme-source', 'style'],
          })
        }
        if (document.body) {
          observer.observe(document.body, {
            attributes: true,
            attributeFilter: ['data-theme', 'class', 'data-ds-dark-theme', 'data-color-mode', 'style'],
          })
        }
      }
    } catch {}

    let mql: MediaQueryList | null = null
    const handleMql = () => {
      const cur = getHostTheme()
      if (cur !== lastKnownHostTheme) {
        lastKnownHostTheme = cur
        syncThemeToIframe(cur)
      }
    }
    try {
      if (typeof window !== 'undefined' && window.matchMedia) {
        mql = window.matchMedia('(prefers-color-scheme: dark)')
        mql.addEventListener ? mql.addEventListener('change', handleMql) : mql.addListener(handleMql)
      }
    } catch {}

    return () => {
      activeWhiteboardPanes.delete(syncThisPane)
      observer?.disconnect()
      if (mql) {
        mql.removeEventListener ? mql.removeEventListener('change', handleMql) : mql.removeListener(handleMql)
      }
    }
  }, [])

  const bgBase = currentTheme === 'dark' ? '#151517' : '#ffffff'

  return createElement(
    'div',
    {
      style: {
        width: '100%',
        height: '100%',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        background: bgBase,
        overflow: 'hidden',
      },
    },
    createElement('iframe', {
      key: tabId || targetPath || 'whiteboard-pane',
      ref: iframeRef,
      src: iframeSrc,
      // @ts-ignore
      allowtransparency: 'true',
      onLoad: () => {
        setLoaded(true)
        // onLoad 仅标记 iframe 已挂载；文件分发统一走 DSH_WHITEBOARD_READY 握手，
        // 避免这里与握手双发导致 loadSeq 竞态。
      },
      style: {
        width: '100%',
        height: '100%',
        border: 'none',
        display: 'block',
        flex: 1,
        backgroundColor: bgBase,
      },
      title: 'Drawnix Whiteboard',
    }),
  )
}

/** 主区全局面板：与「扩展」「定时任务」同级，不依附任何会话 */
export function WhiteboardPanel() {
  return DrawnixPane({ useTabInfo: () => PANEL_TAB_INFO })
}

/** 官方侧栏面板列表里的白板图标 */
export function WhiteboardPanelIcon({ size = 18 }: { size?: number }) {
  return createElement(
    'svg',
    { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    createElement('rect', { x: 2, y: 2, width: 12, height: 10, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.2 }),
    createElement('path', { d: 'M5 9L7 7L10 10L12 8', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
  )
}

/** 挂载在普通文件文档查看器操作栏的“在白板中编辑”按钮 */
export function OpenInDrawnixAction({ absolutePath, ctx }: { absolutePath?: string; ctx?: any }) {
  if (!absolutePath || typeof absolutePath !== 'string') return null
  const lower = absolutePath.toLowerCase()
  if (!lower.endsWith('.drawnix') && !lower.endsWith('.drawnix.json')) return null

  const handleOpen = () => {
    try {
      const sidebarRight = ctx?.get('sidebarRight') || ctx?.sidebarRight
      if (sidebarRight && typeof sidebarRight.openResource === 'function') {
        sidebarRight.openResource(toDshResourceAddress(absolutePath))
      } else if (sidebarRight && typeof sidebarRight.openTab === 'function') {
        sidebarRight.openTab(DRAWNIX_KIND, { params: { path: absolutePath } })
      }
    } catch (e) {
      console.warn('[dsh-drawnix] failed to open in drawnix tab', e)
    }
  }

  return createElement(
    'button',
    {
      type: 'button',
      onClick: handleOpen,
      title: '在 Drawnix 白板中图形化编辑',
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '2px 8px',
        fontSize: '12px',
        color: 'var(--dsw-alias-brand, #3b82f6)',
        background: 'rgba(59, 130, 246, 0.1)',
        border: '1px solid rgba(59, 130, 246, 0.25)',
        borderRadius: '4px',
        cursor: 'pointer',
        fontWeight: 500,
        marginLeft: '6px',
        transition: 'all 0.15s ease',
      },
    },
    createElement(
      'svg',
      {
        width: 12,
        height: 12,
        viewBox: '0 0 16 16',
        fill: 'none',
        style: { flexShrink: 0 },
      },
      createElement('rect', {
        x: 2,
        y: 2,
        width: 12,
        height: 10,
        rx: 1.5,
        stroke: 'currentColor',
        strokeWidth: 1.4,
      }),
      createElement('path', {
        d: 'M5 9L7 7L10 10L12 8',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
      }),
    ),
    createElement('span', null, '在白板中编辑'),
  )
}

export const inject = [
  'slots',
  'sidebarRightTabs',
  'sidebarRight',
  'theme',
]

export function apply(ctx: any): void {
  try {
    // 监听 DSH 官方主题服务变更广播（0ms 极速响应）
    try {
      const themeService = ctx.get ? ctx.get('theme') : (ctx.theme || null)
      if (themeService) {
        try {
          const snapshot = typeof themeService.getTheme === 'function' ? themeService.getTheme() : null
          const scheme = snapshot?.active?.colorScheme || (snapshot?.preference === 'dark' ? 'dark' : (snapshot?.preference === 'light' ? 'light' : null))
          if (scheme === 'dark' || scheme === 'light') {
            activeThemeSnapshotScheme = scheme
          }
        } catch {}

        if (typeof ctx.on === 'function') {
          ctx.effect(() => {
            const off = ctx.on('theme/change', (snapshot: any) => {
              const scheme = snapshot?.active?.colorScheme || (snapshot?.preference === 'dark' ? 'dark' : (snapshot?.preference === 'light' ? 'light' : null))
              if (scheme === 'dark' || scheme === 'light') {
                activeThemeSnapshotScheme = scheme
                broadcastThemeToAllWhiteboards(scheme)
              }
            })
            return () => {
              if (typeof off === 'function') off()
            }
          }, 'ui-sidebar-drawnix: theme listener')
        }
      }
    } catch (e) {
      console.warn('[dsh-drawnix] failed to bind theme listener:', e)
    }

    const tabs = (ctx.get ? ctx.get('sidebarRightTabs') : ctx.sidebarRightTabs) as SidebarRightTabsApi | undefined
    const slots = (ctx.get ? ctx.get('slots') : ctx.slots) as SlotsApi | undefined

    if (tabs) {
      ctx.effect(() => tabs.register({
        id: DRAWNIX_ID,
        kind: DRAWNIX_KIND,
        multiple: true,
        priority: 'extension',
        keepMounted: true,
        patterns: ['*.drawnix', '*.drawnix.json'],
        canOpen: (address: string) => {
          if (!address || typeof address !== 'string') return false
          const clean = address.split(/[?#]/)[0].toLowerCase()
          return clean.endsWith('.drawnix') || clean.endsWith('.drawnix.json')
        },
        title: (address?: string) => {
          if (address) {
            const parsed = parseFileAddress(address)
            if (parsed?.path) {
              const name = parsed.path.replace(/\\/g, '/').split('/').pop()?.replace(/\.drawnix(\.json)?$/i, '')
              if (name) return name
            }
          }
          return '白板'
        },
        guide: [{
          id: 'drawnix',
          commandId: 'drawnix.open',
          order: 40,
          title: () => '白板',
          description: () => 'Drawnix 架构图与思维导图白板',
          icon: GuideArtworkWhiteboard,
        }],
      }), 'ui-sidebar-drawnix: type registration')
    }

    if (slots) {
      // 注册右侧栏 Tab 页面主体：同时绑定 DRAWNIX_ID, LEGACY_DRAWNIX_ID 与 DRAWNIX_KIND 保证 100% 匹配 TabSlot
      slots.inject('sidebar.right.pane.tab', () => {
        const d1 = slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: DRAWNIX_ID,
          },
          DrawnixPane,
        )
        const d2 = slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: DRAWNIX_KIND,
          },
          DrawnixPane,
        )
        const d3 = slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: LEGACY_DRAWNIX_ID,
          },
          DrawnixPane,
        )
        return () => {
          d1()
          d2()
          d3()
        }
      })

      // 注册右侧栏 Tab 标题
      slots.inject('sidebar.right.pane.tab.title', () => {
        const d1 = slots.register(
          {
            name: 'sidebar.right.pane.tab.title',
            key: DRAWNIX_ID,
          },
          DrawnixTitle,
        )
        const d2 = slots.register(
          {
            name: 'sidebar.right.pane.tab.title',
            key: DRAWNIX_KIND,
          },
          DrawnixTitle,
        )
        const d3 = slots.register(
          {
            name: 'sidebar.right.pane.tab.title',
            key: LEGACY_DRAWNIX_ID,
          },
          DrawnixTitle,
        )
        return () => {
          d1()
          d2()
          d3()
        }
      })

      // 注册主区全局面板：左侧栏点「白板」时用 layout.selectPanel 切过来，点任意会话自动切回
      slots.inject('main', () => slots.register(
        {
          name: 'main',
          key: WHITEBOARD_PANEL_ID,
        },
        WhiteboardPanel,
      ))
      slots.inject('sidebar.panellist', () => slots.register(
        {
          name: 'sidebar.panellist',
          id: WHITEBOARD_PANEL_ID,
          order: 30,
          label: () => '白板',
        } as any,
        WhiteboardPanelIcon,
      ))

      // 注册文档预览操作栏按钮（普通文档查看器中打开 .drawnix 时展示快捷切换）
      slots.inject('sidebar.right.tab.document.actions', () => {
        return slots.register(
          {
            name: 'sidebar.right.tab.document.actions',
            id: 'dsh-drawnix-doc-action',
            inject: () => ({ ctx }),
          },
          OpenInDrawnixAction,
        )
      })

      slots.inject('sidebar.right.tab.document.unpreviewable', () => {
        return slots.register(
          {
            name: 'sidebar.right.tab.document.unpreviewable',
            id: 'dsh-drawnix-unpreviewable-action',
            inject: () => ({ ctx }),
          },
          OpenInDrawnixAction,
        )
      })
    }

    // 监听后端广播的 OPEN_BOARD 事件，当 Agent 生成新画板时自动唤起右侧白板面板展示
    if (typeof window !== 'undefined' && typeof EventSource !== 'undefined') {
      ctx.effect(() => {
        let sse: EventSource | null = null
        try {
          sse = new EventSource('/drawnix/api/events')
          const handleOpenBoard = (e: MessageEvent) => {
            try {
              const data = JSON.parse(e.data)
              if (data && data.path) {
                const sidebarRight = ctx.get('sidebarRight') as SidebarRightApi | undefined
                if (sidebarRight && typeof sidebarRight.openResource === 'function') {
                  const resourceUri = toDshResourceAddress(data.path)
                  sidebarRight.openResource(resourceUri)
                } else if (sidebarRight && typeof sidebarRight.openTab === 'function') {
                  sidebarRight.openTab(DRAWNIX_KIND, { params: { path: data.path } })
                }
              }
            } catch (err) {
              console.warn('[dsh-drawnix] sse OPEN_BOARD dispatch error:', err)
            }
          }
          sse.addEventListener('OPEN_BOARD', handleOpenBoard)

          return () => {
            sse?.removeEventListener('OPEN_BOARD', handleOpenBoard)
            sse?.close()
          }
        } catch (err) {
          console.warn('[dsh-drawnix] failed to initialize SSE in client host:', err)
        }
      }, 'ui-sidebar-drawnix: sse event listener')
    }
  } catch (e) {
    console.warn('[dsh-drawnix] slot registration failed', e)
  }
}
