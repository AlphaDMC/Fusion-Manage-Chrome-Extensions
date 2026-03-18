import type { BomCloneNode } from '../../clone.types'

type ParseBomTreeV1Options = {
  workspaceId: number
  rootItemId: number
  depth: number
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function readString(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

function readQuantity(value: Record<string, unknown>): string {
  const candidates = [
    value.formattedQuantity,
    value.quantity,
    value.qty,
    value.totalQuantity,
  ]
  for (const candidate of candidates) {
    const resolved = readString(candidate)
    if (resolved) return resolved
  }
  return ''
}

function extractBomItems(payload: unknown): Array<Record<string, unknown>> {
  const root = asRecord(payload)
  const candidates: unknown[] = [
    root.list,
    root.payload,
    root.data
  ]

  for (const candidate of candidates) {
    const record = asRecord(candidate)
    const listRecord = asRecord(record.list)
    const directArray = asArray(record.data)
    if (directArray.length > 0) {
      return directArray
        .map((entry) => asRecord(asRecord(entry)['bom-item'] ?? entry))
        .filter((entry) => Object.keys(entry).length > 0)
    }

    const listArray = asArray(listRecord.data)
    if (listArray.length > 0) {
      return listArray
        .map((entry) => asRecord(asRecord(entry)['bom-item'] ?? entry))
        .filter((entry) => Object.keys(entry).length > 0)
    }
  }

  const directArray = asArray(payload)
  return directArray
    .map((entry) => asRecord(asRecord(entry)['bom-item'] ?? entry))
    .filter((entry) => Object.keys(entry).length > 0)
}

function extractFieldValues(value: unknown): Record<string, string> {
  const fieldsRecord = asRecord(value)
  const entryValue = fieldsRecord.entry
  const entries = Array.isArray(entryValue)
    ? entryValue
    : entryValue
      ? [entryValue]
      : []

  const fieldValues: Record<string, string> = {}
  for (const rawEntry of entries) {
    const entry = asRecord(rawEntry)
    const key = readString(entry.key)
    if (!key) continue
    const fieldData = asRecord(entry.fieldData)
    const resolvedValue =
      readString(fieldData.formattedValue)
      || readString(fieldData.label)
      || readString(fieldData.value)
    if (!resolvedValue) continue
    fieldValues[key] = resolvedValue
  }
  return fieldValues
}

function readRootDescriptor(payload: unknown): string {
  const root = asRecord(payload)
  const candidates = [
    asRecord(root.item).descriptor,
    root.descriptor,
    asRecord(root.payload).descriptor,
    asRecord(asRecord(root.payload).item).descriptor,
    asRecord(root.data).descriptor,
    asRecord(asRecord(root.data).item).descriptor
  ]
  for (const candidate of candidates) {
    const value = readString(candidate)
    if (value) return value
  }
  return ''
}

function markLoadedState(node: BomCloneNode, depthLimit: number, currentDepth: number): BomCloneNode {
  const children = node.children.map((child) => markLoadedState(child, depthLimit, currentDepth + 1))
  const hasChildren = children.length > 0
  const childrenLoaded = hasChildren || !node.hasExpandableChildren || currentDepth < depthLimit
  return {
    ...node,
    children,
    hasExpandableChildren: node.hasExpandableChildren || hasChildren,
    childrenLoaded
  }
}

export function toBomTreeV1(payload: unknown, options: ParseBomTreeV1Options): BomCloneNode[] {
  const { workspaceId, rootItemId } = options
  const depthLimit = Math.max(1, Math.floor(Number(options.depth) || 1))
  const rootId = String(rootItemId)
  const rootLabel = readRootDescriptor(payload) || `Item ${rootId}`
  const rootNode: BomCloneNode = {
    id: rootId,
    itemLink: `/api/v3/workspaces/${workspaceId}/items/${rootId}`,
    label: rootLabel,
    number: rootId,
    itemNumber: '0.0',
    iconHtml: '',
    revision: '',
    status: '',
    quantity: '',
    unitOfMeasure: '',
    hasExpandableChildren: false,
    childrenLoaded: true,
    children: []
  }

  const stack: BomCloneNode[] = [rootNode]
  const items = extractBomItems(payload)

  for (const item of items) {
    const level = readPositiveInt(item.bomDepthLevel, 1)
    const itemId = readPositiveInt(item.dmsID ?? item.itemId ?? item.id, 0)
    if (itemId <= 0) continue

    const descriptor = readString(item.descriptor) || `Item ${itemId}`
    const quantity = readQuantity(item)
    const itemNumberOrdinal = readString(item.itemNumber) || '1'
    const isAssembly = String(item.assembly).toLowerCase() === 'true'
    const isLeaf = String(item.leaf).toLowerCase() === 'true'
    const fieldValues = extractFieldValues(item.fields)
    const node: BomCloneNode = {
      id: String(itemId),
      itemLink: `/api/v3/workspaces/${workspaceId}/items/${itemId}`,
      label: descriptor,
      number: String(itemId),
      itemNumber: `${level}.${itemNumberOrdinal}`,
      iconHtml: '',
      revision: readString(item.revision),
      status: readString(item.lifecycleStatus),
      quantity,
      unitOfMeasure: readString(item.units),
      ...(Object.keys(fieldValues).length > 0 ? { bomFieldValues: fieldValues } : {}),
      hasExpandableChildren: isAssembly && !isLeaf,
      childrenLoaded: level < depthLimit || !isAssembly || isLeaf,
      children: []
    }

    while (stack.length > level) stack.pop()
    const parent = stack[stack.length - 1] || rootNode
    parent.children.push(node)
    stack[level] = node
  }

  return [markLoadedState(rootNode, depthLimit, 0)]
}

