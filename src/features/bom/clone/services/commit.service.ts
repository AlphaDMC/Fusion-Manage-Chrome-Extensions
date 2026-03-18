import {
  getTargetSelectedTree
} from './structure/selection.service'
import {
  DEFAULT_CLONE_QUANTITY,
  normalizeQuantity,
  parseCommitItemNumber
} from './normalize.service'
import { applyMessageTemplate, tryParseJson } from './api/parse'
import { TEMP_OPERATION_NAME_FIELD_ID, type BomCloneContext, type BomCloneNode, type BomCloneStateSnapshot } from '../clone.types'
import type { CloneService } from './service.contract'
import { parseBooleanLike, resolvePinnedFieldId, resolveQuantityFieldId } from './field.service'
import { resolveNodeItemId } from './structure/tree.service'
import { isPartNode, buildDuplicatePlan } from './deepDuplicate.service'

export type BomCloneMutationService = Pick<
  CloneService,
  'createBomCloneOperationItem' | 'commitBomCloneItem' | 'updateBomCloneItem' | 'deleteBomCloneItem' | 'deepDuplicateSubtree'
>

export type CommitOperationCounts = {
  deleteCount: number
  updateCount: number
  newCount: number
  totalOperations: number
}

export type CommitOperationKind = 'delete' | 'update' | 'new'

export type CommitOperationSuccessKind = 'create' | 'add' | 'update' | 'delete'

export type CommitOperationError = {
  operation: CommitOperationKind
  nodeId: string
  nodeLabel: string
  descriptor: string
  message: string
}

export type CommitOperationSuccess = {
  operation: CommitOperationSuccessKind
  nodeId: string
  createdSourceItemId?: number
}

export type CommitExecutionResult = CommitOperationCounts & {
  errors: CommitOperationError[]
  successes: CommitOperationSuccess[]
}

export class CommitOperationBatchError extends Error {
  readonly errors: CommitOperationError[]

  constructor(errors: CommitOperationError[]) {
    super(`Failed to commit ${errors.length} process(es).`)
    this.name = 'CommitOperationBatchError'
    this.errors = errors
  }
}

type CommittableField = { link: string; value: string }

type CommitClassification = {
  createRows: BomCloneNode[]
  addRows: BomCloneNode[]
  deleteRows: BomCloneNode[]
  updateRows: BomCloneNode[]
  stagedTopLevelRows: BomCloneNode[]
  getCommittableFieldsForNode: (nodeId: string) => CommittableField[]
  resolvePinnedForNode: (node: BomCloneNode) => boolean
  totalOperations: number
}

type CommitExecutionPlan = {
  classification: CommitClassification
  fallbackForNode: (nodeId: string) => number
}

type ClassifyOptions = {
  requireResolvableFieldLinks: boolean
  activeContext?: BomCloneContext
}

function flattenCommitNodes(nodes: BomCloneNode[]): BomCloneNode[] {
  const flat: BomCloneNode[] = []
  const visit = (entries: BomCloneNode[]): void => {
    for (const node of entries) {
      flat.push(node)
      if (node.children.length > 0) visit(node.children)
    }
  }
  visit(nodes)
  return flat
}

type ParsedCommitErrorDetail = { message: string }

function getErrorMessageFallback(error: unknown): string {
  if (error instanceof Error && String(error.message || '').trim()) return String(error.message).trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  return 'Unknown commit error'
}

function extractCommitErrorDetail(entry: Record<string, unknown>): ParsedCommitErrorDetail | null {
  const template = typeof entry.message === 'string' ? entry.message.trim() : ''
  if (template) {
    const parsedTemplate = tryParseJson(template) ?? tryParseEmbeddedJson(template)
    if (parsedTemplate !== null) return null
  }
  const args = Array.isArray(entry.arguments) ? entry.arguments : []
  const message = template ? applyMessageTemplate(template, args).trim() : ''
  if (!message) return null
  return { message }
}

function tryParseEmbeddedJson(value: string): unknown {
  const firstArrayIndex = value.indexOf('[')
  const lastArrayIndex = value.lastIndexOf(']')
  if (firstArrayIndex >= 0 && lastArrayIndex > firstArrayIndex) {
    const parsedArray = tryParseJson(value.slice(firstArrayIndex, lastArrayIndex + 1))
    if (parsedArray !== null) return parsedArray
  }

  const firstObjectIndex = value.indexOf('{')
  const lastObjectIndex = value.lastIndexOf('}')
  if (firstObjectIndex >= 0 && lastObjectIndex > firstObjectIndex) {
    const parsedObject = tryParseJson(value.slice(firstObjectIndex, lastObjectIndex + 1))
    if (parsedObject !== null) return parsedObject
  }

  return null
}

function extractCommitErrorDetailsDeep(value: unknown, depth = 0): ParsedCommitErrorDetail[] {
  if (depth > 6 || value == null) return []

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    const parsed = tryParseJson(trimmed)
    if (parsed !== null) return extractCommitErrorDetailsDeep(parsed, depth + 1)
    const embeddedParsed = tryParseEmbeddedJson(trimmed)
    if (embeddedParsed !== null) return extractCommitErrorDetailsDeep(embeddedParsed, depth + 1)
    return [{ message: trimmed }]
  }

  if (Array.isArray(value)) {
    const result: ParsedCommitErrorDetail[] = []
    for (const entry of value) result.push(...extractCommitErrorDetailsDeep(entry, depth + 1))
    return result
  }

  if (typeof value !== 'object') return []

  const record = value as Record<string, unknown>
  const result: ParsedCommitErrorDetail[] = []
  const directDetail = extractCommitErrorDetail(record)
  if (directDetail) result.push(directDetail)

  const nestedKeys = ['data', 'errors', 'details', 'validationErrors']
  for (const key of nestedKeys) {
    if (!(key in record)) continue
    result.push(...extractCommitErrorDetailsDeep(record[key], depth + 1))
  }

  if (typeof record.message === 'string') {
    const parsedMessage = tryParseJson(record.message.trim()) ?? tryParseEmbeddedJson(record.message.trim())
    if (parsedMessage !== null) result.push(...extractCommitErrorDetailsDeep(parsedMessage, depth + 1))
  }

  const deduped = new Map<string, ParsedCommitErrorDetail>()
  for (const entry of result) {
    const message = entry.message.trim()
    if (!message) continue
    const key = message
    if (!deduped.has(key)) deduped.set(key, { message })
  }

  return Array.from(deduped.values())
}

function buildOperationErrors(params: {
  operation: CommitOperationKind
  node: Pick<BomCloneNode, 'id' | 'label'>
  error: unknown
}): CommitOperationError[] {
  const { operation, node, error } = params
  const fallbackMessage = getErrorMessageFallback(error)
  const details = extractCommitErrorDetailsDeep(error)
  const cleanedDetails = details.filter((entry) => {
    const message = entry.message.trim()
    if (!message) return false
    if (message === fallbackMessage && details.length > 1) return false
    // Drop raw serialized payload rows like: [{"message":"..."}]
    const parsed = tryParseJson(message) ?? tryParseEmbeddedJson(message)
    return parsed === null
  })
  const effectiveDetails = cleanedDetails.length > 0 ? cleanedDetails : details

  if (effectiveDetails.length === 0) {
    return [{
      operation,
      nodeId: node.id,
      nodeLabel: node.label,
      descriptor: node.label || node.id,
      message: fallbackMessage
    }]
  }

  return effectiveDetails.map((entry) => ({
    operation,
    nodeId: node.id,
    nodeLabel: node.label,
    descriptor: node.label || node.id,
    message: entry.message || fallbackMessage
  }))
}

function chunkIntoBatches<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, size)
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += safeSize) chunks.push(items.slice(index, index + safeSize))
  return chunks
}

function resolveNumericItemIdFromNode(node: Pick<BomCloneNode, 'id' | 'itemLink' | 'splitSourceNodeId'>): number | null {
  return resolveNodeItemId(node)
}

function resolveManufacturingParentItemId(params: {
  snapshot: Pick<BomCloneStateSnapshot, 'cloneLaunchMode' | 'manufacturingOperationBySourceNodeId'>
  node: Pick<BomCloneNode, 'id' | 'label'>
  createdProcessItemIdByNodeId: Map<string, number>
  failedProcessMessageByNodeId: Map<string, string>
}): number | undefined {
  const {
    snapshot,
    node,
    createdProcessItemIdByNodeId,
    failedProcessMessageByNodeId
  } = params

  if (snapshot.cloneLaunchMode !== 'manufacturing') return undefined

  const assignedOperationNodeId = String(snapshot.manufacturingOperationBySourceNodeId[node.id] || '').trim()
  if (!assignedOperationNodeId) return undefined

  const directParentItemId = Number.parseInt(assignedOperationNodeId, 10)
  if (Number.isFinite(directParentItemId) && directParentItemId > 0) return directParentItemId

  const createdParentItemId = createdProcessItemIdByNodeId.get(assignedOperationNodeId)
  if (typeof createdParentItemId === 'number' && createdParentItemId > 0) return createdParentItemId

  const failedProcessMessage = failedProcessMessageByNodeId.get(assignedOperationNodeId)
  if (failedProcessMessage) {
    throw new Error(`Cannot add to process because process creation failed: ${failedProcessMessage}`)
  }

  throw new Error(`Cannot resolve process target for ${node.label || node.id}.`)
}

function resolveFieldMetaLink(
  snapshot: Pick<BomCloneStateSnapshot, 'bomViewFieldMetaLinks' | 'bomViewDefId'>,
  activeContext: BomCloneContext | undefined,
  fieldId: string
): string {
  const explicit = String(snapshot.bomViewFieldMetaLinks[fieldId] || '').trim()
  if (explicit) return explicit
  if (!activeContext) return ''
  const resolvedViewDefId = activeContext.viewDefId ?? snapshot.bomViewDefId
  if (!resolvedViewDefId) return ''
  return `/api/v3/workspaces/${activeContext.workspaceId}/views/5/viewdef/${resolvedViewDefId}/fields/${fieldId}`
}

function resolveCreateFieldType(field: BomCloneStateSnapshot['bomViewFields'][number]): string {
  const typeTitle = String(field.typeTitle || '').toLowerCase()
  if (field.picklistPath) {
    if (typeTitle.includes('multi')) return 'multi-select'
    return 'single-select'
  }
  if (typeTitle.includes('integer')) return 'integer'
  if (typeTitle.includes('money') || typeTitle.includes('decimal') || typeTitle.includes('number')) return 'number'
  if (field.kind === 'boolean') return 'boolean'
  if (field.kind === 'number') return 'number'
  return 'string'
}

function buildCreateFieldsForDraftOperation(
  snapshot: BomCloneStateSnapshot,
  nodeId: string
): Array<{ fieldId: string; value: string; type: string; display?: string }> {
  const quantityFieldId = resolveQuantityFieldId(snapshot)
  const pinnedFieldId = resolvePinnedFieldId(snapshot)
  const candidateFields = snapshot.operationFormFields.length > 0
    ? snapshot.operationFormFields
    : snapshot.bomViewFields
  const fieldById = new Map(candidateFields.map((field) => [field.fieldId, field]))
  const overrides = snapshot.targetFieldOverrides[nodeId] || {}
  const createFields: Array<{ fieldId: string; value: string; type: string; display?: string }> = []

  for (const [fieldId, rawValue] of Object.entries(overrides)) {
    if (quantityFieldId && String(fieldId) === String(quantityFieldId)) continue
    if (pinnedFieldId && String(fieldId) === String(pinnedFieldId)) continue
    const value = String(rawValue ?? '')
    if (!value.trim()) continue
    const field = fieldById.get(fieldId)
    createFields.push({
      fieldId,
      value,
      type: field ? resolveCreateFieldType(field) : 'string'
    })
  }

  return createFields
}

function classifyCommitRows(
  snapshot: BomCloneStateSnapshot,
  options: ClassifyOptions
): CommitClassification {
  const topLevelRows = getTargetSelectedTree(snapshot.sourceBomTree, snapshot.selectedNodesToClone)
  const targetRoot = snapshot.targetBomTree[0] || null
  const targetTopLevelRows = targetRoot?.children || []
  const targetCommitRows = flattenCommitNodes(targetTopLevelRows)
  const quantityFieldId = resolveQuantityFieldId(snapshot)
  const pinnedFieldId = resolvePinnedFieldId(snapshot)
  const bomFieldIdSet = new Set(snapshot.bomViewFields.map((field) => String(field.fieldId)))
  const committableFieldsByNodeId = new Map<string, CommittableField[]>()

  const getCommittableFieldsForNode = (nodeId: string): CommittableField[] => {
    const cached = committableFieldsByNodeId.get(nodeId)
    if (cached) return cached

    const overrides = snapshot.targetFieldOverrides[nodeId] || {}
    const result: CommittableField[] = []
    for (const [fieldId, rawValue] of Object.entries(overrides)) {
      const normalizedFieldId = String(fieldId)
      if (normalizedFieldId === TEMP_OPERATION_NAME_FIELD_ID) continue
      if (quantityFieldId && normalizedFieldId === String(quantityFieldId)) continue
      if (pinnedFieldId && normalizedFieldId === String(pinnedFieldId)) continue
      const hasExplicitBomMetaLink = Boolean(String(snapshot.bomViewFieldMetaLinks[normalizedFieldId] || '').trim())
      if (!hasExplicitBomMetaLink && !bomFieldIdSet.has(normalizedFieldId)) continue
      const value = String(rawValue ?? '')

      if (!options.requireResolvableFieldLinks) {
        result.push({ link: normalizedFieldId, value })
        continue
      }

      const link = resolveFieldMetaLink(snapshot, options.activeContext, normalizedFieldId)
      if (!link) continue
      result.push({ link, value })
    }

    committableFieldsByNodeId.set(nodeId, result)
    return result
  }

  const hasPinnedOverride = (nodeId: string): boolean => {
    if (!pinnedFieldId) return false
    return Object.prototype.hasOwnProperty.call(snapshot.targetFieldOverrides[nodeId] || {}, pinnedFieldId)
  }

  const resolvePinnedForNode = (node: BomCloneNode): boolean => {
    const overrides = snapshot.targetFieldOverrides[node.id] || {}
    if (pinnedFieldId && Object.prototype.hasOwnProperty.call(overrides, pinnedFieldId)) {
      return parseBooleanLike(overrides[pinnedFieldId], false)
    }
    if (typeof node.isPinned === 'boolean') return node.isPinned

    const fieldValues = node.bomFieldValues || {}
    if (pinnedFieldId && Object.prototype.hasOwnProperty.call(fieldValues, pinnedFieldId)) {
      return parseBooleanLike(fieldValues[pinnedFieldId], false)
    }
    if (Object.prototype.hasOwnProperty.call(fieldValues, '302')) {
      return parseBooleanLike(fieldValues['302'], false)
    }
    return false
  }

  const targetTopLevelById = new Map(targetTopLevelRows.map((row) => [row.id, row]))
  const selectedNodeIdSet = new Set(snapshot.selectedNodesToClone)
  const stagedDraftOperationRows = targetTopLevelRows.filter(
    (row) => Boolean(row.stagedOperationDraft) && selectedNodeIdSet.has(row.id)
  )
  const stagedSplitRows = snapshot.cloneLaunchMode === 'manufacturing'
    ? targetTopLevelRows.flatMap((row) =>
      row.children.filter((child) => Boolean(child.stagedSplitDraft) && selectedNodeIdSet.has(child.id))
    )
    : []
  const stagedTopLevelRows = [
    ...topLevelRows.filter((node) => !targetTopLevelById.has(node.id)),
    ...stagedDraftOperationRows,
    ...stagedSplitRows
  ]
  const createRows = stagedDraftOperationRows
  const addRows = stagedTopLevelRows.filter((row) => !row.stagedOperationDraft)
  const markedForDeleteIds = new Set(snapshot.targetMarkedForDeleteNodeIds)
  const deleteRows = targetTopLevelRows.filter(
    (row) => !row.stagedOperationDraft && markedForDeleteIds.has(row.id) && Boolean(row.bomEdgeId)
  )
  const deleteChildRows = targetCommitRows.filter(
    (row) => !targetTopLevelRows.includes(row) && !row.stagedOperationDraft && markedForDeleteIds.has(row.id) && Boolean(row.bomEdgeId)
  )
  const updateRows = targetCommitRows.filter((row) => {
    if (row.stagedOperationDraft) return false
    if (markedForDeleteIds.has(row.id)) return false
    const hasItemOverride = Object.prototype.hasOwnProperty.call(snapshot.targetItemNumberOverrides, row.id)
    const hasQtyOverride = Object.prototype.hasOwnProperty.call(snapshot.targetQuantityOverrides, row.id)
    const hasFieldOverrides = getCommittableFieldsForNode(row.id).length > 0
    return hasItemOverride || hasQtyOverride || hasFieldOverrides || hasPinnedOverride(row.id)
  })
  const allDeleteRows = [...deleteRows, ...deleteChildRows]
  const totalOperations = createRows.length + allDeleteRows.length + addRows.length + updateRows.length

  return {
    createRows,
    addRows,
    deleteRows: allDeleteRows,
    updateRows,
    stagedTopLevelRows,
    getCommittableFieldsForNode,
    resolvePinnedForNode,
    totalOperations
  }
}

function buildExecutionPlan(snapshot: BomCloneStateSnapshot, activeContext: BomCloneContext): CommitExecutionPlan {
  const classification = classifyCommitRows(snapshot, {
    requireResolvableFieldLinks: true,
    activeContext
  })
  const operationOrder = [...(snapshot.targetBomTree[0]?.children || []), ...classification.stagedTopLevelRows]
  const operationOrderById = new Map(operationOrder.map((node, index) => [node.id, index]))
  const fallbackForNode = (nodeId: string): number => {
    const found = operationOrderById.get(nodeId)
    return typeof found === 'number' ? found + 1 : 1
  }

  return { classification, fallbackForNode }
}

export function countStagedOperations(snapshot: BomCloneStateSnapshot): number {
  return classifyCommitRows(snapshot, { requireResolvableFieldLinks: false }).totalOperations
}

export function countExecutableCommitOperations(
  snapshot: BomCloneStateSnapshot,
  activeContext: BomCloneContext
): number {
  return classifyCommitRows(snapshot, {
    requireResolvableFieldLinks: true,
    activeContext
  }).totalOperations
}

export function getCommitOperationCounts(snapshot: BomCloneStateSnapshot): CommitOperationCounts {
  const classification = classifyCommitRows(snapshot, { requireResolvableFieldLinks: false })
  return {
    deleteCount: classification.deleteRows.length,
    updateCount: classification.updateRows.length,
    newCount: classification.stagedTopLevelRows.length,
    totalOperations: classification.totalOperations
  }
}

export async function executeCommitOperations(params: {
  snapshot: BomCloneStateSnapshot
  activeContext: BomCloneContext
  dataService: BomCloneMutationService
  maxConcurrentOperations?: number
  onOperationComplete?: (completed: number, total: number) => void
}): Promise<CommitExecutionResult> {
  const {
    snapshot,
    activeContext,
    dataService,
    maxConcurrentOperations = 10,
    onOperationComplete
  } = params

  const executionPlan = buildExecutionPlan(snapshot, activeContext)
  const {
    createRows,
    addRows,
    deleteRows,
    updateRows,
    stagedTopLevelRows,
    getCommittableFieldsForNode,
    resolvePinnedForNode,
    totalOperations
  } = executionPlan.classification

  let completed = 0
  const errors: CommitOperationError[] = []
  const successes: CommitOperationSuccess[] = []
  const createdProcessItemIdByNodeId = new Map<string, number>()
  const failedProcessMessageByNodeId = new Map<string, string>()
  const markOperationComplete = (): void => {
    completed += 1
    if (onOperationComplete) onOperationComplete(completed, totalOperations)
  }

  for (const batch of chunkIntoBatches(createRows, maxConcurrentOperations)) {
    await Promise.all(batch.map(async (node) => {
      try {
        const fallbackItemNumber = executionPlan.fallbackForNode(node.id)
        const effectiveItemNumber = snapshot.targetItemNumberOverrides[node.id] ?? node.itemNumber ?? `1.${fallbackItemNumber}`
        const commitItemNumber = parseCommitItemNumber(effectiveItemNumber, fallbackItemNumber)
        const quantityFallback = '1.0'
        const effectiveQuantity = String(snapshot.targetQuantityOverrides[node.id] ?? node.quantity ?? '').trim() || quantityFallback
        const commitQuantity = normalizeQuantity(effectiveQuantity, quantityFallback)
        const sourceItemId = await dataService.createBomCloneOperationItem(activeContext, {
          fields: buildCreateFieldsForDraftOperation(snapshot, node.id)
        })
        if (!sourceItemId || sourceItemId <= 0) throw new Error(`Unable to resolve source item id for ${node.label || node.id}`)

        await dataService.commitBomCloneItem(activeContext, {
          sourceItemId,
          itemNumber: commitItemNumber,
          quantity: commitQuantity,
          pinned: resolvePinnedForNode(node),
          fields: getCommittableFieldsForNode(node.id)
        })
        createdProcessItemIdByNodeId.set(node.id, sourceItemId)
        successes.push({
          operation: 'create',
          nodeId: node.id,
          createdSourceItemId: sourceItemId
        })
      } catch (error) {
        failedProcessMessageByNodeId.set(node.id, getErrorMessageFallback(error))
        errors.push(...buildOperationErrors({ operation: 'new', node, error }))
      } finally {
        markOperationComplete()
      }
    }))
  }

  for (const batch of chunkIntoBatches(deleteRows, maxConcurrentOperations)) {
    await Promise.all(batch.map(async (node) => {
      try {
        const edgeId = String(node.bomEdgeId || '').trim()
        if (!edgeId) return
        await dataService.deleteBomCloneItem(activeContext, { edgeId })
        successes.push({ operation: 'delete', nodeId: node.id })
      } catch (error) {
        errors.push(...buildOperationErrors({ operation: 'delete', node, error }))
      } finally {
        markOperationComplete()
      }
    }))
  }

  for (const batch of chunkIntoBatches(addRows, maxConcurrentOperations)) {
    await Promise.all(batch.map(async (node) => {
      try {
        const fallbackItemNumber = executionPlan.fallbackForNode(node.id)
        const effectiveItemNumber = snapshot.targetItemNumberOverrides[node.id] ?? node.itemNumber ?? `1.${fallbackItemNumber}`
        const commitItemNumber = parseCommitItemNumber(effectiveItemNumber, fallbackItemNumber)
        const quantityFallback = String(node.quantity || '').trim() || '1.0'
        const effectiveQuantity = String(snapshot.targetQuantityOverrides[node.id] ?? node.quantity ?? '').trim() || quantityFallback
        const commitQuantity = normalizeQuantity(effectiveQuantity, quantityFallback)
        let sourceItemId: number

        if (snapshot.deepDuplicateEnabled && !isPartNode(node)) {
          // Deep duplicate path: create a copy of the subtree rooted at this node.
          const plan = buildDuplicatePlan([node])[0]
          if (!plan) throw new Error(`Failed to build duplicate plan for node: ${node.label}`)
          console.debug('[DEEP-DUP] deepDuplicateEnabled=true, node:', node.label, 'number:', node.number, 'id:', node.id, 'projectId:', snapshot.projectId)
          sourceItemId = await dataService.deepDuplicateSubtree(
            activeContext,
            plan,
            snapshot.projectId
          )
          console.debug('[DEEP-DUP] created new item id:', sourceItemId, 'for node:', node.label)
        } else {
          console.debug('[DEEP-DUP] reference path, deepDuplicateEnabled:', snapshot.deepDuplicateEnabled, 'isPartNode:', isPartNode(node), 'node:', node.label)
          // Reference path (original behaviour).
          const resolved = resolveNumericItemIdFromNode(node)
          if (!resolved || resolved <= 0) throw new Error(`Unable to resolve source item id for ${node.label || node.id}`)
          sourceItemId = resolved
        }

        const parentItemId = resolveManufacturingParentItemId({
          snapshot,
          node,
          createdProcessItemIdByNodeId,
          failedProcessMessageByNodeId
        })

        await dataService.commitBomCloneItem(activeContext, {
          sourceItemId,
          ...(node.itemLink ? { sourceItemLink: node.itemLink } : {}),
          itemNumber: commitItemNumber,
          quantity: commitQuantity,
          ...(typeof parentItemId === 'number' ? { parentItemId } : {}),
          pinned: resolvePinnedForNode(node),
          fields: getCommittableFieldsForNode(node.id)
        })
        successes.push({ operation: 'add', nodeId: node.id })
      } catch (error) {
        errors.push(...buildOperationErrors({ operation: 'new', node, error }))
      } finally {
        markOperationComplete()
      }
    }))
  }

  for (const batch of chunkIntoBatches(updateRows, maxConcurrentOperations)) {
    await Promise.all(batch.map(async (node) => {
      try {
        const edgeId = String(node.bomEdgeId || '').trim()
        if (!edgeId) return
        const fallbackItemNumber = executionPlan.fallbackForNode(node.id)
        const effectiveItemNumber = snapshot.targetItemNumberOverrides[node.id] ?? node.itemNumber ?? `1.${fallbackItemNumber}`
        const commitItemNumber = parseCommitItemNumber(effectiveItemNumber, fallbackItemNumber)
        const quantityFallback = String(node.quantity || '').trim() || '1.0'
        const effectiveQuantity = String(snapshot.targetQuantityOverrides[node.id] ?? node.quantity ?? '').trim() || quantityFallback
        const commitQuantity = normalizeQuantity(effectiveQuantity, quantityFallback)

        await dataService.updateBomCloneItem(activeContext, {
          edgeId,
          sourceItemId: resolveNumericItemIdFromNode(node) || 0,
          itemNumber: commitItemNumber,
          quantity: commitQuantity,
          pinned: resolvePinnedForNode(node),
          fields: getCommittableFieldsForNode(node.id)
        })
        successes.push({ operation: 'update', nodeId: node.id })
      } catch (error) {
        errors.push(...buildOperationErrors({ operation: 'update', node, error }))
      } finally {
        markOperationComplete()
      }
    }))
  }

  return {
    deleteCount: deleteRows.length,
    updateCount: updateRows.length,
    newCount: stagedTopLevelRows.length,
    totalOperations,
    errors,
    successes
  }
}
