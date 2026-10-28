import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { generateMindmap } from '../generator/mindmap.js'
import { generateFlowchart } from '../generator/flowchart.js'
import { isPathInside, realPathSmart, toDisplayPath } from '../lib/paths.js'

/**
 * Resolves whiteboard target path: defaults to unified whiteboard store
 * (~/.dsh/whiteboards), keeps subdirectory structure, and never escapes
 * registered workspace roots or the library.
 */
function resolveTargetPath(rawPath, defaultName, ctx, getWorkspaces, sessionCwd, getWhiteboardDir) {
  let name = (rawPath || '').trim() || defaultName
  if (!name.endsWith('.drawnix') && !name.endsWith('.drawnix.json')) {
    name += '.drawnix'
  }

  // LLM 偶尔会把绝对路径的首个 '/' 丢失（"Users/x" 而非 "/Users/x"）。
  // 只在候选确实存在时才提升为绝对路径，否则按相对路径处理。
  if (name.startsWith('Users/') || name.startsWith('home/')) {
    const candidate = '/' + name
    if (existsSync(candidate) || existsSync(dirname(candidate))) {
      name = candidate
    }
  }

  const whiteboardDir =
    (typeof getWhiteboardDir === 'function' ? getWhiteboardDir() : null) ||
    resolve(process.env.DSH_WHITEBOARD_DIR || join(homedir(), '.dsh', 'whiteboards'))

  const workspaces = getWorkspaces(ctx)
  const allowedRoots = [whiteboardDir, ...workspaces.map(ws => ws?.path).filter(Boolean)]
  if (sessionCwd && !allowedRoots.includes(sessionCwd)) {
    allowedRoots.push(sessionCwd)
  }

  // 绝对路径：必须在授权根内（realpath 已处理 symlink 逃逸），
  // 否则降级到白板库内的同名文件。
  if (isAbsolute(name)) {
    const target = realPathSmart(name)
    return allowedRoots.some(root => isPathInside(target, root))
      ? target
      : resolve(whiteboardDir, basename(target))
  }

  // 相对路径：保留子目录层级，落在白板库下；`..` 段会被 isPathInside 拒绝
  // 并降级为库内同名文件。
  const candidate = resolve(whiteboardDir, name)
  return isPathInside(candidate, whiteboardDir)
    ? candidate
    : resolve(whiteboardDir, basename(name))
}

/** Locate an existing .drawnix in whiteboard library or any registered workspace. */
function findExistingBoard(rawPath, ctx, getWorkspaces, sessionCwd, getWhiteboardDir) {
  const primary = resolveTargetPath(rawPath, '白板.drawnix', ctx, getWorkspaces, sessionCwd, getWhiteboardDir)
  if (existsSync(primary)) return primary
  if (!rawPath || isAbsolute(rawPath)) return primary

  const rel = String(rawPath).trim().replace(/^[/\\]+/, '')
  const workspaces = getWorkspaces(ctx)
  const searchRoots = [sessionCwd, ...workspaces.map(ws => ws?.path)].filter(Boolean)
  for (const root of searchRoots) {
    const candidate = resolve(root, rel)
    if (existsSync(candidate) && isPathInside(candidate, root)) {
      return candidate
    }
  }
  return primary
}

/** Shared write + broadcast + display-name pipeline for create/open tools. */
async function writeBoard(targetPath, boardData, broadcastEvent) {
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, JSON.stringify(boardData, null, 2), 'utf-8')

  const relPath = toDisplayPath(targetPath)
  if (typeof broadcastEvent === 'function') {
    broadcastEvent('OPEN_BOARD', {
      path: targetPath,
      relativePath: relPath,
      name: basename(targetPath),
    })
  }
  return { filePath: relPath, absolutePath: targetPath }
}

/** Build the shared `{ filePath, title }` parameter shape used by create tools. */
const FILE_PATH_PARAM = {
  type: 'string',
  description: '保存的文件相对路径，例如 docs/architecture.drawnix。若未指定或无后缀，自动补齐 .drawnix',
}

const SUCCESS_OUTPUT_PROPS = {
  success: { type: 'boolean' },
  filePath: { type: 'string' },
}

function successRender(template) {
  return (args, value) => [{ type: 'text', text: template(value) }]
}

/**
 * Registers DSH Agent Whiteboard Tools
 */
export function registerWhiteboardTools(ctx, options = {}) {
  const { broadcastEvent, getWorkspaces, getWhiteboardDir } = options

  ctx.inject(['tools'], (toolsScope) => {
    const tools = toolsScope.tools
    if (!tools || typeof tools.register !== 'function') {
      return
    }

    const sessionCwdOf = (exec) => exec?.agent?.session?.header?.cwd || null

    // 1. whiteboard_create_mindmap
    tools.register({
      name: 'whiteboard_create_mindmap',
      description: '在工作区生成交互式思维导图白板文件（.drawnix）并自动在右侧面板打开。适合头脑风暴、概念拆解、技术选型树、需求分类与功能大纲等树状发散结构。',
      parameters: {
        type: 'object',
        properties: {
          filePath: FILE_PATH_PARAM,
          title: { type: 'string', description: '思维导图中心主题标题，例如 "电商系统微服务架构"' },
          root: {
            type: 'object',
            description: '思维导图层级树对象',
            properties: {
              text: { type: 'string', description: '中心主题文本' },
              children: {
                type: 'array',
                description: '子分支列表，每个节点包含 text 和可选的子 children',
                items: {
                  type: 'object',
                  properties: { text: { type: 'string' }, children: { type: 'array' } },
                  required: ['text'],
                },
              },
            },
            required: ['text'],
          },
          layout: {
            type: 'string',
            enum: ['right', 'standard'],
            description: "思维导图展开方向：'right' (单侧右侧展开，默认) 或 'standard' (中心双侧发散)",
          },
        },
        required: ['root'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ...SUCCESS_OUTPUT_PROPS,
            absolutePath: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['success', 'filePath'],
          additionalProperties: false,
        },
        render: successRender(v => `✅ 已成功生成思维导图并保存至白板库：\`${v.filePath}\`\n已自动在右侧面板唤起白板展示，可在画布中自由缩放、拖拽与继续编辑。`),
      },
      async execute(args, exec) {
        try {
          const targetPath = resolveTargetPath(args.filePath, `${args.title || '思维导图'}.drawnix`, ctx, getWorkspaces, sessionCwdOf(exec), getWhiteboardDir)
          const result = await writeBoard(targetPath, generateMindmap(args), broadcastEvent)
          return { success: true, ...result, message: `成功生成思维导图文件 ${result.filePath}` }
        } catch (err) {
          throw new Error(`生成思维导图失败: ${err.message}`)
        }
      },
    })

    // 2. whiteboard_create_flowchart
    tools.register({
      name: 'whiteboard_create_flowchart',
      description: '在工作区生成交互式架构图/流程图白板文件（.drawnix）并自动在右侧面板打开。适合微服务系统架构、业务处理流水线、调用拓扑、有向流程与状态机流转。',
      parameters: {
        type: 'object',
        properties: {
          filePath: FILE_PATH_PARAM,
          title: { type: 'string', description: '架构图大标题（可选，显示在图表顶部居中）' },
          direction: { type: 'string', enum: ['TB', 'LR'], description: "排版流向：'TB' (从上到下，默认) 或 'LR' (从左到右)" },
          nodes: {
            type: 'array',
            description: '图表中的节点列表',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '节点唯一标识，例如 client, gateway, order_svc' },
                label: { type: 'string', description: '节点上显示的文字内容' },
                category: {
                  type: 'string',
                  enum: ['client', 'gateway', 'service', 'mq', 'storage', 'database', 'cache', 'decision', 'default'],
                  description: '节点语义类别（用于自动赋予现代专业主题配色与形状）',
                },
                shape: {
                  type: 'string',
                  enum: ['rectangle', 'roundRectangle', 'ellipse', 'diamond'],
                  description: '可选的显式形状覆盖',
                },
              },
              required: ['id', 'label'],
              additionalProperties: false,
            },
          },
          edges: {
            type: 'array',
            description: '节点之间的连线与关系',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string', description: '源节点 ID' },
                to: { type: 'string', description: '目标节点 ID' },
                label: { type: 'string', description: '连线说明文字（可选，例如 "HTTP API", "发布事件"）' },
              },
              required: ['from', 'to'],
              additionalProperties: false,
            },
          },
        },
        required: ['nodes', 'edges'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ...SUCCESS_OUTPUT_PROPS,
            absolutePath: { type: 'string' },
            nodeCount: { type: 'integer' },
            edgeCount: { type: 'integer' },
          },
          required: ['success', 'filePath', 'nodeCount', 'edgeCount'],
          additionalProperties: false,
        },
        render: successRender(v => `✅ 已成功生成架构图并保存至白板库：\`${v.filePath}\`（包含 ${v.nodeCount} 个节点，${v.edgeCount} 条连线）\n已自动在右侧面板唤起白板展示，可在画布中自由缩放、拖拽与继续编辑。`),
      },
      async execute(args, exec) {
        try {
          const targetPath = resolveTargetPath(args.filePath, `${args.title || '系统架构图'}.drawnix`, ctx, getWorkspaces, sessionCwdOf(exec), getWhiteboardDir)
          const result = await writeBoard(targetPath, generateFlowchart(args), broadcastEvent)
          return {
            success: true,
            ...result,
            nodeCount: (args.nodes || []).length,
            edgeCount: (args.edges || []).length,
          }
        } catch (err) {
          throw new Error(`生成架构图失败: ${err.message}`)
        }
      },
    })

    // 3. whiteboard_open_board
    tools.register({
      name: 'whiteboard_open_board',
      description: '在右侧面板打开并聚焦已存在的白板文件（.drawnix）。',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '白板库或工作区内的 .drawnix 白板文件名称或路径' },
        },
        required: ['filePath'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ...SUCCESS_OUTPUT_PROPS, message: { type: 'string' } },
          required: ['success', 'filePath'],
          additionalProperties: false,
        },
        render: successRender(v => `✅ 已在右侧白板面板打开：\`${v.filePath}\``),
      },
      async execute(args, exec) {
        const targetPath = findExistingBoard(args.filePath, ctx, getWorkspaces, sessionCwdOf(exec), getWhiteboardDir)
        if (!existsSync(targetPath)) {
          throw new Error(`找不到白板文件: ${args.filePath}`)
        }
        const relPath = toDisplayPath(targetPath)
        if (typeof broadcastEvent === 'function') {
          broadcastEvent('OPEN_BOARD', {
            path: targetPath,
            relativePath: relPath,
            name: basename(targetPath),
          })
        }
        return { success: true, filePath: relPath, message: `已在右侧白板面板打开 ${relPath}` }
      },
    })
  })
}
