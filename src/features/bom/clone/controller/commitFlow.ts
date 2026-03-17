import {
  countExecutableCommitOperations,
  countStagedOperations,
  executeCommitOperations,
  type CommitExecutionResult
} from '../services/commit.service'
import { appendTopLevelNode, cloneNode, findNode, updateNodeById } from '../services/structure/tree.service'
import { buildOperationCounts, buildRequiredWarningSummary, buildStructureViewModel } from '../services/viewModel.service'
import type { CloneService } from '../clone.service'
import type { CloneControllerRefs, CloneState, CloneView, CloneViewHandlers, EmitDiagnostic } from './types'
import type { BomCloneNode, BomCloneStateSnapshot } from '../clone.types'

type CommitFlowOptions = {
  state: CloneState
  service: CloneService
  view: CloneView
  refs: CloneControllerRefs
  render: () => void
  emitDiagnostic: EmitDiagnostic
  ensureCommitMetadataHydrated: () => Promise<void>
  closeModalAndRefreshIfCommitted: () => void
  reloadStructureAfterCommit: () => Promise<void>
}

type LifecycleHandlers = Pick<CloneViewHandlers, 'onClose' | 'onCommitClone' | 'onCloseCommitErrors'>

type RetryState = {
  selectedNodeIds: string[]
  targetItemNumberOverrides: Record<string, string>
  targetQuantityOverrides: Record<string, string>
  targetFieldOverrides: Record<string, Record<string, string>>
  targetMarkedForDeleteNodeIds: string[]
  manufacturingOperationAssignments: Record<string, string>
  manufacturingSelectedOperationNodeId: string | null
  failedProcessDrafts: BomCloneNode[]
  failedSplitDrafts: BomCloneNode[]
}

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      window.setTimeout(resolve, 0)
      return
    }
    window.requestAnimationFrame(() => resolve())
  })
}

function filterStringRecord(
  record: Record<string, string>,
  allowedNodeIds: Set<string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).filter(([nodeId]) => allowedNodeIds.has(nodeId))
  )
}

function filterNestedStringRecord(
  record: Record<string, Record<string, string>>,
  allowedNodeIds: Set<string>
): Record<string, Record<string, string>> {
  return Object.fromEntries(
    Object.entries(record)
      .filter(([nodeId]) => allowedNodeIds.has(nodeId))
      .map(([nodeId, values]) => [nodeId, { ...values }])
  )
}

function stripProcessDraftChildren(node: BomCloneNode): BomCloneNode {
  return {
    ...cloneNode(node),
    children: [],
    hasExpandableChildren: false,
    childrenLoaded: true
  }
}

function collectFailedSyntheticDrafts(
  snapshot: Pick<BomCloneStateSnapshot, 'targetBomTree'>,
  failedNodeIds: Set<string>
): Pick<RetryState, 'failedProcessDrafts' | 'failedSplitDrafts'> {
  const failedProcessDrafts: BomCloneNode[] = []
  const failedSplitDrafts: BomCloneNode[] = []

  const visit = (nodes: BomCloneNode[]): void => {
    for (const node of nodes) {
      if (failedNodeIds.has(node.id) && node.stagedOperationDraft) {
        failedProcessDrafts.push(stripProcessDraftChildren(node))
      } else if (failedNodeIds.has(node.id) && node.stagedSplitDraft) {
        failedSplitDrafts.push(cloneNode(node))
      }
      if (node.children.length > 0) visit(node.children)
    }
  }

  visit(snapshot.targetBomTree)
  return { failedProcessDrafts, failedSplitDrafts }
}

function buildRetryState(
  snapshot: BomCloneStateSnapshot,
  executionResult: CommitExecutionResult
): RetryState {
  const failedNodeIds = new Set(
    executionResult.errors
      .map((entry) => String(entry.nodeId || '').trim())
      .filter(Boolean)
  )
  const createdProcessItemIdByDraftNodeId = new Map<string, string>(
    executionResult.successes
      .filter((entry) => entry.operation === 'create' && typeof entry.createdSourceItemId === 'number')
      .map((entry) => [entry.nodeId, String(entry.createdSourceItemId)])
  )

  const failedDrafts = collectFailedSyntheticDrafts(snapshot, failedNodeIds)
  const selectedNodeIds = snapshot.selectedNodesToClone.filter((nodeId) => failedNodeIds.has(nodeId))
  const manufacturingOperationAssignments = Object.fromEntries(
    Object.entries(snapshot.manufacturingOperationBySourceNodeId)
      .filter(([sourceNodeId]) => failedNodeIds.has(sourceNodeId))
      .map(([sourceNodeId, operationNodeId]) => [
        sourceNodeId,
        createdProcessItemIdByDraftNodeId.get(String(operationNodeId)) ?? operationNodeId
      ])
  )

  const selectedOperationNodeId = String(snapshot.manufacturingSelectedOperationNodeId || '').trim()

  return {
    selectedNodeIds,
    targetItemNumberOverrides: filterStringRecord(snapshot.targetItemNumberOverrides, failedNodeIds),
    targetQuantityOverrides: filterStringRecord(snapshot.targetQuantityOverrides, failedNodeIds),
    targetFieldOverrides: filterNestedStringRecord(snapshot.targetFieldOverrides, failedNodeIds),
    targetMarkedForDeleteNodeIds: snapshot.targetMarkedForDeleteNodeIds.filter((nodeId) => failedNodeIds.has(nodeId)),
    manufacturingOperationAssignments,
    manufacturingSelectedOperationNodeId: selectedOperationNodeId
      ? (createdProcessItemIdByDraftNodeId.get(selectedOperationNodeId) ?? selectedOperationNodeId)
      : null,
    failedProcessDrafts: failedDrafts.failedProcessDrafts,
    failedSplitDrafts: failedDrafts.failedSplitDrafts
  }
}

function reinsertFailedSyntheticDrafts(
  targetBomTree: BomCloneNode[],
  retryState: Pick<RetryState, 'failedProcessDrafts' | 'failedSplitDrafts' | 'manufacturingOperationAssignments'>
): BomCloneNode[] {
  let nextTargetBomTree = targetBomTree.map(cloneNode)
  for (const processDraft of retryState.failedProcessDrafts) {
    if (findNode(nextTargetBomTree, processDraft.id)) continue
    nextTargetBomTree = appendTopLevelNode(nextTargetBomTree, processDraft)
  }

  const targetRootId = nextTargetBomTree[0]?.id || null
  for (const splitDraft of retryState.failedSplitDrafts) {
    if (findNode(nextTargetBomTree, splitDraft.id)) continue
    const assignedOperationNodeId = String(retryState.manufacturingOperationAssignments[splitDraft.id] || '').trim()
    if (assignedOperationNodeId && findNode(nextTargetBomTree, assignedOperationNodeId)) {
      nextTargetBomTree = updateNodeById(nextTargetBomTree, assignedOperationNodeId, (node) => ({
        ...node,
        children: [...node.children.map(cloneNode), cloneNode(splitDraft)],
        childrenLoaded: true,
        hasExpandableChildren: true
      }))
      continue
    }
    if (targetRootId) nextTargetBomTree = appendTopLevelNode(nextTargetBomTree, splitDraft)
  }

  return nextTargetBomTree
}

function buildExpandedNodeIdsForRetry(
  targetBomTree: BomCloneNode[],
  existingExpandedNodeIds: string[],
  retryState: Pick<RetryState, 'failedProcessDrafts' | 'failedSplitDrafts' | 'manufacturingOperationAssignments'>
): string[] {
  const expanded = new Set(existingExpandedNodeIds)
  const targetRootId = targetBomTree[0]?.id || null
  if (targetRootId) expanded.add(targetRootId)
  for (const processDraft of retryState.failedProcessDrafts) expanded.add(processDraft.id)
  for (const splitDraft of retryState.failedSplitDrafts) {
    const assignedOperationNodeId = String(retryState.manufacturingOperationAssignments[splitDraft.id] || '').trim()
    if (assignedOperationNodeId) expanded.add(assignedOperationNodeId)
  }
  return Array.from(expanded)
}

export function createCloneCommitFlow(options: CommitFlowOptions): {
  buildLifecycleHandlers: (modalRoot: HTMLDivElement) => LifecycleHandlers
  commitClone: () => Promise<void>
  requestCloseModal: (modalRoot: HTMLDivElement) => Promise<void>
} {
  const {
    state,
    service,
    view,
    refs,
    render,
    emitDiagnostic,
    ensureCommitMetadataHydrated,
    closeModalAndRefreshIfCommitted,
    reloadStructureAfterCommit
  } = options

  async function requestCloseModal(modalRoot: HTMLDivElement): Promise<void> {
    const snapshot = state.getSnapshot()
    if (snapshot.commitInProgress) return
    if (refs.getHasCommittedOperations()) {
      closeModalAndRefreshIfCommitted()
      return
    }
    const stagedCount = countStagedOperations(snapshot)
    if (stagedCount > 0) {
      const shouldClose = await view.showCancelConfirm(modalRoot, stagedCount)
      if (!shouldClose) return
    }
    closeModalAndRefreshIfCommitted()
  }

  async function commitClone(): Promise<void> {
    const activeContext = refs.getContext()
    if (!activeContext) return
    const snapshotBeforeCommit = state.getSnapshot()
    if (snapshotBeforeCommit.commitInProgress) return

    const structureViewModel = buildStructureViewModel(snapshotBeforeCommit)
    const operationCounts = buildOperationCounts(snapshotBeforeCommit, structureViewModel)
    if (!snapshotBeforeCommit.permissions.canAdd && operationCounts.newCount > 0) {
      state.setErrorMessage('Missing permission: Add to BOM.')
      render()
      return
    }
    if (!snapshotBeforeCommit.permissions.canEdit && operationCounts.updateCount > 0) {
      state.setErrorMessage('Missing permission: Edit BOM.')
      render()
      return
    }
    if (!snapshotBeforeCommit.permissions.canDelete && operationCounts.deleteCount > 0) {
      state.setErrorMessage('Missing permission: Delete from BOM.')
      render()
      return
    }
    const requiredWarnings = buildRequiredWarningSummary(snapshotBeforeCommit, structureViewModel)
    if (requiredWarnings.hasBlockingWarnings) {
      state.setErrorMessage('Complete all required fields (amber warnings) before committing.')
      render()
      return
    }

    if (snapshotBeforeCommit.deepDuplicateEnabled && !snapshotBeforeCommit.projectId.trim()) {
      state.setErrorMessage('Enter a Project ID before committing with deep duplication enabled.')
      render()
      return
    }

    state.setCommitInProgress(true)
    state.setCommitProgress(0, 0)
    state.setCommitErrors([])
    state.setCommitErrorsModalOpen(false)
    state.setShowCommitErrorsOnly(false)
    state.setErrorMessage(null)
    render()
    await waitForNextPaint()

    let hydratedSnapshot: BomCloneStateSnapshot
    let totalOperations = 0
    try {
      await ensureCommitMetadataHydrated()
      hydratedSnapshot = state.getSnapshot()

      totalOperations = countExecutableCommitOperations(hydratedSnapshot, activeContext)
      if (totalOperations === 0) {
        state.setCommitInProgress(false)
        state.setCommitProgress(0, 0)
        state.setErrorMessage('Select at least one target row to commit.')
        render()
        return
      }

      state.setCommitProgress(0, totalOperations)
      render()
      await waitForNextPaint()
    } catch (error) {
      state.setCommitInProgress(false)
      state.setCommitProgress(0, 0)
      state.setCommitErrors([{
        nodeId: '',
        descriptor: 'Unknown',
        message: error instanceof Error ? error.message : String(error)
      }])
      state.setCommitErrorsModalOpen(true)
      state.setShowCommitErrorsOnly(true)
      state.setErrorMessage(`Failed to prepare BOM clone commit. ${error instanceof Error ? error.message : String(error)}`)
      emitDiagnostic('BOM_STRUCTURE_PARSING_FAILURE', String(error))
      render()
      return
    }

    let executionResult: CommitExecutionResult | null = null
    try {
      executionResult = await executeCommitOperations({
        snapshot: hydratedSnapshot,
        activeContext,
        dataService: service,
        maxConcurrentOperations: 10,
        onOperationComplete: (completed, total) => {
          state.setCommitProgress(completed, total)
          render()
        }
      })

    } catch (error) {
      state.setCommitErrors([{
        nodeId: '',
        descriptor: 'Unknown',
        message: error instanceof Error ? error.message : String(error)
      }])
      state.setCommitErrorsModalOpen(true)
      state.setShowCommitErrorsOnly(true)
      state.setErrorMessage(`Failed to commit BOM clone. ${error instanceof Error ? error.message : String(error)}`)
      emitDiagnostic('BOM_STRUCTURE_PARSING_FAILURE', String(error))
    } finally {
      state.setCommitInProgress(false)
      state.setCommitProgress(0, 0)
      render()
    }

    if (!executionResult) return

    if (executionResult.successes.length > 0) refs.setHasCommittedOperations(true)

    if (executionResult.errors.length === 0) {
      state.setCommitErrors([])
      state.setCommitErrorsModalOpen(false)
      state.setShowCommitErrorsOnly(false)
      state.setErrorMessage(null)
      render()
      closeModalAndRefreshIfCommitted()
      return
    }

    const retryState = buildRetryState(hydratedSnapshot, executionResult)
    state.setSelectedNodesToClone(retryState.selectedNodeIds)
    state.setTargetItemNumberOverrides(retryState.targetItemNumberOverrides)
    state.setTargetQuantityOverrides(retryState.targetQuantityOverrides)
    state.setTargetFieldOverrides(retryState.targetFieldOverrides)
    state.setTargetMarkedForDeleteNodeIds(retryState.targetMarkedForDeleteNodeIds)
    state.setManufacturingOperationAssignments(retryState.manufacturingOperationAssignments)
    state.setManufacturingSelectedOperationNodeId(retryState.manufacturingSelectedOperationNodeId)

    try {
      await reloadStructureAfterCommit()
    } catch (reloadError) {
      const reloadFailureDetail = reloadError instanceof Error ? reloadError.message : String(reloadError)
      state.setErrorMessage(
        executionResult.errors.length > 0
          ? `Some changes were committed, but refresh failed. ${reloadFailureDetail}`
          : `Commit succeeded, but refresh failed. ${reloadFailureDetail}`
      )
      emitDiagnostic('BOM_STRUCTURE_PARSING_FAILURE', String(reloadError))
      render()
      return
    }

    if (retryState.failedProcessDrafts.length > 0 || retryState.failedSplitDrafts.length > 0) {
      const refreshedSnapshot = state.getSnapshot()
      const nextTargetBomTree = reinsertFailedSyntheticDrafts(refreshedSnapshot.targetBomTree, retryState)
      state.setTargetBomTree(nextTargetBomTree)
      state.setTargetExpandedNodeIds(
        buildExpandedNodeIdsForRetry(nextTargetBomTree, refreshedSnapshot.targetExpandedNodeIds, retryState)
      )
    }

    if (executionResult.errors.length > 0) {
      state.setCommitErrors(executionResult.errors.map((entry) => ({
        nodeId: entry.nodeId,
        descriptor: entry.descriptor,
        message: entry.message
      })))
      state.setCommitErrorsModalOpen(true)
      state.setShowCommitErrorsOnly(true)
      state.setErrorMessage(`Failed to commit ${executionResult.errors.length} process(es). Review commit errors.`)
      emitDiagnostic('BOM_STRUCTURE_PARSING_FAILURE', executionResult.errors.map((entry) => entry.message).join(' | '))
      render()
      return
    }

    state.setCommitErrors([])
    state.setCommitErrorsModalOpen(false)
    state.setShowCommitErrorsOnly(false)
    state.setErrorMessage(null)
    render()
  }

  function buildLifecycleHandlers(modalRoot: HTMLDivElement): LifecycleHandlers {
    return {
      onClose() {
        void requestCloseModal(modalRoot)
      },
      onCommitClone() {
        void commitClone()
      },
      onCloseCommitErrors() {
        state.setCommitErrorsModalOpen(false)
        state.setErrorMessage(null)
        render()
      }
    }
  }

  return {
    buildLifecycleHandlers,
    commitClone,
    requestCloseModal
  }
}


