/**
 * Visual themes and palettes for Drawnix elements
 */

export const THEMES = {
  client: {
    fill: '#f0f9ff',
    stroke: '#0284c7',
    textColor: '#0369a1',
    shape: 'roundRectangle',
  },
  gateway: {
    fill: '#faf5ff',
    stroke: '#9333ea',
    textColor: '#6b21a8',
    shape: 'rectangle',
  },
  service: {
    fill: '#eff6ff',
    stroke: '#2563eb',
    textColor: '#1d4ed8',
    shape: 'rectangle',
  },
  mq: {
    fill: '#fffbeb',
    stroke: '#d97706',
    textColor: '#b45309',
    shape: 'roundRectangle',
  },
  storage: {
    fill: '#f0fdf4',
    stroke: '#16a34a',
    textColor: '#15803d',
    shape: 'ellipse',
  },
  database: {
    fill: '#f0fdf4',
    stroke: '#16a34a',
    textColor: '#15803d',
    shape: 'ellipse',
  },
  cache: {
    fill: '#fdf2f8',
    stroke: '#db2777',
    textColor: '#be185d',
    shape: 'roundRectangle',
  },
  decision: {
    fill: '#fefce8',
    stroke: '#ca8a04',
    textColor: '#854d0e',
    shape: 'diamond',
  },
  default: {
    fill: '#f8fafc',
    stroke: '#475569',
    textColor: '#1e293b',
    shape: 'rectangle',
  },
}

const CYCLE_PALETTES = [
  { fill: '#eff6ff', stroke: '#2563eb', textColor: '#1d4ed8' },
  { fill: '#f0fdf4', stroke: '#16a34a', textColor: '#15803d' },
  { fill: '#faf5ff', stroke: '#9333ea', textColor: '#6b21a8' },
  { fill: '#fffbeb', stroke: '#d97706', textColor: '#b45309' },
  { fill: '#f0f9ff', stroke: '#0284c7', textColor: '#0369a1' },
  { fill: '#fdf2f8', stroke: '#db2777', textColor: '#be185d' },
]

export function resolveNodeTheme(node, index = 0) {
  // Do NOT fall back to node.type: drawnix element 'type' collides with
  // semantic categories (e.g. type:'geometry' would be treated as a category).
  const cat = (node.category || '').toLowerCase()
  if (cat && THEMES[cat]) {
    return {
      fill: node.fill || THEMES[cat].fill,
      stroke: node.strokeColor || THEMES[cat].stroke,
      textColor: node.textColor || THEMES[cat].textColor,
      shape: node.shape || THEMES[cat].shape,
    }
  }

  // Fallback to shape or color cycle
  const cycled = CYCLE_PALETTES[index % CYCLE_PALETTES.length]
  const isQuestion = node.label && (node.label.endsWith('?') || node.label.endsWith('？'))
  return {
    fill: node.fill || cycled.fill,
    stroke: node.strokeColor || cycled.stroke,
    textColor: node.textColor || cycled.textColor,
    shape: node.shape || (isQuestion ? 'diamond' : 'rectangle'),
  }
}

export function generateId(prefix = '') {
  // 16 base36 chars ≈ 8e24 combinations, collision-safe across large boards
  const rand = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2)
  const id = rand.substring(0, 16)
  return prefix ? `${prefix}_${id}` : id
}
