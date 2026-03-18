import {
  buildAutoTopLevelNumberOverrides,
  rebaseItemNumber
} from '../numbering.service'
import {
  appendTopLevelNode,
  cloneNode,
  collectExpandableNodeIds,
  collectNodeIds,
  collectUnloadedExpandableNodeIds,
  findNode,
  mergeTargetTreeWithStaged,
  removeTopLevelNodeById,
  updateNodeById
} from './tree.service'
import {
  getTargetSelectedTree
} from './selection.service'
import {
  areQuantitiesEquivalent,
  DEFAULT_CLONE_QUANTITY,
  normalizeQuantity,
  normalizeTopLevelItemNumber
} from '../normalize.service'
import { TEMP_OPERATION_NAME_FIELD_ID, type BomCloneContext, type BomCloneNode, type BomCloneStateSnapshot } from '../../clone.types'
import { resolveQuantityFieldId } from '../field.service'

export type TargetReorderResult = {
  nextTargetBomTree: BomCloneNode[] | null
  nextSelectedNodeIds: string[]
  nextTargetItemNumberOverrides: Record<string, string>
  nextManufacturingOperationAssignments?: Record<string, string>
}

export type TargetReorderPlacement = 'before' | 'after' | 'inside'

export type RemoveTargetNodeResult = {
  nextSelectedNodeIds: string[]
  nextMarkedForDeleteNodeIds: string[]
  unstageNode: boolean
}

export type QuantityEditResult = {
  quantityOverride: string | null
  fieldOverrides: Record<string, string> | null
}

export type EditPanelSaveResult = {
  fieldOverrides: Record<string, string>
  quantityOverride: string | null
  nextTargetBomTree: BomCloneNode[] | null
}

export type StagedOperationDraftResult = {
  draftNodeId: string | null
  nextTargetBomTree: BomCloneNode[]
  nextSelectedNodeIds: string[]
}

export type ManufacturingSplitProcessOption = {
  operationNodeId: string
  label: string
}

export type ManufacturingSplitDialogModel = {
  sourceNodeId: string
  descriptor: string
  totalQuantity: string
  remainingQuantity: string
  currentQuantity: string
  maxSplitQuantity: string
  unitOfMeasure: string
  processOptions: ManufacturingSplitProcessOption[]
}

export type ManufacturingSplitApplyResult =
  | {
    ok: true
    nextTargetBomTree: BomCloneNode[]
    nextSelectedNodeIds: string[]
    nextTargetQuantityOverrides: Record<string, string>
    nextManufacturingOperationAssignments: Record<string, string>
    nextTargetItemNumberOverrides: Record<string, string>
  }
  | {
    ok: false
    errorMessage: string
  }

export function buildAutoOverridesForSelection(
  snapshot: Pick<BomCloneStateSnapshot, 'sourceBomTree' | 'targetBomTree' | 'targetMarkedForDeleteNodeIds'>,
  nextSelectedNodeIds: string[]
): Record<string, string> {
  return buildAutoTopLevelNumberOverrides(
    snapshot.sourceBomTree,
    nextSelectedNodeIds,
    snapshot.targetBomTree,
    snapshot.targetMarkedForDeleteNodeIds
  )
}

export function applySelectionToggle(
  selectedNodeIds: string[],
  nodeId: string,
  selected: boolean
): string[] {
  const selectedSet = new Set(selectedNodeIds)
  if (selected) selectedSet.add(nodeId)
  else selectedSet.delete(nodeId)
  return Array.from(selectedSet)
}

export function isTopLevelSourceNode(
  snapshot: Pick<BomCloneStateSnapshot, 'sourceBomTree'>,
  nodeId: string
): boolean {
  if (snapshot.sourceBomTree.length === 0) return false

  const primaryRoot = snapshot.sourceBomTree[0]
  const candidateIds = (primaryRoot?.children?.length ?? 0) > 0
    ? new Set(primaryRoot.children.map((child) => child.id))
    : new Set(snapshot.sourceBomTree.map((node) => node.id))

  return candidateIds.has(nodeId)
}

function isComponentNode(node: BomCloneNode): boolean {
  return !node.hasExpandableChildren && node.children.length === 0
}

export function canStageSourceNode(
  snapshot: Pick<BomCloneStateSnapshot, 'sourceBomTree' | 'cloneLaunchMode'>,
  nodeId: string
): boolean {
  if (snapshot.cloneLaunchMode !== 'manufacturing') {
    return isTopLevelSourceNode(snapshot, nodeId)
  }
  const node = findNode(snapshot.sourceBomTree, nodeId)
  if (!node) return false
  return isComponentNode(node)
}

export function collectAssemblyComponentNodeIds(
  snapshot: Pick<BomCloneStateSnapshot, 'sourceBomTree'>,
  assemblyNodeId: string
): string[] {
  const assemblyNode = findNode(snapshot.sourceBomTree, assemblyNodeId)
  if (!assemblyNode) return []
  if (isComponentNode(assemblyNode)) return []

  const componentIds: string[] = []
  const seen = new Set<string>()

  const visit = (node: BomCloneNode): void => {
    if (isComponentNode(node)) {
      if (!seen.has(node.id)) {
        componentIds.push(node.id)
        seen.add(node.id)
      }
      return
    }
    for (const child of node.children) visit(child)
  }

  for (const child of assemblyNode.children) visit(child)
  return componentIds
}

export function resolveDefaultManufacturingOperationNodeId(
  snapshot: Pick<BomCloneStateSnapshot, 'targetBomTree' | 'sourceBomTree'>
): string | null {
  const targetRoot = snapshot.targetBomTree[0]
  if (!targetRoot) return null
  const processNodeIds = resolveManufacturingProcessNodeIds(snapshot)
  const firstOperation = targetRoot.children.find((child) => processNodeIds.has(child.id)) || null
  return firstOperation ? firstOperation.id : null
}

function resolveNextOperationNumber(children: BomCloneNode[]): number {
  let max = 0
  for (const child of children) {
    const tail = String(child.itemNumber || '').split('.').pop() || ''
    const parsed = Number.parseInt(tail, 10)
    if (Number.isFinite(parsed) && parsed > max) max = parsed
  }
  return Math.max(1, max + 1)
}

function buildStagedOperationNodeId(existingIds: Set<string>): string {
  const base = Date.now()
  let suffix = 0
  while (true) {
    const next = `staged-operation:${base}:${suffix}`
    if (!existingIds.has(next)) return next
    suffix += 1
  }
}

export function createStagedOperationDraft(
  snapshot: Pick<BomCloneStateSnapshot, 'targetBomTree' | 'selectedNodesToClone'>
): StagedOperationDraftResult {
  const targetRoot = snapshot.targetBomTree[0]
  if (!targetRoot) {
    return {
      draftNodeId: null,
      nextTargetBomTree: snapshot.targetBomTree,
      nextSelectedNodeIds: snapshot.selectedNodesToClone
    }
  }

  const existingIds = new Set(targetRoot.children.map((child) => child.id))
  const draftNodeId = buildStagedOperationNodeId(existingIds)
  const nextOperationNumber = resolveNextOperationNumber(targetRoot.children)
  const draftNode: BomCloneNode = {
    id: draftNodeId,
    label: '',
    number: '',
    itemNumber: `1.${nextOperationNumber}`,
    iconHtml: '',
    revision: '',
    status: '',
    quantity: '1.0',
    unitOfMeasure: '',
    stagedOperationDraft: true,
    hasExpandableChildren: false,
    childrenLoaded: true,
    children: []
  }

  const selectedSet = new Set(snapshot.selectedNodesToClone)
  selectedSet.add(draftNodeId)

  return {
    draftNodeId,
    nextTargetBomTree: appendTopLevelNode(snapshot.targetBomTree, draftNode),
    nextSelectedNodeIds: Array.from(selectedSet)
  }
}

export function removeStagedOperationDraftNode(
  snapshot: Pick<BomCloneStateSnapshot, 'targetBomTree' | 'selectedNodesToClone'>,
  nodeId: string
): StagedOperationDraftResult {
  const removeResult = removeTopLevelNodeById(snapshot.targetBomTree, nodeId)
  if (!removeResult.removed) {
    return {
      draftNodeId: null,
      nextTargetBomTree: snapshot.targetBomTree,
      nextSelectedNodeIds: snapshot.selectedNodesToClone
    }
  }
  const nextSelected = snapshot.selectedNodesToClone.filter((entry) => entry !== nodeId)
  return {
    draftNodeId: nodeId,
    nextTargetBomTree: removeResult.nextTree,
    nextSelectedNodeIds: nextSelected
  }
}

export function removeStagedSplitDraftNode(
  snapshot: Pick<BomCloneStateSnapshot, 'targetBomTree'>,
  nodeId: string
): { nextTargetBomTree: BomCloneNode[]; removed: boolean } {
  let removed = false
  const removeFromChildren = (nodes: BomCloneNode[]): BomCloneNode[] => {
    const next: BomCloneNode[] = []
    for (const node of nodes) {
      if (node.id === nodeId) {
        removed = true
        continue
      }
      const nextChildren = removeFromChildren(node.children)
      if (nextChildren !== node.children) {
        next.push({
          ...node,
          children: nextChildren,
          hasExpandableChildren: node.hasExpandableChildren || nextChildren.length > 0,
          childrenLoaded: node.childrenLoaded || nextChildren.length > 0
        })
      } else {
        next.push(node)
      }
    }
    return removed ? next : nodes
  }

  const nextTargetBomTree = removeFromChildren(snapshot.targetBomTree)
  return { nextTargetBomTree, removed }
}

export function pruneManufacturingAssignmentsForOperation(
  assignments: Record<string, string>,
  removedOperationNodeId: string
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(assignments).filter(([, operationId]) => operationId !== removedOperationNodeId)
  )
}

export function resolveQuantityFallbackForNode(snapshot: BomCloneStateSnapshot, nodeId: string): string {
  const baseNode = findNode(snapshot.targetBomTree, nodeId) || findNode(snapshot.sourceBomTree, nodeId)
  if (String(baseNode?.quantity || '').trim()) return String(baseNode?.quantity || '').trim()
  return '1.0'
}

export function resolveQuantityFieldOverrideForNode(
  snapshot: Pick<BomCloneStateSnapshot, 'targetFieldOverrides' | 'bomViewFields'>,
  nodeId: string,
  nextQuantityValue: string | null
): Record<string, string> | null {
  const quantityFieldId = resolveQuantityFieldId(snapshot)
  if (!quantityFieldId) return null
  const nextFieldOverrides = { ...(snapshot.targetFieldOverrides[nodeId] || {}) }
  if (!nextQuantityValue) {
    delete nextFieldOverrides[quantityFieldId]
  } else {
    nextFieldOverrides[quantityFieldId] = nextQuantityValue
  }
  return nextFieldOverrides
}

export function resolveItemNumberOverrideForEdit(
  snapshot: Pick<BomCloneStateSnapshot, 'sourceBomTree'>,
  nodeId: string,
  value: string
): string | null {
  const baseNode = findNode(snapshot.sourceBomTree, nodeId)
  const fallback = (baseNode?.itemNumber || '1').split('.')[1] || baseNode?.itemNumber || '1'
  const normalized = normalizeTopLevelItemNumber(value, fallback)
  return normalized === fallback ? null : normalized
}

export function resolveQuantityEdit(
  snapshot: Pick<BomCloneStateSnapshot, 'targetBomTree' | 'sourceBomTree' | 'targetFieldOverrides' | 'bomViewFields'>,
  nodeId: string,
  value: string
): QuantityEditResult {
  const baseline = resolveQuantityFallbackForNode(snapshot as BomCloneStateSnapshot, nodeId)
  const normalized = normalizeQuantity(value, DEFAULT_CLONE_QUANTITY)
  if (areQuantitiesEquivalent(normalized, baseline, DEFAULT_CLONE_QUANTITY)) {
    return {
      quantityOverride: null,
      fieldOverrides: resolveQuantityFieldOverrideForNode(snapshot, nodeId, null)
    }
  }
  return {
    quantityOverride: normalized,
    fieldOverrides: resolveQuantityFieldOverrideForNode(snapshot, nodeId, normalized)
  }
}

export function resolveRemoveTargetNode(
  snapshot: Pick<BomCloneStateSnapshot, 'selectedNodesToClone' | 'targetMarkedForDeleteNodeIds'>,
  nodeId: string
): RemoveTargetNodeResult {
  const selectedSet = new Set(snapshot.selectedNodesToClone)
  if (selectedSet.has(nodeId)) {
    selectedSet.delete(nodeId)
    return {
      nextSelectedNodeIds: Array.from(selectedSet),
      nextMarkedForDeleteNodeIds: snapshot.targetMarkedForDeleteNodeIds,
      unstageNode: true
    }
  }
  const marked = new Set(snapshot.targetMarkedForDeleteNodeIds)
  if (marked.has(nodeId)) marked.delete(nodeId)
  else marked.add(nodeId)
  return {
    nextSelectedNodeIds: snapshot.selectedNodesToClone,
    nextMarkedForDeleteNodeIds: Array.from(marked),
    unstageNode: false
  }
}

export function resolveTargetReorder(
  snapshot: Pick<
  BomCloneStateSnapshot,
  | 'cloneLaunchMode'
  | 'targetBomTree'
  | 'sourceBomTree'
  | 'selectedNodesToClone'
  | 'targetItemNumberOverrides'
  | 'manufacturingOperationBySourceNodeId'
  >,
  draggedNodeId: string,
  targetNodeId: string,
  placement: TargetReorderPlacement
): TargetReorderResult | null {
  const manufacturingReorder = resolveManufacturingStagedNodeReorder(snapshot, draggedNodeId, targetNodeId, placement)
  if (manufacturingReorder) return manufacturingReorder

  const current = snapshot.selectedNodesToClone
  const mergedTargetTree = mergeTargetTreeWithStaged(
    snapshot.targetBomTree,
    getTargetSelectedTree(snapshot.sourceBomTree, current)
  )
  const mergedRoot = mergedTargetTree[0] || null
  if (!mergedRoot) return null
  const topLevelIds = mergedRoot.children.map((node) => node.id)
  if (!topLevelIds.includes(draggedNodeId) || !topLevelIds.includes(targetNodeId)) return null
  if (placement === 'inside') return null

  let resolvedTargetNodeId = targetNodeId
  if (draggedNodeId === targetNodeId) {
    const selfIndex = topLevelIds.indexOf(draggedNodeId)
    if (selfIndex < 0) return null
    const adjacentIndex = placement === 'before' ? selfIndex - 1 : selfIndex + 1
    if (adjacentIndex < 0 || adjacentIndex >= topLevelIds.length) return null
    resolvedTargetNodeId = topLevelIds[adjacentIndex]
  }

  const topLevelWithoutDragged = topLevelIds.filter((nodeId) => nodeId !== draggedNodeId)
  const targetIndex = topLevelWithoutDragged.indexOf(resolvedTargetNodeId)
  if (targetIndex < 0) return null
  const insertIndex = placement === 'after' ? targetIndex + 1 : targetIndex
  topLevelWithoutDragged.splice(Math.min(insertIndex, topLevelWithoutDragged.length), 0, draggedNodeId)

  let nextTargetBomTree: BomCloneNode[] | null = null
  const targetRoot = snapshot.targetBomTree[0] || null
  if (targetRoot) {
    const orderIndex = new Map(topLevelWithoutDragged.map((nodeId, index) => [nodeId, index]))
    const maxIndex = topLevelWithoutDragged.length + 1
    const reorderedExistingChildren = [...targetRoot.children]
      .sort((left, right) => (orderIndex.get(left.id) ?? maxIndex) - (orderIndex.get(right.id) ?? maxIndex))
      .map((node, index) => ({ ...node, itemNumber: `1.${index + 1}` }))
    nextTargetBomTree = [
      { ...targetRoot, children: reorderedExistingChildren },
      ...snapshot.targetBomTree.slice(1)
    ]
  }

  const selectedSet = new Set(current)
  const reorderedTopLevelSelected = topLevelWithoutDragged.filter((nodeId) => selectedSet.has(nodeId))
  const remainingSelected = current.filter((nodeId) => !reorderedTopLevelSelected.includes(nodeId))
  const nextSelected = [...reorderedTopLevelSelected, ...remainingSelected]

  const topLevelNumberOverrides: Record<string, string> = {}
  for (let index = 0; index < topLevelWithoutDragged.length; index += 1) {
    topLevelNumberOverrides[topLevelWithoutDragged[index]] = `1.${index + 1}`
  }

  if (snapshot.cloneLaunchMode === 'manufacturing') {
    const nextAssignments = normalizeManufacturingAssignments(
      snapshot.targetBomTree,
      snapshot.sourceBomTree,
      nextSelected,
      snapshot.manufacturingOperationBySourceNodeId
    )
    return {
      nextTargetBomTree,
      nextSelectedNodeIds: nextSelected,
      nextTargetItemNumberOverrides: buildManufacturingItemNumberOverrides(
        { targetBomTree: snapshot.targetBomTree, sourceBomTree: snapshot.sourceBomTree },
        nextSelected,
        nextAssignments
      ),
      nextManufacturingOperationAssignments: nextAssignments
    }
  }

  return {
    nextTargetBomTree,
    nextSelectedNodeIds: nextSelected,
    nextTargetItemNumberOverrides: {
      ...snapshot.targetItemNumberOverrides,
      ...topLevelNumberOverrides
    }
  }
}

function parseTrailingItemNumber(value: string): number {
  const normalized = String(value || '').trim()
  if (!normalized) return 0
  const parts = normalized.split('.').map((part) => part.trim()).filter(Boolean)
  const tail = parts.length > 0 ? parts[parts.length - 1] : normalized
  const parsed = Number.parseInt(tail, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function isStagedOperationNode(node: BomCloneNode | null | undefined): boolean {
  return Boolean(node?.stagedOperationDraft) && String(node?.id || '').startsWith('staged-operation:')
}

export function resolveManufacturingProcessNodeIds(
  snapshot: Pick<BomCloneStateSnapshot, 'targetBomTree' | 'sourceBomTree'>
): Set<string> {
  const targetRoot = snapshot.targetBomTree[0]
  if (!targetRoot) return new Set()
  const sourceNodeIds = new Set<string>()
  collectNodeIds(snapshot.sourceBomTree, sourceNodeIds)
  const processNodeIds = new Set<string>()
  for (const node of targetRoot.children) {
    if (isStagedOperationNode(node) || !sourceNodeIds.has(node.id)) {
      processNodeIds.add(node.id)
    }
  }
  return processNodeIds
}

export function isManufacturingProcessNodeId(
  snapshot: Pick<BomCloneStateSnapshot, 'targetBomTree' | 'sourceBomTree'>,
  nodeId: string | null | undefined
): boolean {
  const normalizedNodeId = String(nodeId || '').trim()
  if (!normalizedNodeId) return false
  return resolveManufacturingProcessNodeIds(snapshot).has(normalizedNodeId)
}

function resolveOperationNodeIds(
  snapshot: Pick<BomCloneStateSnapshot, 'targetBomTree' | 'sourceBomTree'>
): Set<string> {
  return resolveManufacturingProcessNodeIds(snapshot)
}

function normalizeManufacturingAssignments(
  targetBomTree: BomCloneNode[],
  sourceBomTree: BomCloneNode[],
  selectedNodeIds: string[],
  assignments: Record<string, string>
): Record<string, string> {
  const selectedSet = new Set(selectedNodeIds)
  const operationNodeIds = resolveOperationNodeIds({ targetBomTree, sourceBomTree })
  const next: Record<string, string> = {}
  for (const [nodeId, operationNodeId] of Object.entries(assignments)) {
    if (!selectedSet.has(nodeId)) continue
    if (!operationNodeIds.has(operationNodeId)) continue
    next[nodeId] = operationNodeId
  }
  return next
}

function resolveManufacturingParentId(
  nodeId: string,
  assignments: Record<string, string>,
  operationNodeIds: Set<string>
): string | null {
  const assigned = assignments[nodeId]
  if (!assigned || !operationNodeIds.has(assigned)) return null
  return assigned
}

function findDirectParentIdInTree(nodes: BomCloneNode[], targetNodeId: string): string | null {
  const visit = (current: BomCloneNode, parentId: string | null): string | null => {
    if (current.id === targetNodeId) return parentId
    for (const child of current.children) {
      const found = visit(child, current.id)
      if (found !== null) return found
    }
    return null
  }
  for (const node of nodes) {
    const found = visit(node, null)
    if (found !== null) return found
  }
  return null
}

export function buildManufacturingItemNumberOverrides(
  snapshot: Pick<BomCloneStateSnapshot, 'targetBomTree' | 'sourceBomTree'>,
  selectedNodeIds: string[],
  assignments: Record<string, string>
): Record<string, string> {
  const targetRoot = snapshot.targetBomTree[0]
  if (!targetRoot) return {}

  const selectedSet = new Set(selectedNodeIds)
  const operationNodeIds = resolveOperationNodeIds(snapshot)
  const normalizedAssignments = normalizeManufacturingAssignments(
    snapshot.targetBomTree,
    snapshot.sourceBomTree,
    selectedNodeIds,
    assignments
  )
  const usedByParent = new Map<string, Set<number>>()
  const parentKey = (parentId: string | null): string => parentId || '__root__'
  const ensureUsedOrdinals = (parentId: string | null): Set<number> => {
    const key = parentKey(parentId)
    let entry = usedByParent.get(key)
    if (!entry) {
      entry = new Set<number>()
      usedByParent.set(key, entry)
    }
    return entry
  }
  const seedOrdinals = (parentId: string | null, nodes: BomCloneNode[]): void => {
    const used = ensureUsedOrdinals(parentId)
    for (const node of nodes) {
      if (selectedSet.has(node.id)) continue
      const ordinal = parseTrailingItemNumber(node.itemNumber)
      if (ordinal > 0) used.add(ordinal)
    }
  }

  seedOrdinals(null, targetRoot.children)
  for (const operationId of operationNodeIds) {
    const operationNode = targetRoot.children.find((child) => child.id === operationId)
    if (!operationNode) continue
    seedOrdinals(operationId, operationNode.children)
  }

  const overrides: Record<string, string> = {}
  for (const nodeId of selectedNodeIds) {
    const parentId = operationNodeIds.has(nodeId)
      ? null
      : resolveManufacturingParentId(nodeId, normalizedAssignments, operationNodeIds)
    const used = ensureUsedOrdinals(parentId)
    let nextOrdinal = 1
    while (used.has(nextOrdinal)) nextOrdinal += 1
    used.add(nextOrdinal)
    overrides[nodeId] = `1.${nextOrdinal}`
  }
  return overrides
}

function resolveManufacturingStagedNodeReorder(
  snapshot: Pick<
  BomCloneStateSnapshot,
  | 'cloneLaunchMode'
  | 'targetBomTree'
  | 'sourceBomTree'
  | 'selectedNodesToClone'
  | 'manufacturingOperationBySourceNodeId'
  >,
  draggedNodeId: string,
  targetNodeId: string,
  placement: TargetReorderPlacement
): TargetReorderResult | null {
  if (snapshot.cloneLaunchMode !== 'manufacturing') return null
  const selectedSet = new Set(snapshot.selectedNodesToClone)
  if (!selectedSet.has(draggedNodeId)) return null

  const operationNodeIds = resolveOperationNodeIds(snapshot)
  if (operationNodeIds.has(draggedNodeId)) return null

  const normalizedAssignments = normalizeManufacturingAssignments(
    snapshot.targetBomTree,
    snapshot.sourceBomTree,
    snapshot.selectedNodesToClone,
    snapshot.manufacturingOperationBySourceNodeId
  )
  const nextAssignments: Record<string, string> = { ...normalizedAssignments }
  const currentOrder = [...snapshot.selectedNodesToClone]
  const nextOrder = currentOrder.filter((nodeId) => nodeId !== draggedNodeId)
  const resolveEffectiveParentId = (nodeId: string): string | null => {
    const parentFromAssignments = resolveManufacturingParentId(nodeId, nextAssignments, operationNodeIds)
    if (parentFromAssignments) return parentFromAssignments
    const parentFromTree = findDirectParentIdInTree(snapshot.targetBomTree, nodeId)
    if (parentFromTree && operationNodeIds.has(parentFromTree)) return parentFromTree
    return null
  }

  const resolveTargetParentId = (): string | null => {
    if (placement === 'inside') return operationNodeIds.has(targetNodeId) ? targetNodeId : null
    if (operationNodeIds.has(targetNodeId)) return null
    return resolveEffectiveParentId(targetNodeId)
  }

  const destinationParentId = resolveTargetParentId()
  if (destinationParentId) nextAssignments[draggedNodeId] = destinationParentId
  else delete nextAssignments[draggedNodeId]

  let insertIndex = nextOrder.length
  if (placement === 'inside') {
    const processIndex = nextOrder.indexOf(targetNodeId)
    let lastSiblingIndex = -1
    for (let index = 0; index < nextOrder.length; index += 1) {
      const nodeId = nextOrder[index]
      if (operationNodeIds.has(nodeId)) continue
      const nodeParentId = resolveManufacturingParentId(nodeId, nextAssignments, operationNodeIds)
      if (nodeParentId === destinationParentId) lastSiblingIndex = index
    }
    if (lastSiblingIndex >= 0) insertIndex = lastSiblingIndex + 1
    else if (processIndex >= 0) insertIndex = processIndex + 1
  } else {
    const targetIndex = nextOrder.indexOf(targetNodeId)
    if (targetIndex >= 0) {
      insertIndex = placement === 'after' ? targetIndex + 1 : targetIndex
    } else {
      const siblingIndexes = nextOrder
        .map((nodeId, index) => ({ nodeId, index }))
        .filter(({ nodeId }) => !operationNodeIds.has(nodeId))
        .filter(({ nodeId }) => resolveEffectiveParentId(nodeId) === destinationParentId)
        .map(({ index }) => index)
      if (siblingIndexes.length > 0) {
        insertIndex = placement === 'before'
          ? Math.min(...siblingIndexes)
          : Math.max(...siblingIndexes) + 1
      }
    }
  }
  nextOrder.splice(Math.max(0, Math.min(insertIndex, nextOrder.length)), 0, draggedNodeId)

  return {
    nextTargetBomTree: null,
    nextSelectedNodeIds: nextOrder,
    nextTargetItemNumberOverrides: buildManufacturingItemNumberOverrides(
      { targetBomTree: snapshot.targetBomTree, sourceBomTree: snapshot.sourceBomTree },
      nextOrder,
      nextAssignments
    ),
    nextManufacturingOperationAssignments: nextAssignments
  }
}

export function resolveEditPanelSave(
  snapshot: Pick<
    BomCloneStateSnapshot,
    | 'targetBomTree'
    | 'sourceBomTree'
    | 'targetFieldOverrides'
    | 'targetQuantityOverrides'
    | 'bomViewFields'
  >,
  nodeId: string,
  values: Record<string, string>
): EditPanelSaveResult {
  const baseNode = findNode(snapshot.targetBomTree, nodeId) || findNode(snapshot.sourceBomTree, nodeId)
  const existingFieldValues = (baseNode?.bomFieldValues || {}) as Record<string, string>
  const existingOverrides = snapshot.targetFieldOverrides[nodeId] || {}
  const nextOverrides: Record<string, string> = { ...existingOverrides }
  const quantityFieldId = resolveQuantityFieldId(snapshot)
  for (const [fieldId, rawValue] of Object.entries(values)) {
    if (fieldId === TEMP_OPERATION_NAME_FIELD_ID) continue
    if (quantityFieldId && String(fieldId) === String(quantityFieldId)) continue
    const value = String(rawValue ?? '')
    const baseline = String(existingFieldValues[fieldId] ?? '')
    if (!value.trim()) {
      if (baseline) nextOverrides[fieldId] = ''
      else delete nextOverrides[fieldId]
      continue
    }
    if (value === baseline) {
      delete nextOverrides[fieldId]
      continue
    }
    nextOverrides[fieldId] = value
  }

  let nextTargetBomTree: BomCloneNode[] | null = null
  if (baseNode?.stagedOperationDraft && String(baseNode.id || '').startsWith('staged-operation:')) {
    if (Object.prototype.hasOwnProperty.call(values, TEMP_OPERATION_NAME_FIELD_ID)) {
      const nextDescriptor = String(values[TEMP_OPERATION_NAME_FIELD_ID] || '').trim()
      const currentDescriptor = String(baseNode.label || '').trim()
      if (nextDescriptor !== currentDescriptor) {
        nextTargetBomTree = updateNodeById(snapshot.targetBomTree, nodeId, (target) => ({
          ...target,
          label: nextDescriptor
        }))
      }
    }
  }

  if (!quantityFieldId) {
    return { fieldOverrides: nextOverrides, quantityOverride: null, nextTargetBomTree }
  }

  // Only update quantity semantics when the current edit surface actually submits it.
  if (!Object.prototype.hasOwnProperty.call(values, quantityFieldId)) {
    const existingQuantityOverride = Object.prototype.hasOwnProperty.call(
      snapshot.targetQuantityOverrides,
      nodeId
    )
      ? snapshot.targetQuantityOverrides[nodeId]
      : null
    return {
      fieldOverrides: nextOverrides,
      quantityOverride: existingQuantityOverride,
      nextTargetBomTree
    }
  }

  const quantityFallback = baseNode?.stagedOperationDraft ? '1.0' : DEFAULT_CLONE_QUANTITY
  const fallback = String(baseNode?.quantity || '').trim() || quantityFallback
  const rawQuantity = String(values[quantityFieldId] || '').trim()
  const normalized = normalizeQuantity(rawQuantity, quantityFallback)
  const matchesFallback = areQuantitiesEquivalent(normalized, fallback, quantityFallback)
  if (matchesFallback) delete nextOverrides[quantityFieldId]
  else nextOverrides[quantityFieldId] = normalized
  return {
    fieldOverrides: nextOverrides,
    quantityOverride: matchesFallback ? null : normalized,
    nextTargetBomTree
  }
}

export function resolveCollapseAllNodeIds(
  snapshot: Pick<BomCloneStateSnapshot, 'sourceBomTree' | 'targetBomTree'>,
  tree: 'source' | 'target'
): string[] {
  if (tree === 'source') return snapshot.sourceBomTree.map((node) => node.id)
  return snapshot.targetBomTree.map((node) => node.id)
}

export function resolveExpandAllPendingNodeIds(
  snapshot: Pick<BomCloneStateSnapshot, 'sourceBomTree' | 'selectedNodesToClone' | 'targetBomTree'>,
  tree: 'source' | 'target'
): string[] {
  const scopeNodes = tree === 'source'
    ? snapshot.sourceBomTree
    : mergeTargetTreeWithStaged(
      snapshot.targetBomTree,
      getTargetSelectedTree(snapshot.sourceBomTree, snapshot.selectedNodesToClone)
    )
  const pendingIds = new Set<string>()
  collectUnloadedExpandableNodeIds(scopeNodes, pendingIds)
  return Array.from(pendingIds)
}

function hasUnloadedExpandableSubtree(node: BomCloneNode): boolean {
  if (!node.hasExpandableChildren) return false
  if (!node.childrenLoaded) return true
  for (const child of node.children) {
    if (hasUnloadedExpandableSubtree(child)) return true
  }
  return false
}

export function resolveExpandAllFetchNodeIds(
  snapshot: Pick<BomCloneStateSnapshot, 'sourceBomTree' | 'selectedNodesToClone' | 'targetBomTree'>,
  tree: 'source' | 'target'
): string[] {
  if (tree === 'source') {
    return snapshot.sourceBomTree
      .filter((node) => hasUnloadedExpandableSubtree(node))
      .map((node) => node.id)
  }

  const mergedTarget = mergeTargetTreeWithStaged(
    snapshot.targetBomTree,
    getTargetSelectedTree(snapshot.sourceBomTree, snapshot.selectedNodesToClone)
  )
  const topLevelNodes = (mergedTarget.length === 1 && mergedTarget[0].children.length > 0)
    ? mergedTarget[0].children
    : mergedTarget

  return topLevelNodes
    .filter((node) => hasUnloadedExpandableSubtree(node))
    .map((node) => node.id)
}

export function resolveExpandAllExpandedNodeIds(
  snapshot: Pick<BomCloneStateSnapshot, 'sourceBomTree' | 'selectedNodesToClone' | 'targetBomTree'>,
  tree: 'source' | 'target'
): string[] {
  const scopeNodes = tree === 'source'
    ? snapshot.sourceBomTree
    : mergeTargetTreeWithStaged(
      snapshot.targetBomTree,
      getTargetSelectedTree(snapshot.sourceBomTree, snapshot.selectedNodesToClone)
    )
  const expandedIds = new Set<string>()
  collectExpandableNodeIds(scopeNodes, expandedIds)
  return Array.from(expandedIds)
}

export function resolveChildrenLoadContext(
  context: BomCloneContext,
  snapshot: Pick<BomCloneStateSnapshot, 'bomViewDefId' | 'cloneLaunchMode'>
): BomCloneContext {
  if (snapshot.cloneLaunchMode === 'manufacturing') {
    return { ...context, viewDefId: null }
  }
  const storedViewDefId = snapshot.bomViewDefId
  return storedViewDefId !== null && storedViewDefId !== context.viewDefId
    ? { ...context, viewDefId: storedViewDefId }
    : context
}

export function applyLoadedChildren(
  sourceTree: BomCloneNode[],
  nodeId: string,
  subtree: BomCloneNode[],
  options?: { force?: boolean }
): BomCloneNode[] {
  const latestNode = findNode(sourceTree, nodeId)
  if (!latestNode || !latestNode.hasExpandableChildren) return sourceTree
  if (latestNode.childrenLoaded && !options?.force) return sourceTree

  const subtreeRoot = subtree.find((entry) => entry.id === nodeId) || subtree[0] || null
  const parentDepth = Number(String(latestNode.itemNumber || '').split('.')[0]) || 0
  const children = (subtreeRoot?.children || []).map((child) => rebaseItemNumber(child, parentDepth))

  return updateNodeById(sourceTree, nodeId, (target) => ({
    ...target,
    children,
    childrenLoaded: true,
    hasExpandableChildren: target.hasExpandableChildren || children.length > 0
  }))
}

const SPLIT_NODE_ID_PREFIX = 'staged-split'
const QUANTITY_EPSILON = 0.000001

function parseQuantityNumber(value: string, fallback = DEFAULT_CLONE_QUANTITY): number {
  const normalized = normalizeQuantity(value, fallback)
  const parsed = Number.parseFloat(normalized)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function formatQuantityValue(value: number): string {
  const rounded = Math.round(Math.max(0, value) * 1000) / 1000
  if (Math.abs(rounded - Math.round(rounded)) < QUANTITY_EPSILON) return rounded.toFixed(1)
  return String(rounded).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

function resolveNodeBaseQuantity(
  snapshot: Pick<BomCloneStateSnapshot, 'targetBomTree' | 'sourceBomTree'>,
  nodeId: string,
  targetTree: BomCloneNode[] = snapshot.targetBomTree
): string {
  const fromTarget = findNode(targetTree, nodeId)
  if (fromTarget) return String(fromTarget.quantity || '').trim() || DEFAULT_CLONE_QUANTITY
  const fromSource = findNode(snapshot.sourceBomTree, nodeId)
  if (fromSource) return String(fromSource.quantity || '').trim() || DEFAULT_CLONE_QUANTITY
  return DEFAULT_CLONE_QUANTITY
}

function resolveNodeEffectiveQuantity(
  snapshot: Pick<BomCloneStateSnapshot, 'targetBomTree' | 'sourceBomTree' | 'targetQuantityOverrides'>,
  nodeId: string,
  quantityOverrides: Record<string, string> = snapshot.targetQuantityOverrides,
  targetTree: BomCloneNode[] = snapshot.targetBomTree
): number {
  const fallback = resolveNodeBaseQuantity(snapshot, nodeId, targetTree)
  const raw = Object.prototype.hasOwnProperty.call(quantityOverrides, nodeId)
    ? quantityOverrides[nodeId]
    : fallback
  return parseQuantityNumber(String(raw || '').trim(), fallback)
}

function resolveSplitSourceNodeId(
  snapshot: Pick<BomCloneStateSnapshot, 'targetBomTree' | 'sourceBomTree'>,
  nodeId: string,
  targetTree: BomCloneNode[] = snapshot.targetBomTree
): string | null {
  const targetNode = findNode(targetTree, nodeId)
  const splitSourceNodeId = String(targetNode?.splitSourceNodeId || '').trim()
  if (splitSourceNodeId) return splitSourceNodeId
  const sourceNode = findNode(snapshot.sourceBomTree, nodeId)
  if (sourceNode) return sourceNode.id
  return null
}

function buildSplitSourceMap(targetTree: BomCloneNode[]): Record<string, string> {
  const map: Record<string, string> = {}
  const visit = (node: BomCloneNode): void => {
    const splitSourceNodeId = String(node.splitSourceNodeId || '').trim()
    if (splitSourceNodeId) map[node.id] = splitSourceNodeId
    for (const child of node.children) visit(child)
  }
  for (const node of targetTree) visit(node)
  return map
}

function collectInstanceNodeIdsForSplitSource(
  snapshot: Pick<BomCloneStateSnapshot, 'selectedNodesToClone' | 'targetBomTree' | 'sourceBomTree'>,
  sourceNodeId: string,
  selectedNodeIds: string[] = snapshot.selectedNodesToClone,
  targetTree: BomCloneNode[] = snapshot.targetBomTree
): string[] {
  const splitSourceByNodeId = buildSplitSourceMap(targetTree)
  const instances = new Set<string>()
  const collectFromTargetTree = (nodes: BomCloneNode[]): void => {
    for (const node of nodes) {
      const splitSourceNodeId = String(node.splitSourceNodeId || '').trim()
      if (node.id === sourceNodeId || splitSourceNodeId === sourceNodeId) instances.add(node.id)
      if (node.children.length > 0) collectFromTargetTree(node.children)
    }
  }
  collectFromTargetTree(targetTree)
  for (const nodeId of selectedNodeIds) {
    if (nodeId === sourceNodeId && findNode(snapshot.sourceBomTree, nodeId)) {
      instances.add(nodeId)
      continue
    }
    if (splitSourceByNodeId[nodeId] === sourceNodeId) instances.add(nodeId)
  }
  return Array.from(instances)
}

function resolveCurrentProcessNodeId(
  assignments: Record<string, string>,
  nodeId: string
): string | null {
  const raw = String(assignments[nodeId] || '').trim()
  return raw || null
}

function resolveProcessNodeIdFromTargetTree(
  snapshot: Pick<BomCloneStateSnapshot, 'targetBomTree' | 'sourceBomTree'>,
  nodeId: string,
  targetTree: BomCloneNode[] = snapshot.targetBomTree
): string | null {
  const targetRoot = targetTree[0]
  if (!targetRoot) return null

  const visit = (node: BomCloneNode, activeProcessNodeId: string | null): string | null => {
    const nextProcessNodeId = activeProcessNodeId || (
      isManufacturingProcessNodeId(snapshot as BomCloneStateSnapshot, node.id) ? node.id : null
    )
    if (node.id === nodeId) return nextProcessNodeId
    for (const child of node.children) {
      const found = visit(child, nextProcessNodeId)
      if (found !== null) return found
    }
    return null
  }

  for (const child of targetRoot.children) {
    const found = visit(child, null)
    if (found !== null) return found
  }
  return null
}

function resolveNodeProcessNodeId(
  snapshot: Pick<BomCloneStateSnapshot, 'targetBomTree' | 'sourceBomTree' | 'manufacturingOperationBySourceNodeId'>,
  nodeId: string,
  targetTree: BomCloneNode[] = snapshot.targetBomTree,
  assignments: Record<string, string> = snapshot.manufacturingOperationBySourceNodeId
): string | null {
  const assignedProcessNodeId = resolveCurrentProcessNodeId(assignments, nodeId)
  if (assignedProcessNodeId) return assignedProcessNodeId
  return resolveProcessNodeIdFromTargetTree(snapshot, nodeId, targetTree)
}

function resolveSplitProcessOptions(
  snapshot: Pick<BomCloneStateSnapshot, 'targetBomTree' | 'sourceBomTree'>,
  excludedOperationNodeId: string | null
): ManufacturingSplitProcessOption[] {
  const targetRoot = snapshot.targetBomTree[0]
  if (!targetRoot) return []
  const processNodeIds = resolveManufacturingProcessNodeIds(snapshot)
  const options: ManufacturingSplitProcessOption[] = []
  for (const node of targetRoot.children) {
    if (!processNodeIds.has(node.id)) continue
    if (excludedOperationNodeId && node.id === excludedOperationNodeId) continue
    const label = String(node.label || '').trim() || `Process ${node.itemNumber || ''}`.trim()
    options.push({ operationNodeId: node.id, label })
  }
  return options
}

function sumAllocatedQuantityForSource(
  snapshot: Pick<BomCloneStateSnapshot, 'targetBomTree' | 'sourceBomTree' | 'targetQuantityOverrides' | 'selectedNodesToClone'>,
  sourceNodeId: string,
  selectedNodeIds: string[] = snapshot.selectedNodesToClone,
  quantityOverrides: Record<string, string> = snapshot.targetQuantityOverrides,
  targetTree: BomCloneNode[] = snapshot.targetBomTree
): number {
  const instanceNodeIds = collectInstanceNodeIdsForSplitSource(snapshot, sourceNodeId, selectedNodeIds, targetTree)
  let total = 0
  for (const instanceNodeId of instanceNodeIds) {
    total += resolveNodeEffectiveQuantity(snapshot, instanceNodeId, quantityOverrides, targetTree)
  }
  return total
}

function buildStagedSplitNodeId(existingIds: Set<string>, sourceNodeId: string): string {
  const stamp = Date.now()
  let suffix = 0
  while (true) {
    const candidate = `${SPLIT_NODE_ID_PREFIX}:${sourceNodeId}:${stamp}:${suffix}`
    if (!existingIds.has(candidate)) return candidate
    suffix += 1
  }
}

function createStagedSplitNode(params: {
  nodeId: string
  sourceNodeId: string
  baseNode: BomCloneNode
  quantity: string
}): BomCloneNode {
  const { nodeId, sourceNodeId, baseNode, quantity } = params
  return {
    ...cloneNode(baseNode),
    id: nodeId,
    itemNumber: '',
    quantity,
    stagedSplitDraft: true,
    splitSourceNodeId: sourceNodeId,
    hasExpandableChildren: false,
    childrenLoaded: true,
    children: []
  }
}

function appendSplitNodeToOperation(
  targetTree: BomCloneNode[],
  operationNodeId: string,
  splitNode: BomCloneNode
): BomCloneNode[] {
  const destinationOperation = findNode(targetTree, operationNodeId)
  if (!destinationOperation) return targetTree
  return updateNodeById(targetTree, operationNodeId, (node) => ({
    ...node,
    children: [...node.children.map(cloneNode), splitNode],
    childrenLoaded: true,
    hasExpandableChildren: true
  }))
}

function setQuantityOverrideForNode(
  snapshot: Pick<BomCloneStateSnapshot, 'targetBomTree' | 'sourceBomTree'>,
  nodeId: string,
  nextQuantityValue: string,
  quantityOverrides: Record<string, string>,
  targetTree: BomCloneNode[] = snapshot.targetBomTree
): void {
  const baseline = resolveNodeBaseQuantity(snapshot, nodeId, targetTree)
  const normalizedBaseline = normalizeQuantity(baseline, DEFAULT_CLONE_QUANTITY)
  const normalizedNext = normalizeQuantity(nextQuantityValue, normalizedBaseline)
  if (areQuantitiesEquivalent(normalizedNext, normalizedBaseline, normalizedBaseline)) {
    delete quantityOverrides[nodeId]
    return
  }
  quantityOverrides[nodeId] = normalizedNext
}

function resolveInsertIndexForOperation(
  selectedNodeIds: string[],
  assignments: Record<string, string>,
  destinationOperationNodeId: string
): number {
  let insertIndex = selectedNodeIds.length
  for (let index = 0; index < selectedNodeIds.length; index += 1) {
    const nodeId = selectedNodeIds[index]
    if (resolveCurrentProcessNodeId(assignments, nodeId) === destinationOperationNodeId) insertIndex = index + 1
  }
  if (insertIndex < selectedNodeIds.length) return insertIndex
  const operationIndex = selectedNodeIds.indexOf(destinationOperationNodeId)
  return operationIndex >= 0 ? operationIndex + 1 : selectedNodeIds.length
}

export function resolveManufacturingSplitDialogModel(
  snapshot: Pick<
    BomCloneStateSnapshot,
    | 'cloneLaunchMode'
    | 'targetBomTree'
    | 'sourceBomTree'
    | 'targetQuantityOverrides'
    | 'selectedNodesToClone'
    | 'manufacturingOperationBySourceNodeId'
  >,
  nodeId: string
): ManufacturingSplitDialogModel | null {
  if (snapshot.cloneLaunchMode !== 'manufacturing') return null
  const targetNodeInTargetTree = findNode(snapshot.targetBomTree, nodeId)
  const targetNode = targetNodeInTargetTree || findNode(snapshot.sourceBomTree, nodeId)
  const canSplitExistingTargetNode = Boolean(targetNodeInTargetTree && !targetNodeInTargetTree.stagedOperationDraft)
  if (!snapshot.selectedNodesToClone.includes(nodeId) && !canSplitExistingTargetNode) return null
  if (!targetNode || isManufacturingProcessNodeId(snapshot, nodeId)) return null

  const sourceNodeId = resolveSplitSourceNodeId(snapshot, nodeId)
  if (!sourceNodeId) return null
  const sourceNode = findNode(snapshot.sourceBomTree, sourceNodeId)
  if (!sourceNode) return null
  const sourceTotalQuantity = parseQuantityNumber(String(sourceNode.quantity || '').trim(), DEFAULT_CLONE_QUANTITY)

  const currentQuantity = resolveNodeEffectiveQuantity(snapshot, nodeId)
  if (currentQuantity <= 0) return null
  const currentProcessNodeId = resolveNodeProcessNodeId(snapshot, nodeId)
  const processOptions = resolveSplitProcessOptions(snapshot, currentProcessNodeId)

  return {
    sourceNodeId,
    descriptor: targetNode.label,
    totalQuantity: formatQuantityValue(sourceTotalQuantity),
    remainingQuantity: formatQuantityValue(currentQuantity),
    currentQuantity: formatQuantityValue(currentQuantity),
    maxSplitQuantity: formatQuantityValue(Math.max(0, currentQuantity - 0.001)),
    unitOfMeasure: String(sourceNode.unitOfMeasure || targetNode.unitOfMeasure || '').trim(),
    processOptions
  }
}

export function resolveManufacturingSourceSplitDialogModel(
  snapshot: Pick<
    BomCloneStateSnapshot,
    | 'cloneLaunchMode'
    | 'targetBomTree'
    | 'sourceBomTree'
    | 'targetQuantityOverrides'
    | 'selectedNodesToClone'
    | 'manufacturingOperationBySourceNodeId'
  >,
  sourceNodeId: string
): ManufacturingSplitDialogModel | null {
  if (snapshot.cloneLaunchMode !== 'manufacturing') return null
  const sourceNode = findNode(snapshot.sourceBomTree, sourceNodeId)
  if (!sourceNode || !isComponentNode(sourceNode)) return null

  const sourceTotalQuantity = parseQuantityNumber(String(sourceNode.quantity || '').trim(), DEFAULT_CLONE_QUANTITY)
  if (sourceTotalQuantity <= 0) return null
  const allocatedQuantity = sumAllocatedQuantityForSource(snapshot, sourceNodeId)
  const remainingQuantity = sourceTotalQuantity - allocatedQuantity
  if (remainingQuantity <= QUANTITY_EPSILON) return null

  return {
    sourceNodeId,
    descriptor: sourceNode.label,
    totalQuantity: formatQuantityValue(sourceTotalQuantity),
    remainingQuantity: formatQuantityValue(remainingQuantity),
    currentQuantity: formatQuantityValue(remainingQuantity),
    maxSplitQuantity: formatQuantityValue(remainingQuantity),
    unitOfMeasure: String(sourceNode.unitOfMeasure || '').trim(),
    processOptions: resolveSplitProcessOptions(snapshot, null)
  }
}

export function resolveManufacturingSourceSplit(
  snapshot: Pick<
    BomCloneStateSnapshot,
    | 'cloneLaunchMode'
    | 'targetBomTree'
    | 'sourceBomTree'
    | 'targetQuantityOverrides'
    | 'selectedNodesToClone'
    | 'manufacturingOperationBySourceNodeId'
  >,
  params: {
    sourceNodeId: string
    destinationOperationNodeId: string
    splitQuantity: string
  }
): ManufacturingSplitApplyResult {
  const { sourceNodeId, splitQuantity } = params
  const destinationOperationNodeId = String(params.destinationOperationNodeId || '').trim()
  if (snapshot.cloneLaunchMode !== 'manufacturing') {
    return { ok: false, errorMessage: 'Split is only available in manufacturing mode.' }
  }

  const sourceNode = findNode(snapshot.sourceBomTree, sourceNodeId)
  if (!sourceNode || !isComponentNode(sourceNode)) {
    return { ok: false, errorMessage: 'Only component rows can be staged from source split.' }
  }

  const processNodeIds = resolveManufacturingProcessNodeIds(snapshot)
  const hasAnyProcess = processNodeIds.size > 0
  const useRootDestination = !destinationOperationNodeId

  if (useRootDestination && hasAnyProcess) {
    return { ok: false, errorMessage: 'Select a destination process.' }
  }

  const destinationOperation = useRootDestination
    ? null
    : findNode(snapshot.targetBomTree, destinationOperationNodeId)
  if (!useRootDestination && (!destinationOperation || !processNodeIds.has(destinationOperationNodeId))) {
    return { ok: false, errorMessage: 'Selected destination process is no longer available.' }
  }

  const sourceTotalQuantity = parseQuantityNumber(String(sourceNode.quantity || '').trim(), DEFAULT_CLONE_QUANTITY)
  if (sourceTotalQuantity <= 0) {
    return { ok: false, errorMessage: 'Source quantity must be greater than zero to split.' }
  }

  const allocatedBefore = sumAllocatedQuantityForSource(snapshot, sourceNodeId)
  const remainingQuantity = sourceTotalQuantity - allocatedBefore
  if (remainingQuantity <= QUANTITY_EPSILON) {
    return { ok: false, errorMessage: 'No source quantity remains to allocate.' }
  }

  const splitQuantityNumber = parseQuantityNumber(splitQuantity, DEFAULT_CLONE_QUANTITY)
  if (splitQuantityNumber <= 0) {
    return { ok: false, errorMessage: 'Split quantity must be greater than zero.' }
  }
  if (splitQuantityNumber > remainingQuantity + QUANTITY_EPSILON) {
    return { ok: false, errorMessage: 'Split quantity exceeds remaining source quantity.' }
  }

  let nextTargetBomTree = snapshot.targetBomTree.map(cloneNode)
  const nextSelectedNodeIds = [...snapshot.selectedNodesToClone]
  const nextTargetQuantityOverrides = { ...snapshot.targetQuantityOverrides }
  const nextAssignments = { ...snapshot.manufacturingOperationBySourceNodeId }

  const sourceInstanceNodeIds = collectInstanceNodeIdsForSplitSource(snapshot, sourceNodeId)
  if (useRootDestination) {
    const existingRootNodeId = sourceInstanceNodeIds.find((instanceNodeId) => !resolveCurrentProcessNodeId(nextAssignments, instanceNodeId)) || null
    if (existingRootNodeId) {
      const mergeCurrentQuantity = resolveNodeEffectiveQuantity(
        snapshot,
        existingRootNodeId,
        nextTargetQuantityOverrides,
        nextTargetBomTree
      )
      const mergeNextQuantity = mergeCurrentQuantity + splitQuantityNumber
      setQuantityOverrideForNode(
        snapshot,
        existingRootNodeId,
        formatQuantityValue(mergeNextQuantity),
        nextTargetQuantityOverrides,
        nextTargetBomTree
      )
      if (!nextSelectedNodeIds.includes(existingRootNodeId)) nextSelectedNodeIds.push(existingRootNodeId)
    }
    else {
      if (!nextSelectedNodeIds.includes(sourceNodeId)) nextSelectedNodeIds.push(sourceNodeId)
      delete nextAssignments[sourceNodeId]
      setQuantityOverrideForNode(
        snapshot,
        sourceNodeId,
        formatQuantityValue(splitQuantityNumber),
        nextTargetQuantityOverrides,
        nextTargetBomTree
      )
    }
  } else {
    const mergeTargetNodeId = sourceInstanceNodeIds.find((instanceNodeId) => (
      resolveCurrentProcessNodeId(nextAssignments, instanceNodeId) === destinationOperationNodeId
    )) || null

    if (mergeTargetNodeId) {
      const mergeCurrentQuantity = resolveNodeEffectiveQuantity(
        snapshot,
        mergeTargetNodeId,
        nextTargetQuantityOverrides,
        nextTargetBomTree
      )
      const mergeNextQuantity = mergeCurrentQuantity + splitQuantityNumber
      setQuantityOverrideForNode(
        snapshot,
        mergeTargetNodeId,
        formatQuantityValue(mergeNextQuantity),
        nextTargetQuantityOverrides,
        nextTargetBomTree
      )
    } else {
      const existingNodeIds = new Set<string>()
      collectNodeIds(nextTargetBomTree, existingNodeIds)
      for (const selectedNodeId of nextSelectedNodeIds) existingNodeIds.add(selectedNodeId)
      const splitNodeId = buildStagedSplitNodeId(existingNodeIds, sourceNodeId)
      const splitNode = createStagedSplitNode({
        nodeId: splitNodeId,
        sourceNodeId,
        baseNode: cloneNode(sourceNode),
        quantity: formatQuantityValue(splitQuantityNumber)
      })
      nextTargetBomTree = appendSplitNodeToOperation(nextTargetBomTree, destinationOperationNodeId, splitNode)
      const insertIndex = resolveInsertIndexForOperation(nextSelectedNodeIds, nextAssignments, destinationOperationNodeId)
      nextSelectedNodeIds.splice(insertIndex, 0, splitNodeId)
      nextAssignments[splitNodeId] = destinationOperationNodeId
    }
  }

  const allocatedAfter = sumAllocatedQuantityForSource(
    snapshot,
    sourceNodeId,
    nextSelectedNodeIds,
    nextTargetQuantityOverrides,
    nextTargetBomTree
  )
  if (allocatedAfter > sourceTotalQuantity + QUANTITY_EPSILON) {
    return { ok: false, errorMessage: 'Split exceeds source quantity across process allocations.' }
  }

  return {
    ok: true,
    nextTargetBomTree,
    nextSelectedNodeIds,
    nextTargetQuantityOverrides,
    nextManufacturingOperationAssignments: nextAssignments,
    nextTargetItemNumberOverrides: buildManufacturingItemNumberOverrides(
      { targetBomTree: nextTargetBomTree, sourceBomTree: snapshot.sourceBomTree },
      nextSelectedNodeIds,
      nextAssignments
    )
  }
}

export function resolveManufacturingSplit(
  snapshot: Pick<
    BomCloneStateSnapshot,
    | 'cloneLaunchMode'
    | 'targetBomTree'
    | 'sourceBomTree'
    | 'targetQuantityOverrides'
    | 'selectedNodesToClone'
    | 'manufacturingOperationBySourceNodeId'
  >,
  params: {
    nodeId: string
    destinationOperationNodeId: string
    splitQuantity: string
  }
): ManufacturingSplitApplyResult {
  const { nodeId, destinationOperationNodeId, splitQuantity } = params
  if (snapshot.cloneLaunchMode !== 'manufacturing') {
    return { ok: false, errorMessage: 'Split is only available in manufacturing mode.' }
  }
  const targetNodeInTargetTree = findNode(snapshot.targetBomTree, nodeId)
  const canSplitExistingTargetNode = Boolean(targetNodeInTargetTree && !targetNodeInTargetTree.stagedOperationDraft)
  if (!snapshot.selectedNodesToClone.includes(nodeId) && !canSplitExistingTargetNode) {
    return { ok: false, errorMessage: 'Selected row is no longer available for split.' }
  }

  const targetNode = targetNodeInTargetTree || findNode(snapshot.sourceBomTree, nodeId)
  if (!targetNode || isManufacturingProcessNodeId(snapshot, nodeId)) {
    return { ok: false, errorMessage: 'Only component rows can be split.' }
  }

  const sourceNodeId = resolveSplitSourceNodeId(snapshot, nodeId)
  if (!sourceNodeId) {
    return { ok: false, errorMessage: 'Unable to resolve source component for split.' }
  }
  const sourceNode = findNode(snapshot.sourceBomTree, sourceNodeId)
  if (!sourceNode) {
    return { ok: false, errorMessage: 'Source component is unavailable for split validation.' }
  }
  const sourceTotalQuantity = parseQuantityNumber(String(sourceNode.quantity || '').trim(), DEFAULT_CLONE_QUANTITY)
  if (sourceTotalQuantity <= 0) {
    return { ok: false, errorMessage: 'Source quantity must be greater than zero to split.' }
  }

  const currentProcessNodeId = resolveNodeProcessNodeId(snapshot, nodeId)
  if (currentProcessNodeId && destinationOperationNodeId === currentProcessNodeId) {
    return { ok: false, errorMessage: 'Select a different process to split into.' }
  }
  const processNodeIds = resolveManufacturingProcessNodeIds(snapshot)
  const destinationOperation = findNode(snapshot.targetBomTree, destinationOperationNodeId)
  if (!destinationOperation || !processNodeIds.has(destinationOperationNodeId)) {
    return { ok: false, errorMessage: 'Selected destination process is no longer available.' }
  }

  const currentQuantity = resolveNodeEffectiveQuantity(snapshot, nodeId)
  const splitQuantityNumber = parseQuantityNumber(splitQuantity, DEFAULT_CLONE_QUANTITY)
  if (splitQuantityNumber <= 0) {
    return { ok: false, errorMessage: 'Split quantity must be greater than zero.' }
  }
  if (splitQuantityNumber >= currentQuantity) {
    return { ok: false, errorMessage: 'Split quantity must be less than the current quantity.' }
  }

  const allocatedBefore = sumAllocatedQuantityForSource(snapshot, sourceNodeId)
  if (allocatedBefore > sourceTotalQuantity + QUANTITY_EPSILON) {
    return { ok: false, errorMessage: 'Cannot split while allocated quantity exceeds source quantity.' }
  }

  let nextTargetBomTree = snapshot.targetBomTree.map(cloneNode)
  const nextSelectedNodeIds = [...snapshot.selectedNodesToClone]
  const nextTargetQuantityOverrides = { ...snapshot.targetQuantityOverrides }
  const nextAssignments = { ...snapshot.manufacturingOperationBySourceNodeId }

  const nextSourceQuantity = currentQuantity - splitQuantityNumber
  setQuantityOverrideForNode(
    snapshot,
    nodeId,
    formatQuantityValue(nextSourceQuantity),
    nextTargetQuantityOverrides,
    nextTargetBomTree
  )

  const sourceInstanceNodeIds = collectInstanceNodeIdsForSplitSource(snapshot, sourceNodeId)
  const mergeTargetNodeId = sourceInstanceNodeIds.find((instanceNodeId) => (
    instanceNodeId !== nodeId
    && resolveCurrentProcessNodeId(nextAssignments, instanceNodeId) === destinationOperationNodeId
  )) || null

  if (mergeTargetNodeId) {
    const mergeCurrentQuantity = resolveNodeEffectiveQuantity(
      snapshot,
      mergeTargetNodeId,
      nextTargetQuantityOverrides,
      nextTargetBomTree
    )
    const mergeNextQuantity = mergeCurrentQuantity + splitQuantityNumber
    setQuantityOverrideForNode(
      snapshot,
      mergeTargetNodeId,
      formatQuantityValue(mergeNextQuantity),
      nextTargetQuantityOverrides,
      nextTargetBomTree
    )
  } else {
    const existingNodeIds = new Set<string>()
    collectNodeIds(nextTargetBomTree, existingNodeIds)
    for (const selectedNodeId of nextSelectedNodeIds) existingNodeIds.add(selectedNodeId)
    const splitNodeId = buildStagedSplitNodeId(existingNodeIds, sourceNodeId)
    const splitNode = createStagedSplitNode({
      nodeId: splitNodeId,
      sourceNodeId,
      baseNode: cloneNode(sourceNode),
      quantity: formatQuantityValue(splitQuantityNumber)
    })
    nextTargetBomTree = appendSplitNodeToOperation(nextTargetBomTree, destinationOperationNodeId, splitNode)
    const insertIndex = resolveInsertIndexForOperation(nextSelectedNodeIds, nextAssignments, destinationOperationNodeId)
    nextSelectedNodeIds.splice(insertIndex, 0, splitNodeId)
    nextAssignments[splitNodeId] = destinationOperationNodeId
  }

  const allocatedAfter = sumAllocatedQuantityForSource(
    snapshot,
    sourceNodeId,
    nextSelectedNodeIds,
    nextTargetQuantityOverrides,
    nextTargetBomTree
  )
  if (allocatedAfter > sourceTotalQuantity + QUANTITY_EPSILON) {
    return { ok: false, errorMessage: 'Split exceeds source quantity across process allocations.' }
  }

  return {
    ok: true,
    nextTargetBomTree,
    nextSelectedNodeIds,
    nextTargetQuantityOverrides,
    nextManufacturingOperationAssignments: nextAssignments,
    nextTargetItemNumberOverrides: buildManufacturingItemNumberOverrides(
      { targetBomTree: nextTargetBomTree, sourceBomTree: snapshot.sourceBomTree },
      nextSelectedNodeIds,
      nextAssignments
    )
  }
}

