import { cloneNode, findNode } from '../services/structure/tree.service'
import {
  applyLoadedChildren,
  applySelectionToggle,
  canStageSourceNode,
  collectAssemblyComponentNodeIds,
  createStagedOperationDraft,
  resolveManufacturingSourceSplit,
  resolveManufacturingSourceSplitDialogModel,
  resolveManufacturingSplit,
  resolveManufacturingSplitDialogModel,
  pruneManufacturingAssignmentsForOperation,
  resolveChildrenLoadContext,
  resolveCollapseAllNodeIds,
  resolveDefaultManufacturingOperationNodeId,
  resolveExpandAllExpandedNodeIds,
  resolveExpandAllFetchNodeIds,
  resolveExpandAllPendingNodeIds,
  resolveItemNumberOverrideForEdit,
  resolveQuantityEdit,
  resolveRemoveTargetNode,
  isManufacturingProcessNodeId,
  type TargetReorderPlacement,
  removeStagedOperationDraftNode,
  removeStagedSplitDraftNode,
  resolveTargetReorder
} from '../services/structure/structure.service'
import { countStagedOperations } from '../services/commit.service'
import { normalizeQuantity } from '../services/normalize.service'
import type { CloneControllerRefs, CloneState, CloneViewHandlers, EmitDiagnostic } from './types'
import type { CloneView } from './types'
import type { CloneService } from '../clone.service'
import { createEngineeringStructureModeFlow } from './structureFlowEngineering'
import { createManufacturingStructureModeFlow } from './structureFlowManufacturing'
import type { CloneStructureModeFlow } from './structureMode'

type StructureFlowOptions = {
  state: CloneState
  service: CloneService
  refs: CloneControllerRefs
  view: CloneView
  render: () => void
  emitDiagnostic: EmitDiagnostic
  updateSelectedNodes: (nextSelectedNodeIds: string[]) => void
  ensureOperationFormMetadataLoaded: () => Promise<void>
  ensureNodeMetadataHydratedForEditing: (nodeId: string, mode: 'item' | 'bom') => Promise<void>
}

type StructureHandlers = Pick<
  CloneViewHandlers,
  | 'onToggleNode'
  | 'onToggleSourceNodeExpanded'
  | 'onSetSourceStatusFilter'
  | 'onToggleTargetNodeExpanded'
  | 'onExpandAllSource'
  | 'onCollapseAllSource'
  | 'onExpandAllTarget'
  | 'onCollapseAllTarget'
  | 'onSelectManufacturingOperation'
  | 'onSelectManufacturingRoot'
  | 'onAddOperation'
  | 'onToggleShowCommitErrorsOnly'
  | 'onDropNodeToTarget'
  | 'onDropSourceAssemblySubcomponentsToTarget'
  | 'onSplitSourceNode'
  | 'onAddRemainingSourceNode'
  | 'onRemoveTargetNode'
  | 'onSplitTargetNode'
  | 'onEditTargetItemNumber'
  | 'onEditTargetQuantity'
  | 'onReorderTargetNode'
  | 'onOpenProcessItemDetails'
  | 'onOpenProcessBomDetails'
  | 'onResetTarget'
>

export function createCloneStructureFlow(options: StructureFlowOptions): {
  buildStructureHandlers: () => StructureHandlers
  expandAllOnOpen: () => void
} {
  const {
    state,
    service,
    refs,
    view,
    render,
    emitDiagnostic,
    updateSelectedNodes,
    ensureOperationFormMetadataLoaded,
    ensureNodeMetadataHydratedForEditing
  } = options
  const engineeringModeFlow = createEngineeringStructureModeFlow()
  const manufacturingModeFlow = createManufacturingStructureModeFlow({ state, render })

  function resolveModeFlow(): CloneStructureModeFlow {
    return state.getSnapshot().cloneLaunchMode === 'manufacturing'
      ? manufacturingModeFlow
      : engineeringModeFlow
  }

  function canEditTargetNode(snapshot: ReturnType<CloneState['getSnapshot']>, nodeId: string): boolean {
    const targetNode = findNode(snapshot.targetBomTree, nodeId)
    if (targetNode?.stagedOperationDraft || targetNode?.stagedSplitDraft) return snapshot.permissions.canAdd
    if (snapshot.selectedNodesToClone.includes(nodeId) && !targetNode) return snapshot.permissions.canAdd
    return false
  }

  function canDeleteTargetNode(snapshot: ReturnType<CloneState['getSnapshot']>, nodeId: string): boolean {
    const targetNode = findNode(snapshot.targetBomTree, nodeId)
    if (!targetNode) return snapshot.selectedNodesToClone.includes(nodeId)
    if (targetNode.stagedOperationDraft || targetNode.stagedSplitDraft) return true
    return snapshot.permissions.canDelete
  }

  function openLocalProcessEdit(nodeId: string, mode: 'item' | 'bom'): void {
    void (async () => {
      const snapshot = state.getSnapshot()
      if (!canEditTargetNode(snapshot, nodeId)) return
      state.setEditingPanelMode(mode)
      state.setEditingNodeId(nodeId)
      render()
      await ensureNodeMetadataHydratedForEditing(nodeId, mode)
      const targetNode = findNode(state.getSnapshot().targetBomTree, nodeId)
      const latestSnapshot = state.getSnapshot()
      const shouldLoadOperationMetadata = mode === 'item' && (
        Boolean(targetNode?.stagedOperationDraft)
        || isManufacturingProcessNodeId(latestSnapshot, nodeId)
      )
      if (shouldLoadOperationMetadata) {
        await ensureOperationFormMetadataLoaded()
      }
      render()
    })()
  }

  function setNodeLoading(nodeId: string, loading: boolean): void {
    const current = new Set(state.getSnapshot().expandingNodeIds)
    if (loading) current.add(nodeId)
    else current.delete(nodeId)
    state.setExpandingNodeIds(Array.from(current))
  }

  function collapseAllNodes(tree: 'source' | 'target'): void {
    const rootNodeIds = resolveCollapseAllNodeIds(state.getSnapshot(), tree)
    if (tree === 'source') state.setSourceExpandedNodeIds(rootNodeIds)
    else state.setTargetExpandedNodeIds(rootNodeIds)
    render()
  }

  function ensureTargetRowsVisibleForStagedNodes(nodeIds: string[]): void {
    const snapshot = state.getSnapshot()
    if (snapshot.cloneLaunchMode !== 'manufacturing') return

    const expanded = new Set(snapshot.targetExpandedNodeIds)
    const targetRootId = snapshot.targetBomTree[0]?.id || null
    if (targetRootId) expanded.add(targetRootId)

    for (const nodeId of nodeIds) {
      const parentOperationId = snapshot.manufacturingOperationBySourceNodeId[nodeId] || null
      if (parentOperationId) expanded.add(parentOperationId)
    }

    state.setTargetExpandedNodeIds(Array.from(expanded))
  }

  async function loadChildrenIfNeeded(_tree: 'source' | 'target', nodeId: string): Promise<void> {
    const context = refs.getContext()
    if (!context) return
    const snapshot = state.getSnapshot()
    const activeContext = resolveChildrenLoadContext(context, snapshot)
    const primaryNodes = _tree === 'source' ? snapshot.sourceBomTree : snapshot.targetBomTree
    const fallbackNodes = _tree === 'target' ? snapshot.sourceBomTree : []
    const node = findNode(primaryNodes, nodeId) || findNode(fallbackNodes, nodeId)
    if (!node || !node.hasExpandableChildren || node.childrenLoaded || node.children.length > 0) return

    const subtree = await service.fetchSourceBomStructure(activeContext, Number(nodeId))
    const latestSnapshot = state.getSnapshot()
    if (_tree === 'source') {
      const updatedSourceNodes = applyLoadedChildren(latestSnapshot.sourceBomTree, nodeId, subtree)
      if (updatedSourceNodes !== latestSnapshot.sourceBomTree) state.setSourceBomTree(updatedSourceNodes)
      return
    }

    const updatedTargetNodes = applyLoadedChildren(latestSnapshot.targetBomTree, nodeId, subtree)
    const updatedSourceNodes = applyLoadedChildren(latestSnapshot.sourceBomTree, nodeId, subtree)
    if (updatedTargetNodes !== latestSnapshot.targetBomTree) state.setTargetBomTree(updatedTargetNodes)
    if (updatedSourceNodes !== latestSnapshot.sourceBomTree) state.setSourceBomTree(updatedSourceNodes)
  }

  async function loadSubtreeWithDepth(
    _tree: 'source' | 'target',
    nodeId: string,
    depth: number,
    force = false
  ): Promise<void> {
    const context = refs.getContext()
    if (!context) return
    const snapshot = state.getSnapshot()
    const activeContext = resolveChildrenLoadContext(context, snapshot)
    const primaryNodes = _tree === 'source' ? snapshot.sourceBomTree : snapshot.targetBomTree
    const fallbackNodes = _tree === 'target' ? snapshot.sourceBomTree : []
    const node = findNode(primaryNodes, nodeId) || findNode(fallbackNodes, nodeId)
    if (!node || !node.hasExpandableChildren) return
    if (!force && (node.childrenLoaded || node.children.length > 0)) return

    const subtree = await service.fetchSourceBomStructure(activeContext, Number(nodeId), { depth })
    const latestSnapshot = state.getSnapshot()
    if (_tree === 'source') {
      const updatedSourceNodes = applyLoadedChildren(latestSnapshot.sourceBomTree, nodeId, subtree, { force })
      if (updatedSourceNodes !== latestSnapshot.sourceBomTree) state.setSourceBomTree(updatedSourceNodes)
      return
    }

    const updatedTargetNodes = applyLoadedChildren(latestSnapshot.targetBomTree, nodeId, subtree, { force })
    const updatedSourceNodes = applyLoadedChildren(latestSnapshot.sourceBomTree, nodeId, subtree, { force })
    if (updatedTargetNodes !== latestSnapshot.targetBomTree) state.setTargetBomTree(updatedTargetNodes)
    if (updatedSourceNodes !== latestSnapshot.sourceBomTree) state.setSourceBomTree(updatedSourceNodes)
  }

  async function toggleNodeExpanded(tree: 'source' | 'target', nodeId: string): Promise<void> {
    const snapshot = state.getSnapshot()
    const expanded = new Set(tree === 'source' ? snapshot.sourceExpandedNodeIds : snapshot.targetExpandedNodeIds)
    const willExpand = !expanded.has(nodeId)

    if (willExpand) {
      setNodeLoading(nodeId, true)
      render()
      try {
        await loadChildrenIfNeeded(tree, nodeId)
      } catch (error) {
        emitDiagnostic('BOM_STRUCTURE_PARSING_FAILURE', String(error))
      } finally {
        setNodeLoading(nodeId, false)
      }
      expanded.add(nodeId)
    } else {
      expanded.delete(nodeId)
    }

    if (tree === 'source') state.setSourceExpandedNodeIds(Array.from(expanded))
    else state.setTargetExpandedNodeIds(Array.from(expanded))
    render()
  }

  async function expandAllNodes(tree: 'source' | 'target'): Promise<void> {
    const loadingSnapshot = state.getSnapshot()
    if (tree === 'source' && loadingSnapshot.sourceExpandAllLoading) return
    if (tree === 'target' && loadingSnapshot.targetExpandAllLoading) return
    if (tree === 'source') state.setSourceExpandAllLoading(true)
    else state.setTargetExpandAllLoading(true)
    render()

    const maxConcurrentLoads = 6
    const deepFetchDepth = 100
    const loadingBefore = new Set(state.getSnapshot().expandingNodeIds)
    const expandAllLoading = new Set<string>()
    try {
      if (tree === 'source') {
        const sourceSnapshot = state.getSnapshot()
        const sourceRootNodeId = sourceSnapshot.sourceBomTree[0]?.id || null
        if (sourceRootNodeId) {
          expandAllLoading.add(sourceRootNodeId)
          state.setExpandingNodeIds(Array.from(new Set([...loadingBefore, ...expandAllLoading])))
          render()
          try {
            await loadSubtreeWithDepth('source', sourceRootNodeId, deepFetchDepth)
          } catch (error) {
            emitDiagnostic('BOM_STRUCTURE_PARSING_FAILURE', String(error))
          }
        }
        const expandedNodeIds = resolveExpandAllExpandedNodeIds(state.getSnapshot(), 'source')
        state.setSourceExpandedNodeIds(expandedNodeIds)
        state.setExpandingNodeIds(Array.from(loadingBefore))
        render()
        return
      }

      for (let iteration = 0; iteration < 3; iteration += 1) {
        const snapshot = state.getSnapshot()
        const pendingList = resolveExpandAllPendingNodeIds(snapshot, tree)
        if (pendingList.length === 0) break
        const fetchNodeIds = resolveExpandAllFetchNodeIds(snapshot, tree)
        if (fetchNodeIds.length === 0) break
        for (const nodeId of fetchNodeIds) expandAllLoading.add(nodeId)
        state.setExpandingNodeIds(Array.from(new Set([...loadingBefore, ...expandAllLoading])))
        render()
        for (let index = 0; index < fetchNodeIds.length; index += maxConcurrentLoads) {
          const batch = fetchNodeIds.slice(index, index + maxConcurrentLoads)
          const results = await Promise.allSettled(
            batch.map((nodeId) => loadSubtreeWithDepth(tree, nodeId, deepFetchDepth, true))
          )
          for (const result of results) {
            if (result.status === 'rejected') {
              emitDiagnostic('BOM_STRUCTURE_PARSING_FAILURE', String(result.reason))
            }
          }
        }
      }

      const expandedNodeIds = resolveExpandAllExpandedNodeIds(state.getSnapshot(), tree)
      state.setTargetExpandedNodeIds(expandedNodeIds)
      state.setExpandingNodeIds(Array.from(loadingBefore))
      render()
    } finally {
      if (tree === 'source') state.setSourceExpandAllLoading(false)
      else state.setTargetExpandAllLoading(false)
      render()
    }
  }

  function resetTargetToInitialState(): void {
    const snapshot = state.getSnapshot()
    if (snapshot.initialTargetBomTree.length === 0) return

    state.setTargetBomTree(snapshot.initialTargetBomTree.map(cloneNode))
    state.setTargetExpandedNodeIds([...snapshot.initialTargetExpandedNodeIds])
    state.setTargetBomPreExistingItemIds([...snapshot.initialTargetBomPreExistingItemIds])
    state.setLinkableOnTargetBomItemIds([...snapshot.initialLinkableOnTargetBomItemIds])
    state.setManufacturingSelectedOperationNodeId(snapshot.initialManufacturingSelectedOperationNodeId)
    state.setManufacturingOperationAssignments({})
    updateSelectedNodes([])
    state.setPendingAddNodeIds([])
    state.setExpandingNodeIds([])
    state.setTargetQuantityOverrides({})
    state.setTargetFieldOverrides({})
    state.setTargetMarkedForDeleteNodeIds([])
    state.setEditingNodeId(null)
    state.setCommitErrors([])
    state.setCommitInProgress(false)
    state.setCommitProgress(0, 0)
    state.setErrorMessage(null)
    render()
  }

  function applySplitResult(
    splitResult: {
      nextTargetBomTree: ReturnType<CloneState['getSnapshot']>['targetBomTree']
      nextSelectedNodeIds: string[]
      nextTargetQuantityOverrides: Record<string, string>
      nextManufacturingOperationAssignments: Record<string, string>
      nextTargetItemNumberOverrides: Record<string, string>
    },
    destinationOperationNodeId: string | null
  ): void {
    state.setTargetBomTree(splitResult.nextTargetBomTree)
    updateSelectedNodes(splitResult.nextSelectedNodeIds)
    state.setTargetQuantityOverrides(splitResult.nextTargetQuantityOverrides)
    state.setManufacturingOperationAssignments(splitResult.nextManufacturingOperationAssignments)
    state.setTargetItemNumberOverrides(splitResult.nextTargetItemNumberOverrides)
    const expanded = new Set(state.getSnapshot().targetExpandedNodeIds)
    const targetRootId = splitResult.nextTargetBomTree[0]?.id || null
    if (targetRootId) expanded.add(targetRootId)
    if (destinationOperationNodeId) expanded.add(destinationOperationNodeId)
    state.setTargetExpandedNodeIds(Array.from(expanded))
    state.setErrorMessage(null)
  }

  function buildStructureHandlers(): StructureHandlers {
    return {
      onToggleNode(nodeId: string, selected: boolean) {
        const snapshot = state.getSnapshot()
        const nextSelectedNodeIds = applySelectionToggle(snapshot.selectedNodesToClone, nodeId, selected)
        updateSelectedNodes(nextSelectedNodeIds)
        render()
      },
      onToggleSourceNodeExpanded(nodeId: string) {
        void toggleNodeExpanded('source', nodeId)
      },
      onSetSourceStatusFilter(value) {
        state.setSourceStatusFilter(value)
        render()
      },
      onToggleTargetNodeExpanded(nodeId: string) {
        void toggleNodeExpanded('target', nodeId)
      },
      onExpandAllSource() {
        void expandAllNodes('source')
      },
      onCollapseAllSource() {
        collapseAllNodes('source')
      },
      onExpandAllTarget() {
        void expandAllNodes('target')
      },
      onCollapseAllTarget() {
        collapseAllNodes('target')
      },
      onSelectManufacturingOperation(nodeId: string) {
        resolveModeFlow().onSelectOperation(nodeId)
      },
      onSelectManufacturingRoot() {
        state.setManufacturingSelectedOperationNodeId(null)
        render()
      },
      onAddOperation() {
        const snapshot = state.getSnapshot()
        if (!snapshot.permissions.canAdd) return
        if (snapshot.cloneLaunchMode !== 'manufacturing') return
        const draft = createStagedOperationDraft(snapshot)
        if (!draft.draftNodeId) return
        state.setTargetBomTree(draft.nextTargetBomTree)
        const targetRootId = draft.nextTargetBomTree[0]?.id || null
        if (targetRootId) {
          const expanded = new Set(state.getSnapshot().targetExpandedNodeIds)
          expanded.add(targetRootId)
          state.setTargetExpandedNodeIds(Array.from(expanded))
        }
        updateSelectedNodes(draft.nextSelectedNodeIds)
        state.setManufacturingSelectedOperationNodeId(draft.draftNodeId)
        state.setEditingNodeId(draft.draftNodeId)
        void ensureOperationFormMetadataLoaded()
        render()
      },
      onToggleShowCommitErrorsOnly() {
        const snapshot = state.getSnapshot()
        if (snapshot.commitErrors.length === 0) return
        state.setShowCommitErrorsOnly(!snapshot.showCommitErrorsOnly)
        render()
      },
      onDropNodeToTarget(nodeId: string, targetOperationNodeId?: string | null) {
        let snapshot = state.getSnapshot()
        if (!snapshot.permissions.canAdd) return
        if (!canStageSourceNode(snapshot, nodeId)) return
        if (snapshot.cloneLaunchMode === 'manufacturing') {
          const explicitOperationNodeId = String(targetOperationNodeId || '').trim()
          if (explicitOperationNodeId) state.setManufacturingSelectedOperationNodeId(explicitOperationNodeId)
          else if (targetOperationNodeId === null) state.setManufacturingSelectedOperationNodeId(null)
          snapshot = state.getSnapshot()
        }
        if (!resolveModeFlow().beforeStageSourceNode(snapshot, nodeId)) return
        const nextSelectedNodeIds = applySelectionToggle(snapshot.selectedNodesToClone, nodeId, true)
        updateSelectedNodes(nextSelectedNodeIds)
        ensureTargetRowsVisibleForStagedNodes([nodeId])
        render()
      },
      onDropSourceAssemblySubcomponentsToTarget(nodeId: string) {
        void (async () => {
          const initialSnapshot = state.getSnapshot()
          if (!initialSnapshot.permissions.canAdd) return
          if (initialSnapshot.cloneLaunchMode !== 'manufacturing') return

          const expandingBefore = new Set(initialSnapshot.expandingNodeIds)
          const expandingNext = new Set(expandingBefore)
          expandingNext.add(nodeId)
          state.setExpandingNodeIds(Array.from(expandingNext))
          render()
          try {
            await loadSubtreeWithDepth('source', nodeId, 100)
          } catch (error) {
            emitDiagnostic('BOM_STRUCTURE_PARSING_FAILURE', String(error))
          } finally {
            state.setExpandingNodeIds(Array.from(expandingBefore))
          }

          const snapshot = state.getSnapshot()
          const selectedBefore = new Set(snapshot.selectedNodesToClone)
          const componentNodeIds = collectAssemblyComponentNodeIds(snapshot, nodeId)
          if (componentNodeIds.length === 0) {
            render()
            return
          }

          let nextSelectedNodeIds = snapshot.selectedNodesToClone
          for (const componentNodeId of componentNodeIds) {
            const latest = state.getSnapshot()
            if (!canStageSourceNode(latest, componentNodeId)) continue
            if (!resolveModeFlow().beforeStageSourceNode(latest, componentNodeId)) {
              render()
              return
            }
            nextSelectedNodeIds = applySelectionToggle(nextSelectedNodeIds, componentNodeId, true)
          }
          updateSelectedNodes(nextSelectedNodeIds)
          const newlySelected = componentNodeIds.filter((componentNodeId) => !selectedBefore.has(componentNodeId))
          ensureTargetRowsVisibleForStagedNodes(newlySelected)
          render()
        })()
      },
      onSplitSourceNode(nodeId: string) {
        void (async () => {
          const snapshot = state.getSnapshot()
          if (!snapshot.permissions.canAdd) return
          if (snapshot.cloneLaunchMode !== 'manufacturing') return
          if (snapshot.commitInProgress || Boolean(snapshot.editingNodeId)) return
          const modalRoot = refs.getStructureModalRoot()
          if (!modalRoot) return

          const splitDialogModel = resolveManufacturingSourceSplitDialogModel(snapshot, nodeId)
          if (!splitDialogModel) {
            state.setErrorMessage('No source quantity remains to split.')
            render()
            return
          }

          const selection = await view.showSplitQuantityDialog(modalRoot, {
            descriptor: splitDialogModel.descriptor,
            totalQuantity: splitDialogModel.totalQuantity,
            remainingQuantity: splitDialogModel.remainingQuantity,
            currentQuantity: splitDialogModel.currentQuantity,
            maxSplitQuantity: splitDialogModel.maxSplitQuantity,
            unitOfMeasure: splitDialogModel.unitOfMeasure,
            processOptions: splitDialogModel.processOptions,
            allowRootDestinationWhenEmpty: true,
            allowEqualCurrentQuantity: true
          })
          if (!selection) return

          const latestSnapshot = state.getSnapshot()
          const splitResult = resolveManufacturingSourceSplit(latestSnapshot, {
            sourceNodeId: nodeId,
            destinationOperationNodeId: selection.destinationOperationNodeId,
            splitQuantity: selection.splitQuantity
          })
          if (splitResult.ok === false) {
            state.setErrorMessage(splitResult.errorMessage)
            render()
            return
          }

          applySplitResult(splitResult, selection.destinationOperationNodeId || null)
          render()
        })()
      },
      onAddRemainingSourceNode(nodeId: string) {
        void (async () => {
          const snapshot = state.getSnapshot()
          if (!snapshot.permissions.canAdd) return
          if (snapshot.cloneLaunchMode !== 'manufacturing') return
          if (snapshot.commitInProgress || Boolean(snapshot.editingNodeId)) return

          const splitDialogModel = resolveManufacturingSourceSplitDialogModel(snapshot, nodeId)
          if (!splitDialogModel) {
            state.setErrorMessage('No source quantity remains to add.')
            render()
            return
          }

          const sourceAssignedToRoot = snapshot.selectedNodesToClone.includes(nodeId)
            && !snapshot.manufacturingOperationBySourceNodeId[nodeId]
          if (sourceAssignedToRoot) {
            state.setTargetQuantityOverride(nodeId, null)
            state.setErrorMessage(null)
            render()
            return
          }

          const processOptions = splitDialogModel.processOptions
          const allowRootDestination = processOptions.length === 0

          const selectedOperationNodeId = String(snapshot.manufacturingSelectedOperationNodeId || '').trim()
          let destinationOperationNodeId = processOptions.find((entry) => entry.operationNodeId === selectedOperationNodeId)?.operationNodeId
            || (processOptions.length === 1 ? processOptions[0].operationNodeId : (allowRootDestination ? '' : null))

          if (!destinationOperationNodeId && !allowRootDestination) {
            const modalRoot = refs.getStructureModalRoot()
            if (!modalRoot) return
            const selection = await view.showSplitQuantityDialog(modalRoot, {
              descriptor: splitDialogModel.descriptor,
              totalQuantity: splitDialogModel.totalQuantity,
              remainingQuantity: splitDialogModel.remainingQuantity,
              currentQuantity: splitDialogModel.currentQuantity,
              maxSplitQuantity: splitDialogModel.maxSplitQuantity,
              unitOfMeasure: splitDialogModel.unitOfMeasure,
              processOptions,
              allowRootDestinationWhenEmpty: true,
              allowEqualCurrentQuantity: true
            })
            if (!selection) return
            destinationOperationNodeId = selection.destinationOperationNodeId
          }

          const latestSnapshot = state.getSnapshot()
          const splitResult = resolveManufacturingSourceSplit(latestSnapshot, {
            sourceNodeId: nodeId,
            destinationOperationNodeId,
            splitQuantity: normalizeQuantity(splitDialogModel.maxSplitQuantity, splitDialogModel.maxSplitQuantity)
          })
          if (splitResult.ok === false) {
            state.setErrorMessage(splitResult.errorMessage)
            render()
            return
          }

          applySplitResult(splitResult, destinationOperationNodeId || null)
          render()
        })()
      },
      onRemoveTargetNode(nodeId: string) {
        const snapshot = state.getSnapshot()
        const targetNode = findNode(snapshot.targetBomTree, nodeId)
        const isStagedOperationDraft = Boolean(targetNode?.stagedOperationDraft)
        const isStagedSplitDraft = Boolean(targetNode?.stagedSplitDraft)
        if (!canDeleteTargetNode(snapshot, nodeId)) return
        if (isStagedSplitDraft) {
          const removeSplitResult = removeStagedSplitDraftNode(snapshot, nodeId)
          if (removeSplitResult.removed) state.setTargetBomTree(removeSplitResult.nextTargetBomTree)
          updateSelectedNodes(snapshot.selectedNodesToClone.filter((entry) => entry !== nodeId))
          state.setTargetItemNumberOverride(nodeId, null)
          state.setTargetQuantityOverride(nodeId, null)
          state.setTargetFieldOverride(nodeId, {})
          resolveModeFlow().onUnstageNode(nodeId)
          render()
          return
        }
        const result = resolveRemoveTargetNode(snapshot, nodeId)
        if (result.unstageNode) {
          if (isStagedOperationDraft) {
            const removeDraftResult = removeStagedOperationDraftNode(snapshot, nodeId)
            state.setTargetBomTree(removeDraftResult.nextTargetBomTree)
            updateSelectedNodes(removeDraftResult.nextSelectedNodeIds)
            const latestSnapshot = state.getSnapshot()
            state.setManufacturingOperationAssignments(
              pruneManufacturingAssignmentsForOperation(
                latestSnapshot.manufacturingOperationBySourceNodeId,
                nodeId
              )
            )
            if (latestSnapshot.manufacturingSelectedOperationNodeId === nodeId) {
              state.setManufacturingSelectedOperationNodeId(
                resolveDefaultManufacturingOperationNodeId({
                  targetBomTree: removeDraftResult.nextTargetBomTree,
                  sourceBomTree: latestSnapshot.sourceBomTree
                })
              )
            }
            if (latestSnapshot.editingNodeId === nodeId) state.setEditingNodeId(null)
          } else {
            updateSelectedNodes(result.nextSelectedNodeIds)
          }
          state.setTargetItemNumberOverride(nodeId, null)
          state.setTargetQuantityOverride(nodeId, null)
          state.setTargetFieldOverride(nodeId, {})
          resolveModeFlow().onUnstageNode(nodeId)
        } else {
          state.setTargetMarkedForDeleteNodeIds(result.nextMarkedForDeleteNodeIds)
        }
        render()
      },
      onSplitTargetNode(nodeId: string) {
        void (async () => {
          const snapshot = state.getSnapshot()
          if (snapshot.cloneLaunchMode !== 'manufacturing') return
          if (snapshot.commitInProgress || Boolean(snapshot.editingNodeId)) return
          const modalRoot = refs.getStructureModalRoot()
          if (!modalRoot) return

          const splitDialogModel = resolveManufacturingSplitDialogModel(snapshot, nodeId)
          if (!splitDialogModel) {
            state.setErrorMessage('This row cannot be split right now.')
            render()
            return
          }
          if (splitDialogModel.processOptions.length === 0) {
            state.setErrorMessage('Add another process before splitting this row.')
            render()
            return
          }

          const selection = await view.showSplitQuantityDialog(modalRoot, {
            descriptor: splitDialogModel.descriptor,
            totalQuantity: splitDialogModel.totalQuantity,
            remainingQuantity: splitDialogModel.remainingQuantity,
            currentQuantity: splitDialogModel.currentQuantity,
            maxSplitQuantity: splitDialogModel.maxSplitQuantity,
            unitOfMeasure: splitDialogModel.unitOfMeasure,
            processOptions: splitDialogModel.processOptions
          })
          if (!selection) return

          const latestSnapshot = state.getSnapshot()
          const splitResult = resolveManufacturingSplit(latestSnapshot, {
            nodeId,
            destinationOperationNodeId: selection.destinationOperationNodeId,
            splitQuantity: selection.splitQuantity
          })
          if (splitResult.ok === false) {
            state.setErrorMessage(splitResult.errorMessage)
            render()
            return
          }

          state.setTargetBomTree(splitResult.nextTargetBomTree)
          updateSelectedNodes(splitResult.nextSelectedNodeIds)
          state.setTargetQuantityOverrides(splitResult.nextTargetQuantityOverrides)
          state.setManufacturingOperationAssignments(splitResult.nextManufacturingOperationAssignments)
          state.setTargetItemNumberOverrides(splitResult.nextTargetItemNumberOverrides)
          const expanded = new Set(state.getSnapshot().targetExpandedNodeIds)
          const targetRootId = splitResult.nextTargetBomTree[0]?.id || null
          if (targetRootId) expanded.add(targetRootId)
          expanded.add(selection.destinationOperationNodeId)
          state.setTargetExpandedNodeIds(Array.from(expanded))
          state.setErrorMessage(null)
          render()
        })()
      },
      onEditTargetItemNumber(nodeId: string, value: string) {
        if (!canEditTargetNode(state.getSnapshot(), nodeId)) return
        const override = resolveItemNumberOverrideForEdit(state.getSnapshot(), nodeId, value)
        state.setTargetItemNumberOverride(nodeId, override)
        render()
      },
      onEditTargetQuantity(nodeId: string, value: string) {
        if (!canEditTargetNode(state.getSnapshot(), nodeId)) return
        const quantityEdit = resolveQuantityEdit(state.getSnapshot(), nodeId, value)
        state.setTargetQuantityOverride(nodeId, quantityEdit.quantityOverride)
        if (quantityEdit.fieldOverrides !== null) state.setTargetFieldOverride(nodeId, quantityEdit.fieldOverrides)
        render()
      },
      onReorderTargetNode(draggedNodeId: string, targetNodeId: string, placement: TargetReorderPlacement) {
        const snapshot = state.getSnapshot()
        const reorder = resolveTargetReorder(snapshot, draggedNodeId, targetNodeId, placement)
        if (!reorder) return
        if (reorder.nextTargetBomTree) state.setTargetBomTree(reorder.nextTargetBomTree)
        state.setSelectedNodesToClone(reorder.nextSelectedNodeIds)
        if (reorder.nextManufacturingOperationAssignments) {
          state.setManufacturingOperationAssignments(reorder.nextManufacturingOperationAssignments)
        }
        state.setTargetItemNumberOverrides(reorder.nextTargetItemNumberOverrides)
        render()
      },
      onOpenProcessItemDetails(nodeId: string) {
        openLocalProcessEdit(nodeId, 'item')
      },
      onOpenProcessBomDetails(nodeId: string) {
        openLocalProcessEdit(nodeId, 'bom')
      },
      onResetTarget() {
        void (async () => {
          const snapshot = state.getSnapshot()
          if (snapshot.commitInProgress || Boolean(snapshot.editingNodeId)) return
          const modalRoot = refs.getStructureModalRoot()
          if (!modalRoot) return
          const shouldReset = await view.showResetConfirm(modalRoot, countStagedOperations(snapshot))
          if (!shouldReset) return
          resetTargetToInitialState()
        })()
      }
    }
  }

  function expandAllOnOpen(): void {
    void expandAllNodes('source')
    void expandAllNodes('target')
  }

  return { buildStructureHandlers, expandAllOnOpen }
}
