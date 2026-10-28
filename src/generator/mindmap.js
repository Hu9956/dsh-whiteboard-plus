import { generateId } from './theme.js'

/**
 * Builds recursive mind_child nodes for Plait Mindmap
 */
function buildMindChildren(children) {
  if (!Array.isArray(children) || children.length === 0) {
    return []
  }

  return children.map(child => {
    let rawText = ''
    if (child && typeof child === 'object') {
      const t = child.text ?? child.topic
      rawText = typeof t === 'object' && t !== null
        ? (t.text ?? t.topic ?? JSON.stringify(t))
        : (t ?? '')
    } else {
      rawText = String(child)
    }
    const text = String(rawText).trim()
    const subChildren = child && typeof child === 'object' && Array.isArray(child.children) ? child.children : []

    return {
      id: generateId(),
      type: 'mind_child',
      data: {
        topic: {
          children: [
            {
              text: text || '分支主题',
            },
          ],
          type: 'paragraph',
        },
      },
      children: buildMindChildren(subChildren),
    }
  })
}

/**
 * Generates a standard Drawnix file containing an interactive Plait mindmap
 * @param {Object} options
 * @param {string} [options.title] Root topic title
 * @param {Object} options.root Root node tree { text, children }
 * @param {string} [options.layout] "right" | "standard"
 * @returns {Object} Complete .drawnix JSON object
 */
export function generateMindmap(options = {}) {
  const root = options.root || {}
  const rawRootText = root.text ?? root.topic ?? options.title ?? '中心主题'
  const rootText = String(rawRootText).trim() || '中心主题'
  const rootChildren = Array.isArray(root.children) ? root.children : []
  const layout = options.layout === 'standard' ? 'standard' : 'right'

  const rootElement = {
    id: generateId(),
    type: 'mind',
    data: {
      topic: {
        children: [
          {
            text: rootText,
          },
        ],
        type: 'paragraph',
      },
    },
    children: buildMindChildren(rootChildren),
    layout,
    points: [
      [ 0, 0 ],
    ],
  }

  return {
    type: 'drawnix',
    version: 1,
    source: 'dsh',
    children: [rootElement],
    viewport: {
      zoom: 1,
    },
  }
}
