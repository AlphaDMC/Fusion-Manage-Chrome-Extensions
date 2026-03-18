import type { BomCloneNode } from '../../clone.types'

export function extractArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
  }
  return []
}

function extractFieldEntries(value: unknown): Array<Record<string, unknown>> {
  const direct = extractArray(value)
  if (direct.length > 0) return direct
  if (!value || typeof value !== 'object') return []

  const record = value as Record<string, unknown>
  const wrappedProps = ['fields', 'items', 'data', 'entries', 'results', 'values']
  for (const prop of wrappedProps) {
    const fromProp = extractArray(record[prop])
    if (fromProp.length > 0) return fromProp
  }

  const mapEntries: Array<Record<string, unknown>> = []
  for (const [key, raw] of Object.entries(record)) {
    if (!/^\d+$/.test(String(key))) continue
    mapEntries.push({ fieldId: key, value: raw })
  }
  return mapEntries
}

export function readNodeId(entity: Record<string, unknown>, fallback: string): string {
  const keys = ['id', 'dmsId', 'itemId', 'bomItemId', 'nodeId']
  for (const key of keys) {
    const value = Number(entity[key])
    if (Number.isFinite(value)) return String(value)
  }

  if (typeof entity.__self__ === 'string') {
    const selfLink = entity.__self__.trim()
    if (selfLink) {
      const fromItems = /\/items\/(\d+)\b/i.exec(selfLink)
      if (fromItems) return fromItems[1]
      const trailing = /\/(\d+)(?:[/?#]|$)/.exec(selfLink)
      if (trailing) return trailing[1]
    }
  }
  if (entity.__self__ && typeof entity.__self__ === 'object') {
    const self = entity.__self__ as Record<string, unknown>
    const selfLink = String(self.link || '').trim()
    if (selfLink) {
      const fromItems = /\/items\/(\d+)\b/i.exec(selfLink)
      if (fromItems) return fromItems[1]
      const trailingDigits = /\/(\d+)(?:[/?#]|$)/.exec(selfLink)
      if (trailingDigits) return trailingDigits[1]
    }
    const selfUrn = String(self.urn || '').trim()
    if (selfUrn) {
      const match = /\.([0-9]+)$/.exec(selfUrn)
      if (match) return match[1]
    }
  }
  if (typeof entity.link === 'string') {
    const match = /\/items\/(\d+)\b/i.exec(entity.link)
    if (match) return match[1]
  }
  if (typeof entity.urn === 'string') {
    const match = /\.([0-9]+)$/.exec(entity.urn)
    if (match) return match[1]
  }

  return fallback
}

export function readNodeLabel(entity: Record<string, unknown>, fallbackLabel: string): string {
  const candidates = [entity.itemDescriptor, entity.descriptor, entity.title, entity.name]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return fallbackLabel
}

function readEdgeId(entity: Record<string, unknown>): string {
  const idKeys = ['edgeId', 'id', 'bomItemId']
  for (const key of idKeys) {
    const value = Number(entity[key])
    if (Number.isFinite(value) && value > 0) return String(value)
  }

  const selfLink = typeof entity.__self__ === 'string'
    ? entity.__self__
    : entity.__self__ && typeof entity.__self__ === 'object'
      ? String((entity.__self__ as Record<string, unknown>).link || '')
      : typeof entity.link === 'string'
        ? entity.link
        : ''
  if (selfLink) {
    const match = /\/bom-items\/(\d+)\b/i.exec(selfLink)
    if (match) return match[1]
  }
  return ''
}

function htmlDecode(value: string): string {
  if (!value) return ''
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function readFieldValueByMetaId(fields: Array<Record<string, unknown>>, metaIds: string[]): unknown {
  for (const field of fields) {
    const fieldId = readFieldMetaId(field)
    if (!fieldId) continue
    if (metaIds.includes(fieldId)) {
      if (Object.prototype.hasOwnProperty.call(field, 'value')) return field.value
      if (Object.prototype.hasOwnProperty.call(field, 'fieldValue')) return field.fieldValue
      if (Object.prototype.hasOwnProperty.call(field, 'displayValue')) return field.displayValue
      return undefined
    }
  }
  return undefined
}

function readSelfLink(entity: Record<string, unknown>): string {
  if (typeof entity.__self__ === 'string' && entity.__self__.trim()) return entity.__self__.trim()
  if (entity.__self__ && typeof entity.__self__ === 'object') {
    const link = String((entity.__self__ as Record<string, unknown>).link || '').trim()
    if (link) return link
  }
  if (typeof entity.link === 'string' && entity.link.trim()) return entity.link.trim()
  return ''
}

function readFieldMetaId(field: Record<string, unknown>): string {
  const metaRaw = field.metaData
  if (typeof metaRaw === 'string') {
    const link = metaRaw.trim()
    if (link) {
      const match = /\/fields\/(\d+)\b/i.exec(link)
      if (match) return match[1]
    }
  }
  if (metaRaw && typeof metaRaw === 'object') {
    const meta = metaRaw as Record<string, unknown>
    const link = String(meta.link || '').trim()
    if (link) {
      const match = /\/fields\/(\d+)\b/i.exec(link)
      if (match) return match[1]
    }
    const selfRaw = meta.__self__
    const selfLink = typeof selfRaw === 'string'
      ? selfRaw.trim()
      : selfRaw && typeof selfRaw === 'object'
        ? String((selfRaw as Record<string, unknown>).link || '').trim()
        : ''
    if (selfLink) {
      const match = /\/fields\/(\d+)\b/i.exec(selfLink)
      if (match) return match[1]
    }
    const urn = String(meta.urn || '').trim()
    if (urn) {
      const match = /\.([0-9]+)$/.exec(urn)
      if (match) return match[1]
    }
  }

  const fieldRefRaw = field.field
  if (fieldRefRaw && typeof fieldRefRaw === 'object') {
    const fieldRef = fieldRefRaw as Record<string, unknown>
    const selfRaw = fieldRef.__self__
    const selfLink = typeof selfRaw === 'string'
      ? selfRaw
      : selfRaw && typeof selfRaw === 'object'
        ? String((selfRaw as Record<string, unknown>).link || '')
        : ''
    const link = String(fieldRef.link || selfLink || '').trim()
    if (link) {
      const match = /\/fields\/(\d+)\b/i.exec(link)
      if (match) return match[1]
    }
    const urn = String(fieldRef.urn || '').trim()
    if (urn) {
      const match = /\.([0-9]+)$/.exec(urn)
      if (match) return match[1]
    }
  }

  const directLink = String(field.link || '').trim()
  if (directLink) {
    const match = /\/fields\/(\d+)\b/i.exec(directLink)
    if (match) return match[1]
  }

  const selfRaw = field.__self__
  const selfLink = typeof selfRaw === 'string'
    ? selfRaw.trim()
    : selfRaw && typeof selfRaw === 'object'
      ? String((selfRaw as Record<string, unknown>).link || '').trim()
      : ''
  if (selfLink) {
    const match = /\/fields\/(\d+)\b/i.exec(selfLink)
    if (match) return match[1]
  }

  const directFieldId = Number(field.fieldId)
  if (Number.isFinite(directFieldId) && directFieldId > 0) return String(Math.floor(directFieldId))
  return ''
}

function readEdgeFieldValueMap(fields: Array<Record<string, unknown>>): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of fields) {
    const fieldId = readFieldMetaId(field)
    if (!fieldId) continue
    const rawValue = Object.prototype.hasOwnProperty.call(field, 'value')
      ? field.value
      : Object.prototype.hasOwnProperty.call(field, 'fieldValue')
        ? field.fieldValue
        : Object.prototype.hasOwnProperty.call(field, 'displayValue')
          ? field.displayValue
          : undefined
    const text = asDisplayString(rawValue)
    if (!String(text).trim()) continue
    values[fieldId] = text
  }
  return values
}

export function asDisplayString(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.title === 'string') return record.title
    if (typeof record.value === 'string') return record.value
    if (typeof record.value === 'number' || typeof record.value === 'boolean') return String(record.value)
    if (typeof record.displayValue === 'string') return record.displayValue
    if (typeof record.name === 'string') return record.name
  }
  return ''
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return fallback
  if (['true', '1', 'yes', 'y', 'on'].includes(text)) return true
  if (['false', '0', 'no', 'n', 'off'].includes(text)) return false
  return fallback
}

function readEdgePinnedValue(edge: Record<string, unknown>, edgeFields: Array<Record<string, unknown>>): boolean {
  if (Object.prototype.hasOwnProperty.call(edge, 'isPinned')) return asBoolean(edge.isPinned, false)
  if (Object.prototype.hasOwnProperty.call(edge, 'pinned')) return asBoolean(edge.pinned, false)
  const fieldPinned = readFieldValueByMetaId(edgeFields, ['302'])
  if (fieldPinned != null) return asBoolean(fieldPinned, false)
  return false
}

function readItemNumber(edge: Record<string, unknown>, fallback = ''): string {
  const rawDepth = Number(edge.depth)
  const depth = Number.isFinite(rawDepth) ? String(rawDepth) : ''
  const rawItem = edge.itemNumber
  const item =
    typeof rawItem === 'number' && Number.isFinite(rawItem)
      ? String(rawItem)
      : typeof rawItem === 'string' && rawItem.trim()
        ? rawItem.trim()
        : ''

  if (depth && item) return `${depth}.${item}`
  if (item) return item
  return fallback
}

function readEdgeQuantity(edge: Record<string, unknown>, edgeFields: Array<Record<string, unknown>>, fallback = ''): string {
  const directCandidates = [
    edge.formattedQuantity,
    edge.quantity,
    edge.qty,
    edge.totalQuantity,
  ]
  for (const candidate of directCandidates) {
    const value = asDisplayString(candidate).trim()
    if (value) return value
  }

  const fieldValue = asDisplayString(readFieldValueByMetaId(edgeFields, ['103'])).trim()
  if (fieldValue) return fieldValue
  return fallback
}

function createNodeFromPayload(
  nodeId: string,
  item: Record<string, unknown>,
  nodeFields: Array<Record<string, unknown>>
): BomCloneNode {
  const nodeFieldValues = readEdgeFieldValueMap(nodeFields)
  const quantity = asDisplayString(readFieldValueByMetaId(nodeFields, ['103']))
  const number = asDisplayString(readFieldValueByMetaId(nodeFields, ['732'])) || nodeId
  const revision = asDisplayString(readFieldValueByMetaId(nodeFields, ['98'])) || asDisplayString(item.version)
  const status = asDisplayString(readFieldValueByMetaId(nodeFields, ['1210']))
  const unitOfMeasure = asDisplayString(readFieldValueByMetaId(nodeFields, ['104']))
  const iconHtml = htmlDecode(asDisplayString(readFieldValueByMetaId(nodeFields, ['286'])))

  return {
    id: nodeId,
    itemLink: typeof item.link === 'string' ? item.link : undefined,
    label: readNodeLabel(item, `Item ${nodeId}`),
    number,
    itemNumber: '',
    iconHtml,
    revision,
    status,
    quantity,
    unitOfMeasure,
    ...(Object.keys(nodeFieldValues).length > 0 ? { bomFieldValues: nodeFieldValues } : {}),
    hasExpandableChildren: false,
    childrenLoaded: false,
    children: []
  }
}

function hydrateTreeLoadState(node: BomCloneNode): BomCloneNode {
  const children = node.children.map((child) => hydrateTreeLoadState(child))
  const hasChildren = children.length > 0
  const hasExpandableChildren = node.hasExpandableChildren || hasChildren
  const childrenLoaded = hasChildren ? true : node.childrenLoaded
  return {
    ...node,
    children,
    hasExpandableChildren,
    childrenLoaded
  }
}

export function toBomTree(payload: unknown): BomCloneNode[] {
  const rootRecord = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  let data = ((rootRecord.data && typeof rootRecord.data === 'object') ? rootRecord.data : rootRecord) as Record<string, unknown>
  for (let depth = 0; depth < 3; depth += 1) {
    const hasNodesOrEdges = Array.isArray(data.nodes) || Array.isArray(data.edges)
    if (hasNodesOrEdges) break
    if (!(data.data && typeof data.data === 'object')) break
    data = data.data as Record<string, unknown>
  }
  const nodes = extractArray(data.nodes)
  const edges = extractArray(data.edges)

  if (nodes.length > 0) {
    const nodeById = new Map<string, BomCloneNode>()
    const nodeByUrn = new Map<string, BomCloneNode>()
    const childIds = new Set<string>()

    for (let index = 0; index < nodes.length; index += 1) {
      const nodeEntity = nodes[index]
      const itemRaw = nodeEntity.item
      const item = itemRaw && typeof itemRaw === 'object' ? (itemRaw as Record<string, unknown>) : nodeEntity
      const nodeFields = extractFieldEntries(nodeEntity.fields)
      const nodeId = readNodeId(item, `node-${index + 1}`)
      const normalized = createNodeFromPayload(nodeId, item, nodeFields)
      nodeById.set(nodeId, normalized)
      if (typeof item.urn === 'string' && item.urn.trim()) nodeByUrn.set(item.urn, normalized)
    }

    const resolveNode = (value: unknown): BomCloneNode | null => {
      if (typeof value === 'string') {
        const byUrn = nodeByUrn.get(value)
        if (byUrn) return byUrn
        const fromItems = /\/items\/(\d+)\b/i.exec(value)
        if (fromItems) return nodeById.get(fromItems[1]) || null
        const trailingDigits = /\.([0-9]+)$/.exec(value)
        if (trailingDigits) return nodeById.get(trailingDigits[1]) || null
        return nodeById.get(value) || null
      }
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        const id = readNodeId(record, '')
        if (id && nodeById.has(id)) return nodeById.get(id) || null
        if (typeof record.urn === 'string' && nodeByUrn.has(record.urn)) return nodeByUrn.get(record.urn) || null
      }
      return null
    }

    for (const edge of edges) {
      let parent = resolveNode(edge.parent)
      let child = resolveNode(edge.child)
      const edgeFields = extractFieldEntries(edge.fields)
      const edgeFieldValues = readEdgeFieldValueMap(edgeFields)
      const edgePinned = readEdgePinnedValue(edge, edgeFields)
      const edgeId = readEdgeId(edge)
      const edgeLink = readSelfLink(edge) || undefined

      if (!child) {
        const childRaw = edge.child
        const childEntity = childRaw && typeof childRaw === 'object'
          ? (childRaw as Record<string, unknown>)
          : { urn: String(childRaw || '').trim() } as Record<string, unknown>
        const childId = readNodeId(childEntity, `edge-child-${nodeById.size + 1}`)
        child = nodeById.get(childId) || createNodeFromPayload(childId, childEntity, [])
        nodeById.set(childId, child)
        const childUrn = String(childEntity.urn || '').trim()
        if (childUrn) nodeByUrn.set(childUrn, child)
      }

      if (!parent) {
        const parentRaw = edge.parent
        const parentEntity = parentRaw && typeof parentRaw === 'object'
          ? (parentRaw as Record<string, unknown>)
          : { urn: String(parentRaw || '').trim() } as Record<string, unknown>
        const parentId = readNodeId(parentEntity, `edge-parent-${nodeById.size + 1}`)
        parent = nodeById.get(parentId) || createNodeFromPayload(parentId, parentEntity, [])
        nodeById.set(parentId, parent)
        const parentUrn = String(parentEntity.urn || '').trim()
        if (parentUrn) nodeByUrn.set(parentUrn, parent)
      }

      child.itemNumber = readItemNumber(edge, child.itemNumber)
      const edgeQuantity = readEdgeQuantity(edge, edgeFields, child.quantity)
      if (edgeQuantity) child.quantity = edgeQuantity
      child.unitOfMeasure ||= asDisplayString(readFieldValueByMetaId(edgeFields, ['104']))
      if (Object.keys(edgeFieldValues).length > 0) {
        child.bomFieldValues = {
          ...(child.bomFieldValues || {}),
          ...edgeFieldValues
        }
      }
      child.hasExpandableChildren = edge.lastNode === false || child.hasExpandableChildren
      if (edgeId) child.bomEdgeId = edgeId
      if (edgeLink) child.bomEdgeLink = edgeLink
      child.isPinned = edgePinned
      childIds.add(child.id)
      if (!parent.children.some((entry) => entry.id === child.id)) parent.children.push(child)
    }

    const roots = Array.from(nodeById.values()).filter((node) => !childIds.has(node.id))
    for (const root of roots) {
      if (!root.itemNumber) root.itemNumber = '0.0'
      root.hasExpandableChildren = root.children.length > 0
      root.childrenLoaded = root.children.length > 0
    }
    const tree = roots.length > 0 ? roots : Array.from(nodeById.values())
    return tree.map((node) => hydrateTreeLoadState(node))
  }

  const rootRaw = data.item
  const rootEntity = rootRaw && typeof rootRaw === 'object' ? (rootRaw as Record<string, unknown>) : {}

  const rootId = readNodeId(rootEntity, 'root')
  const rootNode: BomCloneNode = {
    id: rootId,
    label: readNodeLabel(rootEntity, 'Root'),
    number: rootId,
    itemNumber: '0.0',
    iconHtml: '',
    revision: '',
    status: '',
    quantity: '',
    unitOfMeasure: '',
    hasExpandableChildren: false,
    childrenLoaded: false,
    children: []
  }

  if (edges.length === 0) return [rootNode]

  const nodeMap = new Map<string, BomCloneNode>([[rootNode.id, rootNode]])
  const parentByChild = new Map<string, string>()

  for (const edge of edges) {
    const childRaw = (edge.child || edge.item || edge.childItem || edge.target || edge.to || edge)
    const parentRaw = (edge.parent || edge.parentItem || edge.source || edge.from || rootEntity)
    const edgeFields = extractFieldEntries(edge.fields)
    const edgeFieldValues = readEdgeFieldValueMap(edgeFields)
    const edgePinned = readEdgePinnedValue(edge, edgeFields)

    const childEntity = childRaw && typeof childRaw === 'object' ? (childRaw as Record<string, unknown>) : edge
    const parentEntity =
      parentRaw && typeof parentRaw === 'object' ? (parentRaw as Record<string, unknown>) : rootEntity

    const childId = readNodeId(childEntity, `edge-child-${nodeMap.size + 1}`)
    const parentId = readNodeId(parentEntity, rootNode.id)

    if (!nodeMap.has(childId)) {
      const childItemLink = typeof childEntity.link === 'string' ? childEntity.link : undefined
      nodeMap.set(childId, {
        id: childId,
        bomEdgeId: readEdgeId(edge),
        bomEdgeLink: readSelfLink(edge) || undefined,
        itemLink: childItemLink,
        label: readNodeLabel(childEntity, `Item ${childId}`),
        number: childId,
        itemNumber: readItemNumber(edge),
        iconHtml: '',
        revision: '',
        status: '',
        quantity: readEdgeQuantity(edge, edgeFields),
        unitOfMeasure: '',
        isPinned: edgePinned,
        ...(Object.keys(edgeFieldValues).length > 0 ? { bomFieldValues: edgeFieldValues } : {}),
        hasExpandableChildren: edge.lastNode === false,
        childrenLoaded: false,
        children: []
      })
    } else if (Object.keys(edgeFieldValues).length > 0) {
      const existing = nodeMap.get(childId)
      if (existing) {
        existing.bomFieldValues = {
          ...(existing.bomFieldValues || {}),
          ...edgeFieldValues
        }
        if (!existing.quantity) existing.quantity = readEdgeQuantity(edge, edgeFields)
        existing.isPinned = edgePinned
      }
    }

    if (!nodeMap.has(parentId)) {
      nodeMap.set(parentId, {
        id: parentId,
        label: readNodeLabel(parentEntity, `Item ${parentId}`),
        number: parentId,
        itemNumber: '',
        iconHtml: '',
        revision: '',
        status: '',
        quantity: '',
        unitOfMeasure: '',
        hasExpandableChildren: false,
        childrenLoaded: false,
        children: []
      })
    }

    parentByChild.set(childId, parentId)
  }

  for (const [childId, parentId] of parentByChild.entries()) {
    const parent = nodeMap.get(parentId)
    const child = nodeMap.get(childId)
    if (!parent || !child) continue
    if (!parent.children.some((candidate) => candidate.id === child.id)) {
      parent.children.push(child)
    }
  }

  return [hydrateTreeLoadState(nodeMap.get(rootId) || rootNode)]
}

