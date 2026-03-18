import type { BomCloneNode } from '../clone.types'

export type ItemDuplicateKind = 'duplicate' | 'reference'

export type DuplicatePlanNode = {
  sourceNode: BomCloneNode
  kind: ItemDuplicateKind
  children: DuplicatePlanNode[]
}

export function isPartNode(node: Pick<BomCloneNode, 'number'>): boolean {
  const num = String(node.number ?? '').trim()
  if (!num) return false
  return num.toLowerCase().startsWith('99')
}

export function buildDuplicatePlan(nodes: BomCloneNode[]): DuplicatePlanNode[] {
  return nodes.map((node) => ({
    sourceNode: node,
    kind: isPartNode(node) ? 'reference' : 'duplicate',
    children: buildDuplicatePlan(node.children),
  }))
}

export function countDuplicateOperations(plan: DuplicatePlanNode[]): number {
  let count = 0
  for (const entry of plan) {
    if (entry.kind === 'duplicate') count += 1
    count += countDuplicateOperations(entry.children)
  }
  return count
}
