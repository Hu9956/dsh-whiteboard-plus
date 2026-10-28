import { resolveNodeTheme, generateId } from './theme.js'

/**
 * Computes topological layers for a directed graph of nodes and edges,
 * safely handling cycles (feedback loops) and reducing edge crossings.
 */
function computeLayers(nodes, edges) {
  const nodeMap = new Map()
  nodes.forEach(n => nodeMap.set(n.id, n))

  const adj = new Map()
  nodes.forEach(n => adj.set(n.id, []))

  edges.forEach(e => {
    if (nodeMap.has(e.from) && nodeMap.has(e.to) && e.from !== e.to) {
      adj.get(e.from).push(e.to)
    }
  })

  // DFS cycle detection to identify feedback back-edges
  const visited = new Map() // 0: unvisited, 1: visiting, 2: visited
  const backEdges = new Set()
  nodes.forEach(n => visited.set(n.id, 0))

  function dfs(u) {
    visited.set(u, 1)
    for (const v of adj.get(u) || []) {
      const state = visited.get(v)
      if (state === 1) {
        // Encountered an ancestor currently on DFS recursion stack -> cycle back-edge!
        backEdges.add(`${u}->${v}`)
      } else if (state === 0) {
        dfs(v)
      }
    }
    visited.set(u, 2)
  }

  // Prefer starting DFS from nodes that have lower in-degree (natural entry points)
  const rawInDegree = new Map()
  nodes.forEach(n => rawInDegree.set(n.id, 0))
  edges.forEach(e => {
    if (nodeMap.has(e.to)) {
      rawInDegree.set(e.to, (rawInDegree.get(e.to) || 0) + 1)
    }
  })

  const sortedEntryNodes = [...nodes].sort((a, b) => (rawInDegree.get(a.id) || 0) - (rawInDegree.get(b.id) || 0))
  sortedEntryNodes.forEach(n => {
    if (visited.get(n.id) === 0) dfs(n.id)
  })

  // Build forward DAG (excluding feedback back-edges)
  const dagAdj = new Map()
  const inDegree = new Map()
  nodes.forEach(n => {
    dagAdj.set(n.id, [])
    inDegree.set(n.id, 0)
  })

  edges.forEach(e => {
    if (nodeMap.has(e.from) && nodeMap.has(e.to) && e.from !== e.to) {
      if (!backEdges.has(`${e.from}->${e.to}`)) {
        dagAdj.get(e.from).push(e.to)
        inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1)
      }
    }
  })

  // Longest path ranking on DAG
  const ranks = new Map()
  let queue = []
  nodes.forEach(n => {
    if (inDegree.get(n.id) === 0) {
      ranks.set(n.id, 0)
      queue.push(n.id)
    }
  })

  // Fallback if entire DAG is a cycle
  if (queue.length === 0 && nodes.length > 0) {
    ranks.set(nodes[0].id, 0)
    queue.push(nodes[0].id)
  }

  while (queue.length > 0) {
    const current = queue.shift()
    const currentRank = ranks.get(current) || 0
    const neighbors = dagAdj.get(current) || []

    for (const next of neighbors) {
      const existingRank = ranks.get(next) ?? -1
      if (currentRank + 1 > existingRank) {
        ranks.set(next, currentRank + 1)
      }
      inDegree.set(next, (inDegree.get(next) || 0) - 1)
      if (inDegree.get(next) === 0) {
        queue.push(next)
      }
    }
  }

  // Assign any remaining unranked nodes
  nodes.forEach(n => {
    if (!ranks.has(n.id)) {
      ranks.set(n.id, 0)
    }
  })

  // Group nodes by layer
  const layerGroupsMap = new Map()
  nodes.forEach(n => {
    const r = ranks.get(n.id) || 0
    if (!layerGroupsMap.has(r)) layerGroupsMap.set(r, [])
    layerGroupsMap.get(r).push(n)
  })

  const sortedRanks = Array.from(layerGroupsMap.keys()).sort((a, b) => a - b)
  const layerGroups = sortedRanks.map(r => layerGroupsMap.get(r))

  // Barycenter crossing minimization:
  // For each layer, sort nodes by average horizontal position of connected predecessors
  const nodePositionInLayer = new Map()
  if (layerGroups.length > 0) {
    layerGroups[0].forEach((node, idx) => nodePositionInLayer.set(node.id, idx))
  }

  for (let l = 1; l < layerGroups.length; l++) {
    const currentLayer = layerGroups[l]
    currentLayer.forEach(node => {
      const predPositions = []
      edges.forEach(e => {
        if (e.to === node.id && nodePositionInLayer.has(e.from)) {
          predPositions.push(nodePositionInLayer.get(e.from))
        }
      })
      node.__barycenter = predPositions.length > 0
        ? predPositions.reduce((a, b) => a + b, 0) / predPositions.length
        : Number.POSITIVE_INFINITY
    })

    currentLayer.sort((a, b) => {
      const ba = a.__barycenter
      const bb = b.__barycenter
      if (ba === bb) return 0
      if (!Number.isFinite(ba)) return 1
      if (!Number.isFinite(bb)) return -1
      return ba - bb
    })
    currentLayer.forEach((node, idx) => {
      delete node.__barycenter
      nodePositionInLayer.set(node.id, idx)
    })
  }

  return {
    layerGroups,
    ranks,
    backEdges,
  }
}

/**
 * Calculates visual text width accounting for CJK characters and Latin/digits
 */
function getVisualWidth(text) {
  let w = 0
  for (const ch of String(text || '')) {
    const code = ch.charCodeAt(0)
    // CJK Unified Ideographs, Fullwidth forms, Hiragana, Katakana, Hangul
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      w += 14 // font-size: 13 bold CJK takes ~13.5-14px
    } else {
      w += 8 // Latin, digits, ASCII symbols take ~8px
    }
  }
  return w
}

/**
 * Calculates adaptive dimensions for a flowchart node based on its shape and label text
 */
function getNodeDimensions(node, theme) {
  const lines = String(node.label || node.id || '').split('\n')
  const maxLineVisual = Math.max(...lines.map(getVisualWidth), 20)
  const lineCount = lines.length

  let width = Math.max(180, Math.min(360, maxLineVisual + 60))
  let height = Math.max(64, lineCount * 22 + 28)

  if (theme.shape === 'diamond') {
    // Diamonds have narrow corner areas, text fits within the inner inscribed rectangle
    width = Math.max(220, Math.min(420, maxLineVisual * 1.5 + 80))
    height = Math.max(76, lineCount * 24 + 36)
  } else if (theme.shape === 'ellipse') {
    width = Math.max(200, Math.min(380, maxLineVisual * 1.25 + 70))
    height = Math.max(68, lineCount * 22 + 32)
  }

  return { width, height }
}

/**
 * Generates an interactive Drawnix architecture diagram / flowchart
 * @param {Object} options
 * @param {string} [options.title] Diagram title
 * @param {string} [options.direction="TB"] "TB" (Top-to-Bottom) or "LR" (Left-to-Right)
 * @param {Array<Object>} options.nodes Nodes list
 * @param {Array<Object>} options.edges Edges list
 * @returns {Object} Complete .drawnix JSON object
 */
export function generateFlowchart(options = {}) {
  const nodes = Array.isArray(options.nodes) ? options.nodes : []
  const edges = Array.isArray(options.edges) ? options.edges : []
  const direction = options.direction === 'LR' ? 'LR' : 'TB'
  const title = (options.title || '').trim()

  const hGap = 80
  const vGap = 110

  const { layerGroups } = computeLayers(nodes, edges)

  // Layout coordinates calculation
  const nodeBounds = new Map()
  const geometryElements = []

  let overallMinY = 0

  if (direction === 'TB') {
    let currentY = title ? 80 : 0
    overallMinY = currentY

    layerGroups.forEach((layerNodes, layerIdx) => {
      // Calculate individual dimensions for nodes in this layer
      const themes = layerNodes.map((n, idx) => resolveNodeTheme(n, idx))
      const nodeDims = layerNodes.map((n, idx) => getNodeDimensions(n, themes[idx]))

      const totalWidth = nodeDims.reduce((sum, d) => sum + d.width, 0) + (layerNodes.length - 1) * hGap
      let startX = -totalWidth / 2
      const maxHeightInLayer = Math.max(...nodeDims.map(d => d.height), 64)

      layerNodes.forEach((node, nodeIdx) => {
        const { width, height } = nodeDims[nodeIdx]
        const theme = themes[nodeIdx]
        const x1 = startX
        const y1 = currentY + (maxHeightInLayer - height) / 2
        const x2 = x1 + width
        const y2 = y1 + height
        startX += width + hGap

        nodeBounds.set(node.id, {
          x1, y1, x2, y2,
          centerX: (x1 + x2) / 2,
          centerY: (y1 + y2) / 2,
          width, height,
          layer: layerIdx,
        })

        geometryElements.push({
          id: node.id || generateId('node'),
          type: 'geometry',
          shape: theme.shape,
          angle: 0,
          opacity: 1,
          strokeWidth: 2,
          fill: theme.fill,
          strokeColor: theme.stroke,
          text: {
            children: [
              {
                text: node.label || node.id || '',
                color: theme.textColor || '#0f172a',
                bold: true,
                'font-size': 13,
              },
            ],
            type: 'paragraph',
            align: 'center',
          },
          points: [
            [x1, y1],
            [x2, y2],
          ],
        })
      })

      currentY += maxHeightInLayer + vGap
    })
  } else {
    // LR (Left to Right) layout
    let currentX = 0

    layerGroups.forEach((layerNodes, layerIdx) => {
      const themes = layerNodes.map((n, idx) => resolveNodeTheme(n, idx))
      const nodeDims = layerNodes.map((n, idx) => getNodeDimensions(n, themes[idx]))

      const maxWidthInLayer = Math.max(...nodeDims.map(d => d.width), 180)
      const totalHeight = nodeDims.reduce((sum, d) => sum + d.height, 0) + (layerNodes.length - 1) * vGap
      let startY = -totalHeight / 2
      if (title && startY < 60) startY = 60

      layerNodes.forEach((node, nodeIdx) => {
        const { width, height } = nodeDims[nodeIdx]
        const theme = themes[nodeIdx]
        const x1 = currentX + (maxWidthInLayer - width) / 2
        const y1 = startY
        const x2 = x1 + width
        const y2 = y1 + height
        startY += height + vGap

        nodeBounds.set(node.id, {
          x1, y1, x2, y2,
          centerX: (x1 + x2) / 2,
          centerY: (y1 + y2) / 2,
          width, height,
          layer: layerIdx,
        })

        geometryElements.push({
          id: node.id || generateId('node'),
          type: 'geometry',
          shape: theme.shape,
          angle: 0,
          opacity: 1,
          strokeWidth: 2,
          fill: theme.fill,
          strokeColor: theme.stroke,
          text: {
            children: [
              {
                text: node.label || node.id || '',
                color: theme.textColor || '#0f172a',
                bold: true,
                'font-size': 13,
              },
            ],
            type: 'paragraph',
            align: 'center',
          },
          points: [
            [x1, y1],
            [x2, y2],
          ],
        })
      })

      currentX += maxWidthInLayer + hGap + 40
    })
  }

  // Helper to determine connecting sides for source and target
  function getEdgeSides(src, tgt, dir) {
    if (dir === 'TB') {
      if (tgt.layer === src.layer + 1) {
        return { srcSide: 'bottom', tgtSide: 'top' }
      } else if (tgt.layer === src.layer) {
        return src.centerX < tgt.centerX
          ? { srcSide: 'right', tgtSide: 'left' }
          : { srcSide: 'left', tgtSide: 'right' }
      } else {
        // Long-range forward edge or backward loop -> route via outer gutter
        const useLeft = src.centerX < 0 || tgt.centerX < 0
        return useLeft
          ? { srcSide: 'left', tgtSide: 'left' }
          : { srcSide: 'right', tgtSide: 'right' }
      }
    } else {
      // LR mode
      if (tgt.layer === src.layer + 1) {
        return { srcSide: 'right', tgtSide: 'left' }
      } else if (tgt.layer === src.layer) {
        return src.centerY < tgt.centerY
          ? { srcSide: 'bottom', tgtSide: 'top' }
          : { srcSide: 'top', tgtSide: 'bottom' }
      } else {
        const useTop = src.centerY < 0 || tgt.centerY < 0
        return useTop
          ? { srcSide: 'top', tgtSide: 'top' }
          : { srcSide: 'bottom', tgtSide: 'bottom' }
      }
    }
  }

  // Pre-calculate connection density per node side to distribute line anchors dynamically
  const sideTotals = new Map()
  const plannedEdges = []

  edges.forEach((edge) => {
    const src = nodeBounds.get(edge.from)
    const tgt = nodeBounds.get(edge.to)
    if (!src || !tgt) return

    const { srcSide, tgtSide } = getEdgeSides(src, tgt, direction)
    const srcKey = `${edge.from}:${srcSide}`
    const tgtKey = `${edge.to}:${tgtSide}`

    sideTotals.set(srcKey, (sideTotals.get(srcKey) || 0) + 1)
    sideTotals.set(tgtKey, (sideTotals.get(tgtKey) || 0) + 1)

    plannedEdges.push({
      edge,
      src,
      tgt,
      srcSide,
      tgtSide,
      srcKey,
      tgtKey,
    })
  })

  const sideCounters = new Map()
  function getDynamicOffset(key) {
    const total = sideTotals.get(key) || 1
    const idx = sideCounters.get(key) || 0
    sideCounters.set(key, idx + 1)

    if (total <= 1) return 0.5
    const margin = Math.max(0.12, 0.35 - (total - 2) * 0.035)
    const span = 1 - 2 * margin
    return Number((margin + (idx / (total - 1)) * span).toFixed(3))
  }

  function toConnectionPoint(side, offset) {
    switch (side) {
      case 'top': return [offset, 0]
      case 'bottom': return [offset, 1]
      case 'left': return [0, offset]
      case 'right': return [1, offset]
      default: return [0.5, 0.5]
    }
  }

  // Generate Arrow-line elements with obstacle-aware routing and non-overlapping connection tracks
  const arrowElements = []
  plannedEdges.forEach(({ edge, src, tgt, srcSide, tgtSide, srcKey, tgtKey }) => {
    const sourceConn = toConnectionPoint(srcSide, getDynamicOffset(srcKey))
    const targetConn = toConnectionPoint(tgtSide, getDynamicOffset(tgtKey))

    const edgeElement = {
      id: generateId('edge'),
      type: 'arrow-line',
      shape: 'elbow',
      opacity: 1,
      strokeWidth: 2,
      strokeColor: '#64748b',
      source: {
        marker: 'none',
        connection: sourceConn,
        boundId: edge.from,
      },
      target: {
        marker: 'arrow',
        connection: targetConn,
        boundId: edge.to,
      },
      points: [
        [src.centerX, src.centerY],
        [tgt.centerX, tgt.centerY],
      ],
      texts: edge.label ? [
        {
          text: {
            children: [
              {
                text: edge.label,
                'font-size': 11,
              },
            ],
            type: 'paragraph',
            align: 'center',
          },
          position: 0.5,
        },
      ] : [],
    }

    arrowElements.push(edgeElement)
  })

  // Title Banner
  const allChildren = []
  if (title) {
    allChildren.push({
      id: generateId('title'),
      type: 'geometry',
      shape: 'text',
      angle: 0,
      opacity: 1,
      text: {
        children: [
          {
            text: title,
            'font-size': 20,
            bold: true,
          },
        ],
        type: 'paragraph',
        align: 'center',
      },
      points: [
        [-250, overallMinY - 60],
        [250, overallMinY - 20],
      ],
      autoSize: true,
    })
  }

  allChildren.push(...geometryElements, ...arrowElements)

  return {
    type: 'drawnix',
    version: 1,
    source: 'dsh',
    children: allChildren,
    viewport: {
      zoom: 1,
    },
  }
}
