import {
  buildSelectedTree
} from './structure/selection.service'
import {
  collectNodeIds,
  findNode,
  flattenNodesForDisplay,
  mergeTargetTreeWithStagedByOperation,
  mergeTargetTreeWithStaged
} from './structure/tree.service'
import {
  DEFAULT_CLONE_QUANTITY,
  normalizeQuantity
} from './normalize.service'
import type { BomCloneLinkableItem, BomCloneNode, BomCloneStateSnapshot, FormFieldDefinition } from '../clone.types'
import { resolveQuantityFieldId } from './field.service'
import { isManufacturingProcessNodeId } from './structure/structure.service'

export type RequiredFieldCompletion = {
  isComplete: boolean
  missingCount: number
  requiredCount: number
}

export type SourceRowStatus = 'not-added' | 'modified' | 'added'
export type SourceRowDiscrepancySeverity = 'none' | 'under' | 'over'
export type SourceRowDiscrepancy = {
  severity: SourceRowDiscrepancySeverity
  sourceQuantity: string
  allocatedQuantity: string
  remainingQuantity: string
  tooltip: string | null
}

export type CloneStructureViewModel = {
  sourceRoot: TreeNode | null
  targetRoot: TreeNode | null
  pendingAddNodeIds: Set<string>
  selectedNodeIds: Set<string>
  markedForDeleteIds: Set<string>
  targetExistingNodeIds: Set<string>
  targetTableNodeIds: Set<string>
  existingTopLevelNodeIds: Set<string>
  stagedTopLevelNodeIds: Set<string>
  flatSourceRows: ReturnType<typeof flattenNodesForDisplay>
  filteredSourceRows: ReturnType<typeof flattenNodesForDisplay>
  sourceStatusByNodeId: Record<string, SourceRowStatus>
  sourceDiscrepancyByNodeId: Record<string, SourceRowDiscrepancy>
  sourceAllLeafPartsOnTargetByNodeId: Record<string, boolean>
  sourceStatusCounts: {
    notAdded: number
    modified: number
    added: number
    total: number
  }
  sourceStatusQuantities: {
    notAdded: number
    modified: number
    added: number
    total: number
  }
  selectedRows: ReturnType<typeof flattenNodesForDisplay>
}

export type CloneOperationCounts = {
  deleteCount: number
  updateCount: number
  addCount: number
  createCount: number
  newCount: number
}

export type CloneCommitProgressBreakdown = {
  overallTotal: number
  overallCurrent: number
  createDone: number
  deleteDone: number
  addDone: number
  updateDone: number
  newDone: number
}

export type CloneRequiredWarningSummary = {
  blockingWarningCount: number
  hasBlockingWarnings: boolean
}

export type RowRequiredValidationSummary = {
  combined: RequiredFieldCompletion
  bom: RequiredFieldCompletion
  itemDetails: RequiredFieldCompletion | null
  tooltip: string
}

export type CloneEditPanelViewModel = {
  fields: FormFieldDefinition[]
  sections: Array<{
    title: string
    expandedByDefault: boolean
    fields: FormFieldDefinition[]
  }>
  requiredEditableFields: FormFieldDefinition[]
  quantityFieldId: string | null
  fallbackQuantity: string
  activeInsertDraft: {
    payload: Map<string, string>
    display: Map<string, string>
    source: 'clone'
  }
}

export type CloneLinkableDialogItemViewModel = {
  item: BomCloneLinkableItem
  isSelected: boolean
  isOnTargetBom: boolean
  isPotentialDuplicate: boolean
  errorMessage: string | null
}

export type CloneLinkableDialogViewModel = {
  rows: CloneLinkableDialogItemViewModel[]
  showInitialLoading: boolean
  showTrailingLoading: boolean
  emptyMessage: string | null
  visibleCount: number
}

type TreeNode = BomCloneStateSnapshot['sourceBomTree'][number]

function asTreeNode(node: TreeNode | null | undefined): TreeNode | null {
  return node || null
}

function isImageFieldDefinition(field: FormFieldDefinition): boolean {
  if (field.typeId === 15) return true
  const typeTitle = String(field.typeTitle || '').trim().toLowerCase()
  return typeTitle === 'image'
}

function prependRootDescriptorRow(
  rows: ReturnType<typeof flattenNodesForDisplay>,
  rootNode: TreeNode | null
): ReturnType<typeof flattenNodesForDisplay> {
  if (!rootNode) return rows
  return [
    {
      id: rootNode.id,
      node: rootNode,
      level: -1,
      hasChildren: rootNode.hasExpandableChildren || rootNode.children.length > 0,
      expanded: true
    },
    ...rows
  ]
}

function normalizeLabelForRevisionCompare(label: string): string {
  return label
    .trim()
    .replace(/\s*\[REV:[^\]]*\]\s*$/i, '')
    .trim()
    .toLowerCase()
}

function collectStagedSourceLabels(
  nodes: BomCloneNode[],
  stagedSourceNodeIds: Set<string>,
  output: Set<string>
): void {
  for (const node of nodes) {
    if (!node.fromLinkableDialog && stagedSourceNodeIds.has(node.id)) {
      const normalized = normalizeLabelForRevisionCompare(node.label)
      if (normalized) output.add(normalized)
    }
    collectStagedSourceLabels(node.children, stagedSourceNodeIds, output)
  }
}

export function computeRequiredFieldCompletion(
  requiredFields: Array<Pick<FormFieldDefinition, 'fieldId' | 'defaultValue'>>,
  overrides: Record<string, string> | null | undefined
): RequiredFieldCompletion {
  const requiredCount = requiredFields.length
  if (requiredCount === 0) return { isComplete: true, missingCount: 0, requiredCount: 0 }

  let missingCount = 0
  for (const field of requiredFields) {
    const overrideValue = String(overrides?.[field.fieldId] ?? '').trim()
    const defaultValue = String(field.defaultValue ?? '').trim()
    if (!overrideValue && !defaultValue) missingCount += 1
  }
  return { isComplete: missingCount === 0, missingCount, requiredCount }
}

function formatRequiredCompletionMessage(completion: RequiredFieldCompletion): string {
  if (completion.requiredCount === 0 || completion.isComplete) return 'All required fields completed.'
  const plural = completion.missingCount === 1 ? 'field' : 'fields'
  return `${completion.missingCount} required ${plural} missing.`
}

export function buildRowRequiredValidationSummary(
  snapshot: Pick<
    BomCloneStateSnapshot,
    | 'cloneLaunchMode'
    | 'bomViewFields'
    | 'operationFormFields'
    | 'operationFormFieldsLoading'
    | 'targetFieldOverrides'
  >,
  row: Pick<BomCloneNode, 'id' | 'stagedOperationDraft' | 'bomFieldValues'>,
  includeItemDetailsValidation: boolean
): RowRequiredValidationSummary {
  const effectiveFieldValues = {
    ...(row.bomFieldValues || {}),
    ...(snapshot.targetFieldOverrides[row.id] || {})
  }

  const bomRequiredEditableFields = snapshot.bomViewFields.filter((field) => field.required && field.editable)
  const bomCompletion = computeRequiredFieldCompletion(bomRequiredEditableFields, effectiveFieldValues)

  let itemDetailsCompletion: RequiredFieldCompletion | null = null
  let itemDetailsMessage = 'All required fields completed.'

  if (
    includeItemDetailsValidation
    && snapshot.cloneLaunchMode === 'manufacturing'
    && row.stagedOperationDraft
  ) {
    if (snapshot.operationFormFieldsLoading) {
      itemDetailsMessage = 'Required-field metadata is loading.'
    } else {
      const itemRequiredEditableFields = snapshot.operationFormFields.filter(
        (field) => field.required && field.editable && field.visible
      )
      itemDetailsCompletion = computeRequiredFieldCompletion(itemRequiredEditableFields, effectiveFieldValues)
      itemDetailsMessage = formatRequiredCompletionMessage(itemDetailsCompletion)
    }
  }

  const combined: RequiredFieldCompletion = {
    requiredCount: bomCompletion.requiredCount + (itemDetailsCompletion?.requiredCount || 0),
    missingCount: bomCompletion.missingCount + (itemDetailsCompletion?.missingCount || 0),
    isComplete: bomCompletion.isComplete && (itemDetailsCompletion ? itemDetailsCompletion.isComplete : true)
  }

  const tooltip = itemDetailsCompletion || (includeItemDetailsValidation && row.stagedOperationDraft)
    ? `Item Details: ${itemDetailsMessage}\nBOM Details: ${formatRequiredCompletionMessage(bomCompletion)}`
    : `BOM Details: ${formatRequiredCompletionMessage(bomCompletion)}`

  return {
    combined,
    bom: bomCompletion,
    itemDetails: itemDetailsCompletion,
    tooltip
  }
}

const SOURCE_QTY_EPSILON = 0.000001

function parseQuantityNumber(value: string, fallback = DEFAULT_CLONE_QUANTITY): number {
  const normalized = normalizeQuantity(value, fallback)
  const parsed = Number.parseFloat(normalized)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatQuantityValue(value: number): string {
  const rounded = Math.round(Math.max(0, value) * 1000) / 1000
  if (Math.abs(rounded - Math.round(rounded)) < SOURCE_QTY_EPSILON) return rounded.toFixed(1)
  return String(rounded).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

function resolveLeafSourceStatus(
  node: BomCloneNode,
  targetQuantityByNodeId: Record<string, string>
): SourceRowStatus {
  const sourceQty = parseQuantityNumber(String(node.quantity || '').trim(), DEFAULT_CLONE_QUANTITY)
  const targetQty = parseQuantityNumber(String(targetQuantityByNodeId[node.id] || '').trim(), DEFAULT_CLONE_QUANTITY)
  if (targetQty <= SOURCE_QTY_EPSILON) return 'not-added'
  if (Math.abs(targetQty - sourceQty) > SOURCE_QTY_EPSILON) return 'modified'
  return 'added'
}

function collectEffectiveTargetQuantityBySourceNodeId(
  nodes: BomCloneNode[],
  targetQuantityOverrides: Record<string, string>,
  markedForDeleteNodeIds: Set<string>
): Record<string, string> {
  const byNodeId: Record<string, number> = {}
  const visit = (node: BomCloneNode, ancestorMarkedForDelete = false): void => {
    const nodeMarkedForDelete = ancestorMarkedForDelete || markedForDeleteNodeIds.has(node.id)
    if (!node.stagedOperationDraft && !nodeMarkedForDelete) {
      const sourceNodeId = String(node.splitSourceNodeId || node.id || '').trim()
      if (sourceNodeId) {
        const rawQuantity = Object.prototype.hasOwnProperty.call(targetQuantityOverrides, node.id)
          ? targetQuantityOverrides[node.id]
          : String(node.quantity || '')
        const quantity = Number.parseFloat(normalizeQuantity(rawQuantity, DEFAULT_CLONE_QUANTITY))
        if (Number.isFinite(quantity) && quantity >= 0) {
          byNodeId[sourceNodeId] = (byNodeId[sourceNodeId] || 0) + quantity
        }
      }
    }
    for (const child of node.children) visit(child, nodeMarkedForDelete)
  }
  for (const node of nodes) visit(node)
  return Object.fromEntries(
    Object.entries(byNodeId).map(([nodeId, quantity]) => [nodeId, String(quantity)])
  )
}

function resolveAggregateAssemblyStatus(childStatuses: SourceRowStatus[]): SourceRowStatus {
  if (childStatuses.some((entry) => entry === 'modified')) return 'modified'
  if (childStatuses.length > 0 && childStatuses.every((entry) => entry === 'added')) return 'added'
  return 'not-added'
}

function buildSourceStatusByNodeId(
  nodes: BomCloneNode[],
  targetQuantityByNodeId: Record<string, string>
): Record<string, SourceRowStatus> {
  const byNodeId: Record<string, SourceRowStatus> = {}

  const visit = (node: BomCloneNode): SourceRowStatus => {
    if (node.children.length === 0) {
      const status = resolveLeafSourceStatus(node, targetQuantityByNodeId)
      byNodeId[node.id] = status
      return status
    }

    const childStatuses = node.children.map((child) => visit(child))
    const status = resolveAggregateAssemblyStatus(childStatuses)
    byNodeId[node.id] = status
    return status
  }

  for (const node of nodes) visit(node)
  return byNodeId
}

function buildSourceDiscrepancyByNodeId(
  nodes: BomCloneNode[],
  targetQuantityByNodeId: Record<string, string>
): Record<string, SourceRowDiscrepancy> {
  const byNodeId: Record<string, SourceRowDiscrepancy> = {}

  const visit = (node: BomCloneNode): SourceRowDiscrepancy => {
    if (node.children.length === 0) {
      const sourceQuantity = parseQuantityNumber(String(node.quantity || '').trim(), DEFAULT_CLONE_QUANTITY)
      const allocatedQuantity = parseQuantityNumber(
        String(targetQuantityByNodeId[node.id] || '').trim(),
        DEFAULT_CLONE_QUANTITY
      )
      if (allocatedQuantity <= SOURCE_QTY_EPSILON) {
        const none: SourceRowDiscrepancy = {
          severity: 'none',
          sourceQuantity: formatQuantityValue(sourceQuantity),
          allocatedQuantity: formatQuantityValue(allocatedQuantity),
          remainingQuantity: formatQuantityValue(sourceQuantity),
          tooltip: null
        }
        byNodeId[node.id] = none
        return none
      }
      const delta = sourceQuantity - allocatedQuantity

      if (Math.abs(delta) <= SOURCE_QTY_EPSILON) {
        const none: SourceRowDiscrepancy = {
          severity: 'none',
          sourceQuantity: formatQuantityValue(sourceQuantity),
          allocatedQuantity: formatQuantityValue(allocatedQuantity),
          remainingQuantity: '0.0',
          tooltip: null
        }
        byNodeId[node.id] = none
        return none
      }

      if (delta > 0) {
        const remaining = formatQuantityValue(delta)
        const under: SourceRowDiscrepancy = {
          severity: 'under',
          sourceQuantity: formatQuantityValue(sourceQuantity),
          allocatedQuantity: formatQuantityValue(allocatedQuantity),
          remainingQuantity: remaining,
          tooltip: `Allocated ${formatQuantityValue(allocatedQuantity)} of ${formatQuantityValue(sourceQuantity)}. Remaining ${remaining}.`
        }
        byNodeId[node.id] = under
        return under
      }

      const exceededBy = formatQuantityValue(Math.abs(delta))
      const over: SourceRowDiscrepancy = {
        severity: 'over',
        sourceQuantity: formatQuantityValue(sourceQuantity),
        allocatedQuantity: formatQuantityValue(allocatedQuantity),
        remainingQuantity: '0.0',
        tooltip: `Allocated ${formatQuantityValue(allocatedQuantity)} exceeds source ${formatQuantityValue(sourceQuantity)} by ${exceededBy}.`
      }
      byNodeId[node.id] = over
      return over
    }

    const childDiscrepancies = node.children.map((child) => visit(child))
    const severity: SourceRowDiscrepancySeverity = childDiscrepancies.some((entry) => entry.severity === 'over')
      ? 'over'
      : childDiscrepancies.some((entry) => entry.severity === 'under')
        ? 'under'
        : 'none'
    const aggregate: SourceRowDiscrepancy = {
      severity,
      sourceQuantity: '0.0',
      allocatedQuantity: '0.0',
      remainingQuantity: '0.0',
      tooltip: null
    }
    byNodeId[node.id] = aggregate
    return aggregate
  }

  for (const node of nodes) visit(node)
  return byNodeId
}

function buildSourceAllLeafPartsOnTargetByNodeId(
  nodes: BomCloneNode[],
  sourceStatusByNodeId: Record<string, SourceRowStatus>
): Record<string, boolean> {
  const byNodeId: Record<string, boolean> = {}

  const visit = (node: BomCloneNode): boolean => {
    if (node.children.length === 0) {
      const isFullyAdded = (sourceStatusByNodeId[node.id] || 'not-added') === 'added'
      byNodeId[node.id] = isFullyAdded
      return isFullyAdded
    }

    const allChildrenOnTarget = node.children.every((child) => visit(child))
    byNodeId[node.id] = allChildrenOnTarget
    return allChildrenOnTarget
  }

  for (const node of nodes) visit(node)
  return byNodeId
}

function buildSourceStatusCounts(
  rows: ReturnType<typeof flattenNodesForDisplay>,
  sourceStatusByNodeId: Record<string, SourceRowStatus>
): CloneStructureViewModel['sourceStatusCounts'] {
  let notAdded = 0
  let modified = 0
  let added = 0
  for (const row of rows) {
    if (row.level < 0) continue
    const status = sourceStatusByNodeId[row.id] || 'not-added'
    if (status === 'not-added') notAdded += 1
    else if (status === 'modified') modified += 1
    else added += 1
  }
  return {
    notAdded,
    modified,
    added,
    total: notAdded + modified + added
  }
}

function buildSourceStatusQuantities(
  nodes: BomCloneNode[],
  sourceStatusByNodeId: Record<string, SourceRowStatus>
): CloneStructureViewModel['sourceStatusQuantities'] {
  let notAdded = 0
  let modified = 0
  let added = 0

  const visit = (node: BomCloneNode): void => {
    if (node.children.length > 0) {
      for (const child of node.children) visit(child)
      return
    }

    const quantity = parseQuantityNumber(String(node.quantity || '').trim(), DEFAULT_CLONE_QUANTITY)
    const status = sourceStatusByNodeId[node.id] || 'not-added'
    if (status === 'not-added') notAdded += quantity
    else if (status === 'modified') modified += quantity
    else added += quantity
  }

  for (const node of nodes) visit(node)
  return {
    notAdded,
    modified,
    added,
    total: notAdded + modified + added
  }
}

function filterSourceRowsByStatus(
  rows: ReturnType<typeof flattenNodesForDisplay>,
  sourceStatusByNodeId: Record<string, SourceRowStatus>,
  filter: BomCloneStateSnapshot['sourceStatusFilter']
): ReturnType<typeof flattenNodesForDisplay> {
  if (filter === 'all') return rows

  const parentById = new Map<string, string | null>()
  const ancestry: Array<{ id: string; level: number }> = []
  for (const row of rows) {
    if (row.level < 0) continue
    while (ancestry.length > 0 && ancestry[ancestry.length - 1].level >= row.level) ancestry.pop()
    parentById.set(row.id, ancestry.length > 0 ? ancestry[ancestry.length - 1].id : null)
    ancestry.push({ id: row.id, level: row.level })
  }

  const includedIds = new Set<string>()
  for (const row of rows) {
    if (row.level < 0) continue
    const status = sourceStatusByNodeId[row.id] || 'not-added'
    if (status !== filter) continue
    let currentId: string | null = row.id
    while (currentId) {
      includedIds.add(currentId)
      currentId = parentById.get(currentId) || null
    }
  }

  return rows.filter((row) => row.level < 0 || includedIds.has(row.id))
}

export function buildStructureViewModel(snapshot: BomCloneStateSnapshot): CloneStructureViewModel {
  const sourceRoot = asTreeNode(snapshot.sourceBomTree[0])
  const targetRoot = asTreeNode(snapshot.targetBomTree[0])
  const pendingAddNodeIds = new Set(snapshot.pendingAddNodeIds)
  const selectedNodeOrder = snapshot.selectedNodesToClone.filter((nodeId) => nodeId !== sourceRoot?.id)
  const selectedNodeIds = new Set(selectedNodeOrder)
  const selectedTree = buildSelectedTree(snapshot.sourceBomTree, selectedNodeOrder)
  const mergedTargetTree = snapshot.cloneLaunchMode === 'manufacturing'
    ? mergeTargetTreeWithStagedByOperation(
      snapshot.targetBomTree,
      snapshot.sourceBomTree,
      selectedNodeOrder,
      snapshot.manufacturingOperationBySourceNodeId,
      null,
      snapshot.targetItemNumberOverrides
    )
    : mergeTargetTreeWithStaged(snapshot.targetBomTree, selectedTree)
  const targetTableNodeIds = new Set<string>()
  collectNodeIds(mergedTargetTree, targetTableNodeIds)
  const targetExistingNodeIds = new Set<string>()
  collectNodeIds(snapshot.targetBomTree, targetExistingNodeIds)
  const markedForDeleteIds = new Set(snapshot.targetMarkedForDeleteNodeIds)
  if (targetRoot) targetExistingNodeIds.delete(targetRoot.id)

  const sourceExpanded = new Set(snapshot.sourceExpandedNodeIds)
  const flatSourceRows = prependRootDescriptorRow(
    flattenNodesForDisplay(snapshot.sourceBomTree, sourceExpanded, sourceRoot?.id || null)
      .filter((row) => !row.node.fromLinkableDialog),
    sourceRoot
  )
  const targetQuantityByNodeId = collectEffectiveTargetQuantityBySourceNodeId(
    mergedTargetTree,
    snapshot.targetQuantityOverrides,
    markedForDeleteIds
  )
  const sourceStatusByNodeId = buildSourceStatusByNodeId(
    snapshot.sourceBomTree,
    targetQuantityByNodeId
  )
  const sourceDiscrepancyByNodeId = buildSourceDiscrepancyByNodeId(
    snapshot.sourceBomTree,
    targetQuantityByNodeId
  )
  const sourceAllLeafPartsOnTargetByNodeId = buildSourceAllLeafPartsOnTargetByNodeId(
    snapshot.sourceBomTree,
    sourceStatusByNodeId
  )
  const sourceStatusCounts = buildSourceStatusCounts(flatSourceRows, sourceStatusByNodeId)
  const sourceStatusQuantities = buildSourceStatusQuantities(snapshot.sourceBomTree, sourceStatusByNodeId)
  const filteredSourceRows = filterSourceRowsByStatus(
    flatSourceRows,
    sourceStatusByNodeId,
    snapshot.sourceStatusFilter
  )

  const targetExpanded = new Set(snapshot.targetExpandedNodeIds)
  if (
    snapshot.cloneLaunchMode === 'manufacturing'
    && targetRoot
    && targetRoot.children.some((child) => child.stagedOperationDraft)
  ) {
    targetExpanded.add(targetRoot.id)
  }
  const selectedRows = prependRootDescriptorRow(
    flattenNodesForDisplay(mergedTargetTree, targetExpanded, targetRoot?.id || null),
    targetRoot
  )
  const existingTopLevelNodeIds = new Set(
    (targetRoot?.children || [])
      .filter((node) => !node.stagedOperationDraft)
      .map((node) => node.id)
  )
  const stagedTopLevelNodeIds = new Set(
    selectedTree
      .map((node) => node.id)
      .filter((nodeId) => !existingTopLevelNodeIds.has(nodeId))
  )
  for (const row of selectedRows) {
    if (row.level !== 0) continue
    if (!row.node.stagedOperationDraft) continue
    if (!selectedNodeIds.has(row.id)) continue
    stagedTopLevelNodeIds.add(row.id)
  }

  return {
    sourceRoot,
    targetRoot,
    pendingAddNodeIds,
    selectedNodeIds,
    markedForDeleteIds,
    targetExistingNodeIds,
    targetTableNodeIds,
    existingTopLevelNodeIds,
    stagedTopLevelNodeIds,
    flatSourceRows,
    filteredSourceRows,
    sourceStatusByNodeId,
    sourceDiscrepancyByNodeId,
    sourceAllLeafPartsOnTargetByNodeId,
    sourceStatusCounts,
    sourceStatusQuantities,
    selectedRows
  }
}

export function buildOperationCounts(
  snapshot: BomCloneStateSnapshot,
  structureViewModel: Pick<
    CloneStructureViewModel,
    'existingTopLevelNodeIds' | 'stagedTopLevelNodeIds' | 'selectedRows' | 'selectedNodeIds' | 'targetExistingNodeIds'
  >
): CloneOperationCounts {
  const markedDeleteIds = new Set(snapshot.targetMarkedForDeleteNodeIds)
  const deleteCount = snapshot.targetMarkedForDeleteNodeIds.length
  const newCount = structureViewModel.stagedTopLevelNodeIds.size
  const createCount = structureViewModel.selectedRows.reduce((count, row) => {
    if (row.level !== 0) return count
    if (!row.node.stagedOperationDraft) return count
    if (!structureViewModel.selectedNodeIds.has(row.id)) return count
    return count + 1
  }, 0)
  const addCount = Math.max(0, newCount - createCount)
  const quantityFieldId = resolveQuantityFieldId(snapshot)

  const updateCount = structureViewModel.selectedRows.reduce((count, row) => {
    if (row.level < 0) return count
    if (row.node.stagedOperationDraft) return count
    if (!structureViewModel.targetExistingNodeIds.has(row.id)) return count
    if (!String(row.node.bomEdgeId || '').trim()) return count
    if (markedDeleteIds.has(row.id)) return count
    const hasItemOverride = Boolean(snapshot.targetItemNumberOverrides[row.id])
    const hasQtyOverride = Boolean(snapshot.targetQuantityOverrides[row.id])
    const fieldOverrides = snapshot.targetFieldOverrides[row.id] || {}
    const hasFieldOverrides = Object.entries(fieldOverrides).some(([fieldId]) => {
      if (quantityFieldId && String(fieldId) === String(quantityFieldId)) return false
      const link = String(snapshot.bomViewFieldMetaLinks[fieldId] || '').trim()
      if (!link) return false
      return Object.prototype.hasOwnProperty.call(fieldOverrides, fieldId)
    })
    return hasItemOverride || hasQtyOverride || hasFieldOverrides ? count + 1 : count
  }, 0)

  return { deleteCount, updateCount, addCount, createCount, newCount }
}

export function buildCommitProgressBreakdown(
  snapshot: Pick<BomCloneStateSnapshot, 'commitProgressCurrent' | 'commitProgressTotal'>,
  operationCounts: CloneOperationCounts
): CloneCommitProgressBreakdown {
  const overallTotal = Math.max(1, snapshot.commitProgressTotal)
  const overallCurrent = Math.max(0, Math.min(snapshot.commitProgressCurrent, overallTotal))
  let remaining = overallCurrent
  const createDone = Math.min(operationCounts.createCount, remaining)
  remaining -= createDone
  const deleteDone = Math.min(operationCounts.deleteCount, remaining)
  remaining -= deleteDone
  const addDone = Math.min(operationCounts.addCount, remaining)
  remaining -= addDone
  const updateDone = Math.min(operationCounts.updateCount, remaining)
  const newDone = createDone + addDone

  return {
    overallTotal,
    overallCurrent,
    createDone,
    deleteDone,
    addDone,
    updateDone,
    newDone
  }
}

export function buildEditPanelViewModel(
  snapshot: BomCloneStateSnapshot,
  nodeId: string
): CloneEditPanelViewModel {
  const baseNodeForEdit = findNode(snapshot.targetBomTree, nodeId) || findNode(snapshot.sourceBomTree, nodeId)
  const isOperationDraft = Boolean(baseNodeForEdit?.stagedOperationDraft)
  const isBomDetailsMode = snapshot.editingPanelMode === 'bom'
  const isProcessNode = snapshot.cloneLaunchMode === 'manufacturing'
    && isManufacturingProcessNodeId(snapshot, nodeId)
  const useOperationFields = !isBomDetailsMode && (isOperationDraft || isProcessNode)
  const operationFields = snapshot.operationFormFields.filter(
    (field) => field.visible && field.editable && !isImageFieldDefinition(field)
  )
  const allFields = (useOperationFields ? operationFields : snapshot.bomViewFields).filter((field) => field.editable)
  const fields = allFields
  const requiredEditableFields = allFields.filter((field) => field.required && field.editable)
  const fieldById = new Map(fields.map((field) => [field.fieldId, field]))

  const sectionModels: Array<{
    title: string
    expandedByDefault: boolean
    fields: FormFieldDefinition[]
  }> = []
  const includedFieldIds = new Set<string>()

  if (useOperationFields) {
    for (const section of snapshot.operationFormSections) {
      const sectionFields = section.fieldIds
        .map((fieldId) => fieldById.get(fieldId))
        .filter((field): field is FormFieldDefinition => Boolean(field) && !includedFieldIds.has(field.fieldId))
      if (sectionFields.length === 0) continue
      sectionModels.push({
        title: section.title,
        expandedByDefault: section.expandedByDefault,
        fields: sectionFields
      })
      for (const field of sectionFields) includedFieldIds.add(field.fieldId)
    }
  }

  const leftoverFields = fields.filter((field) => !includedFieldIds.has(field.fieldId))
  if (leftoverFields.length > 0) {
    sectionModels.push({
      title: sectionModels.length > 0 ? 'Other' : 'Basic',
      expandedByDefault: true,
      fields: leftoverFields
    })
  }

  const existingFieldValues = (baseNodeForEdit?.bomFieldValues || {}) as Record<string, string>
  const stagedFieldOverrides = snapshot.targetFieldOverrides[nodeId] || {}
  const currentOverrides = {
    ...existingFieldValues,
    ...stagedFieldOverrides
  }
  const quantityFieldId = resolveQuantityFieldId(snapshot)
  const fallbackQuantity = String(baseNodeForEdit?.quantity || '').trim()
    || '1.0'
  const effectiveQuantity = String(snapshot.targetQuantityOverrides[nodeId] ?? baseNodeForEdit?.quantity ?? '').trim() || fallbackQuantity
  const activeInsertDraft = {
    payload: new Map(Object.entries(currentOverrides)),
    display: new Map(Object.entries(currentOverrides)),
    source: 'clone' as const
  }
  if (quantityFieldId) {
    activeInsertDraft.payload.set(quantityFieldId, effectiveQuantity)
    activeInsertDraft.display.set(quantityFieldId, effectiveQuantity)
  }

  return {
    fields,
    sections: sectionModels,
    requiredEditableFields,
    quantityFieldId,
    fallbackQuantity,
    activeInsertDraft
  }
}

export function buildQtyInputViewModel(
  values: Record<string, string>,
  quantityFieldId: string | null,
  fallbackQuantity: string
): { nextQuantity: string; isModified: boolean } | null {
  if (!quantityFieldId) return null
  const normalizedFallback = normalizeQuantity(String(fallbackQuantity || '').trim(), DEFAULT_CLONE_QUANTITY)
  const rawQuantity = String(values[quantityFieldId] || '').trim()
  const normalized = normalizeQuantity(rawQuantity, normalizedFallback)
  const nextQuantity = rawQuantity ? normalized : normalizedFallback
  return {
    nextQuantity,
    isModified: nextQuantity !== normalizedFallback
  }
}

export function buildRequiredWarningSummary(
  snapshot: BomCloneStateSnapshot,
  structureViewModel: Pick<CloneStructureViewModel, 'selectedRows' | 'selectedNodeIds' | 'markedForDeleteIds'>
): CloneRequiredWarningSummary {
  if (snapshot.bomViewFieldsLoading) return { blockingWarningCount: 0, hasBlockingWarnings: false }

  let blockingWarningCount = 0
  for (const row of structureViewModel.selectedRows) {
    if (row.level < 0) continue
    const isPreExistingTopLevel = !structureViewModel.selectedNodeIds.has(row.id)
    const isMarkedForDelete = isPreExistingTopLevel && structureViewModel.markedForDeleteIds.has(row.id)
    if (isMarkedForDelete) continue

    const shouldValidateRow = row.level === 0
      || (
        snapshot.cloneLaunchMode === 'manufacturing'
        && row.level > 0
        && (structureViewModel.selectedNodeIds.has(row.id) || Boolean(row.node.stagedSplitDraft))
      )
    if (!shouldValidateRow) continue

    const requiredSummary = buildRowRequiredValidationSummary(
      snapshot,
      row.node,
      snapshot.cloneLaunchMode === 'manufacturing' && Boolean(row.node.stagedOperationDraft)
    )
    if (!requiredSummary.combined.isComplete) blockingWarningCount += 1
  }

  return {
    blockingWarningCount,
    hasBlockingWarnings: blockingWarningCount > 0
  }
}

export function buildLinkableDialogViewModel(
  snapshot: Pick<
  BomCloneStateSnapshot,
  | 'linkableLoading'
  | 'linkableItems'
  | 'linkableDisplayOnlySelected'
  | 'linkableShowOnlyErrors'
  | 'linkableSelectedItemIds'
  | 'linkableOnTargetBomItemIds'
  | 'linkableItemErrors'
  | 'selectedNodesToClone'
  | 'sourceBomTree'
  >
): CloneLinkableDialogViewModel {
  const showInitialLoading = snapshot.linkableLoading && snapshot.linkableItems.length === 0
  if (showInitialLoading) {
    return {
      rows: [],
      showInitialLoading: true,
      showTrailingLoading: false,
      emptyMessage: null,
      visibleCount: 0
    }
  }

  const selectedItemIds = new Set(snapshot.linkableSelectedItemIds)
  const targetBomItemIds = new Set(snapshot.linkableOnTargetBomItemIds)
  const errorByItemId = new Map(
    Object.entries(snapshot.linkableItemErrors).map(([itemId, message]) => [Number(itemId), message])
  )
  const stagedSourceNodeIds = new Set(snapshot.selectedNodesToClone)
  const stagedSourceLabels = new Set<string>()
  collectStagedSourceLabels(snapshot.sourceBomTree, stagedSourceNodeIds, stagedSourceLabels)

  const visibleItems = snapshot.linkableItems.filter((item) => {
    if (snapshot.linkableDisplayOnlySelected && !selectedItemIds.has(item.id)) return false
    if (snapshot.linkableShowOnlyErrors && !errorByItemId.has(item.id)) return false
    return true
  })

  const rows = visibleItems.map((item) => {
    const isSelected = selectedItemIds.has(item.id)
    const isOnTargetBom = targetBomItemIds.has(item.id)
    const normalized = normalizeLabelForRevisionCompare(item.label)
    return {
      item,
      isSelected,
      isOnTargetBom,
      isPotentialDuplicate: !isOnTargetBom && Boolean(normalized) && stagedSourceLabels.has(normalized),
      errorMessage: errorByItemId.get(item.id) || null
    }
  })

  const emptyMessage = rows.length === 0
    ? (
        snapshot.linkableItems.length === 0
          ? 'No linkable items found.'
          : snapshot.linkableShowOnlyErrors
            ? 'No linkable item errors.'
            : 'No selected items in current results.'
      )
    : null

  return {
    rows,
    showInitialLoading: false,
    showTrailingLoading: snapshot.linkableLoading,
    emptyMessage,
    visibleCount: visibleItems.length
  }
}
