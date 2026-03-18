import { createItemSelectorService } from '../../../shared/item-selector/service'
import { createItemSelectorSession } from '../../../shared/item-selector/session'
import { createCloneDom, type CloneDomAdapter } from './clone.dom'
import { createCloneHealth } from './clone.health'
import { createEmptyBomClonePermissions, resolveBomClonePermissions, type BomClonePermissions } from './clone.permissions'
import { createCloneService } from './clone.service'
import { createCloneState } from './clone.state'
import type { BomCloneCapabilityState, BomCloneContext, CloneLaunchMode } from './clone.types'
import { createCloneView } from './clone.view'
import { createCloneCommitFlow } from './controller/commitFlow'
import { createCloneSearchFlow } from './controller/searchFlow'
import type { CloneControllerRefs, CloneRuntime } from './controller/types'
import { remapBomFieldValuesByFieldId } from './services/field.service'
import {
  buildAutoOverridesForSelection,
  buildManufacturingItemNumberOverrides,
  isManufacturingProcessNodeId
} from './services/structure/structure.service'
import { findNode, mergeBomNodeCollections, mergeNodeIntoTreeById, resolveNodeItemId } from './services/structure/tree.service'

type CloneController = {
  mount: () => void
  update: () => void
  unmount: () => void
  launchClone: (mode: CloneLaunchMode) => Promise<void>
}

type StructureFlowModule = typeof import('./controller/structureFlow')
type EditFlowModule = typeof import('./controller/editFlow')
type StructureFlow = ReturnType<StructureFlowModule['createCloneStructureFlow']>
type EditFlow = ReturnType<EditFlowModule['createCloneEditFlow']>

export function createCloneController(runtime: CloneRuntime): CloneController {
  const state = createCloneState()
  const dom: CloneDomAdapter = createCloneDom(runtime)
  const service = createCloneService(runtime)
  const itemSelectorService = createItemSelectorService(runtime)
  const view = createCloneView(() => render())
  const health = createCloneHealth()

  let context: BomCloneContext | null = null
  let searchModalRoot: HTMLDivElement | null = null
  let structureModalRoot: HTMLDivElement | null = null
  let lastHealthState: BomCloneCapabilityState | null = null
  let lastDiagnosticKey = ''
  let stopDomObservation: (() => void) | null = null
  let refreshTimer: number | null = null
  let keepAliveTimer: number | null = null
  let mounted = false
  let hasCommittedOperations = false
  let lastUrl = window.location.href
  const navEventName = 'plm-extension-location-change'
  let groupIdSeed = 0
  let filterIdSeed = 0
  let linkableSearchDebounceTimer: number | null = null
  let operationFormLoadPromise: Promise<void> | null = null
  let targetMetadataHydrationPromise: Promise<void> | null = null
  let permissionContextKey: string | null = null
  let permissionLoadInFlight: Promise<BomClonePermissions> | null = null
  let interactiveFlowsLoadPromise: Promise<void> | null = null

  const refs: CloneControllerRefs = {
    getContext: () => context,
    setContext: (next) => {
      context = next
    },
    getSearchModalRoot: () => searchModalRoot,
    setSearchModalRoot: (next) => {
      searchModalRoot = next
    },
    getStructureModalRoot: () => structureModalRoot,
    setStructureModalRoot: (next) => {
      structureModalRoot = next
    },
    getHasCommittedOperations: () => hasCommittedOperations,
    setHasCommittedOperations: (next) => {
      hasCommittedOperations = next
    },
    getLinkableSearchDebounceTimer: () => linkableSearchDebounceTimer,
    setLinkableSearchDebounceTimer: (next) => {
      linkableSearchDebounceTimer = next
    }
  }

  function nextGroupId(): string {
    groupIdSeed += 1
    return `group_${groupIdSeed}`
  }

  function nextFilterId(): string {
    filterIdSeed += 1
    return `filter_${filterIdSeed}`
  }

  function setHealthState(next: BomCloneCapabilityState): void {
    if (lastHealthState === next) return
    lastHealthState = next
    health.setState(next, window.location.href)
  }

  function emitDiagnostic(code: Parameters<typeof health.emitDiagnostic>[0], detail: string): void {
    const key = `${code}:${detail}`
    if (lastDiagnosticKey === key) return
    lastDiagnosticKey = key
    health.emitDiagnostic(code, window.location.href, detail)
  }

  function clearRefreshTimer(): void {
    if (refreshTimer === null) return
    window.clearTimeout(refreshTimer)
    refreshTimer = null
  }

  function clearKeepAliveTimer(): void {
    if (keepAliveTimer === null) return
    window.clearInterval(keepAliveTimer)
    keepAliveTimer = null
  }

  function clearLinkableSearchDebounceTimer(): void {
    const current = refs.getLinkableSearchDebounceTimer()
    if (current === null) return
    window.clearTimeout(current)
    refs.setLinkableSearchDebounceTimer(null)
  }

  function closeModal(): void {
    clearLinkableSearchDebounceTimer()
    operationFormLoadPromise = null
    const snapshot = state.getSnapshot()
    dom.closeSearchModalShell()
    dom.closeStructureModalShell()
    refs.setSearchModalRoot(null)
    refs.setStructureModalRoot(null)
    state.reset()
    state.setPermissions(snapshot.permissions)
    state.setPermissionsLoading(snapshot.permissionsLoading)
    state.setPermissionsResolved(snapshot.permissionsResolved)
  }

  function clearPermissionState(): void {
    permissionLoadInFlight = null
    state.setPermissions(createEmptyBomClonePermissions())
    state.setPermissionsLoading(false)
    state.setPermissionsResolved(false)
  }

  async function refreshPermissionsForCurrentContext(forceRefresh = false): Promise<BomClonePermissions> {
    const activeContext = refs.getContext()
    if (!activeContext) return createEmptyBomClonePermissions()
    const permissions = await resolveBomClonePermissions(
      runtime,
      activeContext.tenant,
      activeContext.workspaceId,
      forceRefresh
    ).catch(() => createEmptyBomClonePermissions())
    state.setPermissions(permissions)
    state.setPermissionsResolved(true)
    state.setPermissionsLoading(false)
    return permissions
  }

  async function ensureOperationFormMetadataLoaded(): Promise<void> {
    const activeContext = refs.getContext()
    if (!activeContext) return
    const snapshot = state.getSnapshot()
    if (snapshot.operationFormFields.length > 0) return
    if (operationFormLoadPromise) return operationFormLoadPromise

    state.setOperationFormFieldsLoading(true)
    state.setOperationFormFieldsError(null)
    render()

    operationFormLoadPromise = (async () => {
      try {
        const result = await service.fetchOperationFormDefinition(activeContext)
        state.setOperationFormFields(result.fields, result.sections, result.metaLinks)
      } catch (error) {
        state.setOperationFormFieldsError(
          `Failed to load process fields. ${error instanceof Error ? error.message : String(error)}`
        )
        emitDiagnostic('WORKSPACE_FIELD_LOAD_FAILURE', String(error))
      } finally {
        state.setOperationFormFieldsLoading(false)
        operationFormLoadPromise = null
        render()
      }
    })()

    return operationFormLoadPromise
  }

  function resolveHydrationViewDefIds() {
    const snapshot = state.getSnapshot()
    const activeContext = refs.getContext()
    const fallbackViewDefId = activeContext?.viewDefId ?? null
    const viewDefIds = snapshot.bomViewDefIds.length > 0
      ? [...snapshot.bomViewDefIds]
      : (fallbackViewDefId !== null ? [fallbackViewDefId] : [])
    const effectiveViewDefId = viewDefIds[0] ?? fallbackViewDefId ?? null
    return { viewDefIds, effectiveViewDefId }
  }

  function hasLogicalBomFieldValues(node: { bomFieldValues?: Record<string, string> } | null): boolean {
    if (!node?.bomFieldValues) return false
    const fieldIds = new Set(state.getSnapshot().bomViewFields.map((field) => String(field.fieldId)))
    return Object.keys(node.bomFieldValues).some((fieldId) => fieldIds.has(String(fieldId)))
  }

  async function hydrateTargetBomMetadata(): Promise<void> {
    const activeContext = refs.getContext()
    if (!activeContext) return
    if (targetMetadataHydrationPromise) return targetMetadataHydrationPromise

    targetMetadataHydrationPromise = (async () => {
      const { viewDefIds, effectiveViewDefId } = resolveHydrationViewDefIds()
      const snapshotBefore = state.getSnapshot()
      const hydratedTree = await service.fetchSourceBomStructureAcrossViews(
        { ...activeContext, viewDefId: effectiveViewDefId },
        activeContext.currentItemId,
        viewDefIds
      )
      const normalizedHydratedTree = remapBomFieldValuesByFieldId(
        hydratedTree,
        snapshotBefore.bomViewFieldIdToFieldId
      )
      const latestSnapshot = state.getSnapshot()
      state.setTargetBomTree(mergeBomNodeCollections(latestSnapshot.targetBomTree, normalizedHydratedTree))
      render()
    })().finally(() => {
      targetMetadataHydrationPromise = null
    })

    return targetMetadataHydrationPromise
  }

  async function ensureNodeMetadataHydratedForEditing(nodeId: string, mode: 'item' | 'bom'): Promise<void> {
    const snapshot = state.getSnapshot()
    const targetNode = findNode(snapshot.targetBomTree, nodeId)
    const editingManufacturingProcess = snapshot.cloneLaunchMode === 'manufacturing'
      && isManufacturingProcessNodeId(snapshot, nodeId)

    if (
      targetNode
      && !targetNode.stagedOperationDraft
      && !editingManufacturingProcess
      && !hasLogicalBomFieldValues(targetNode)
    ) {
      await hydrateTargetBomMetadata()
      return
    }

    if (mode === 'bom' || snapshot.cloneLaunchMode === 'engineering') {
      const sourceNode = findNode(snapshot.sourceBomTree, nodeId)
      if (!sourceNode || hasLogicalBomFieldValues(sourceNode)) return

      const activeContext = refs.getContext()
      const itemId = resolveNodeItemId(sourceNode)
      if (!activeContext || !itemId) return

      const { viewDefIds, effectiveViewDefId } = resolveHydrationViewDefIds()
      const hydratedSubtree = await service.fetchSourceBomStructureAcrossViews(
        { ...activeContext, viewDefId: effectiveViewDefId },
        itemId,
        viewDefIds
      )
      const normalizedSubtree = remapBomFieldValuesByFieldId(
        hydratedSubtree,
        state.getSnapshot().bomViewFieldIdToFieldId
      )
      const subtreeRoot = normalizedSubtree.find((node) => node.id === String(itemId)) || normalizedSubtree[0] || null
      if (!subtreeRoot) return
      state.setSourceBomTree(mergeNodeIntoTreeById(state.getSnapshot().sourceBomTree, nodeId, subtreeRoot))
      render()
    }
  }

  function targetCommitMetadataNeedsHydration(): boolean {
    const snapshot = state.getSnapshot()
    const rows: Array<(typeof snapshot.targetBomTree)[number]> = []
    const visit = (nodes: typeof snapshot.targetBomTree): void => {
      for (const node of nodes) {
        rows.push(node)
        if (node.children.length > 0) visit(node.children)
      }
    }
    visit(snapshot.targetBomTree)

    for (const node of rows) {
      if (node.stagedOperationDraft || node.stagedSplitDraft) continue
      const markedForDelete = snapshot.targetMarkedForDeleteNodeIds.includes(node.id)
      const hasItemOverride = Object.prototype.hasOwnProperty.call(snapshot.targetItemNumberOverrides, node.id)
      const hasQtyOverride = Object.prototype.hasOwnProperty.call(snapshot.targetQuantityOverrides, node.id)
      const hasFieldOverride = Object.keys(snapshot.targetFieldOverrides[node.id] || {}).length > 0
      if ((markedForDelete || hasItemOverride || hasQtyOverride || hasFieldOverride) && !node.bomEdgeId) {
        return true
      }
    }

    return false
  }

  async function ensureCommitMetadataHydrated(): Promise<void> {
    if (!targetCommitMetadataNeedsHydration()) return
    await hydrateTargetBomMetadata()
  }

  function closeModalAndRefreshIfCommitted(): void {
    const shouldRefresh = refs.getHasCommittedOperations()
    closeModal()
    refs.setHasCommittedOperations(false)
    if (shouldRefresh) dom.refreshBomTabAfterCommit()
  }

  function recomputeAutoTopLevelNumberOverrides(nextSelectedNodeIds: string[]): Record<string, string> {
    return buildAutoOverridesForSelection(state.getSnapshot(), nextSelectedNodeIds)
  }

  function updateSelectedNodes(nextSelectedNodeIds: string[]): void {
    const snapshot = state.getSnapshot()
    state.setSelectedNodesToClone(nextSelectedNodeIds)
    if (snapshot.cloneLaunchMode === 'manufacturing') {
      const selectedSet = new Set(nextSelectedNodeIds)
      const prunedAssignments = Object.fromEntries(
        Object.entries(snapshot.manufacturingOperationBySourceNodeId)
          .filter(([nodeId]) => selectedSet.has(nodeId))
      )
      state.setManufacturingOperationAssignments(prunedAssignments)
      state.setTargetItemNumberOverrides(
        buildManufacturingItemNumberOverrides(
          state.getSnapshot(),
          nextSelectedNodeIds,
          prunedAssignments
        )
      )
      return
    }
    state.setTargetItemNumberOverrides(recomputeAutoTopLevelNumberOverrides(nextSelectedNodeIds))
  }

  const itemSelectorSession = createItemSelectorSession({
    service: itemSelectorService,
    state,
    getContext: () => {
      const activeContext = refs.getContext()
      return activeContext ? { ...activeContext } : null
    },
    nextGroupId,
    nextFilterId,
    render,
    onSearchFailure: (error) => emitDiagnostic('SEARCH_API_FAILURE', String(error)),
    onFieldLoadFailure: (error) => emitDiagnostic('WORKSPACE_FIELD_LOAD_FAILURE', String(error)),
    onEnabled: () => setHealthState('enabled')
  })

  let structureFlow: StructureFlow | null = null
  let editFlow: EditFlow | null = null

  async function ensureInteractiveFlowsLoaded(): Promise<void> {
    if (structureFlow && editFlow) return
    if (interactiveFlowsLoadPromise) return interactiveFlowsLoadPromise

    interactiveFlowsLoadPromise = (async () => {
      const [structureFlowModule, editFlowModule] = await Promise.all([
        import('./controller/structureFlow'),
        import('./controller/editFlow')
      ])

      if (!structureFlow) {
        structureFlow = structureFlowModule.createCloneStructureFlow({
          state,
          service,
          refs,
          view,
          render,
          emitDiagnostic,
          updateSelectedNodes,
          ensureOperationFormMetadataLoaded,
          ensureNodeMetadataHydratedForEditing
        })
      }

      if (!editFlow) {
        editFlow = editFlowModule.createCloneEditFlow({
          state,
          service,
          refs,
          render,
          emitDiagnostic,
          updateSelectedNodes,
          clearLinkableSearchDebounceTimer,
          ensureOperationFormMetadataLoaded,
          ensureNodeMetadataHydratedForEditing
        })
      }
    })().finally(() => {
      interactiveFlowsLoadPromise = null
    })

    return interactiveFlowsLoadPromise
  }

  const searchFlow = createCloneSearchFlow({
    state,
    dom,
    service,
    runtime,
    itemSelectorSession,
    refs,
    render,
    emitDiagnostic,
    setHealthState,
    ensureInteractiveFlowsLoaded,
    onStructureOpened: () => {
      if (state.getSnapshot().cloneLaunchMode === 'manufacturing') {
        structureFlow?.expandAllOnOpen()
      }
    }
  })

  const commitFlow = createCloneCommitFlow({
    state,
    service,
    view,
    refs,
    render,
    emitDiagnostic,
    ensureCommitMetadataHydrated,
    closeModalAndRefreshIfCommitted,
    reloadStructureAfterCommit: async () => {
      await searchFlow.validateAndLoadStructure()
    }
  })

  function render(): void {
    const snapshot = state.getSnapshot()
    const modalRoot = snapshot.clonePhase === 'structure'
      ? refs.getStructureModalRoot()
      : (refs.getSearchModalRoot() || refs.getStructureModalRoot())
    if (!modalRoot) return
    if (snapshot.clonePhase === 'structure' && snapshot.editingNodeId) {
      dom.ensureEditPanelStyles('plm-bom-clone-edit-fields-root')
    }

    const noopStructureHandlers = {
      onToggleNode: () => {},
      onToggleSourceNodeExpanded: () => {},
      onSetSourceStatusFilter: () => {},
      onToggleTargetNodeExpanded: () => {},
      onExpandAllSource: () => {},
      onCollapseAllSource: () => {},
      onExpandAllTarget: () => {},
      onCollapseAllTarget: () => {},
      onSelectManufacturingOperation: () => {},
      onSelectManufacturingRoot: () => {},
      onAddOperation: () => {},
      onToggleShowCommitErrorsOnly: () => {},
      onDropNodeToTarget: () => {},
      onDropSourceAssemblySubcomponentsToTarget: () => {},
      onSplitSourceNode: () => {},
      onAddRemainingSourceNode: () => {},
      onRemoveTargetNode: () => {},
      onSplitTargetNode: () => {},
      onEditTargetItemNumber: () => {},
      onEditTargetQuantity: () => {},
      onReorderTargetNode: () => {},
      onOpenProcessItemDetails: () => {},
      onOpenProcessBomDetails: () => {},
      onResetTarget: () => {}
    }
    const noopEditHandlers = {
      onEditNode: () => {},
      onCloseEditPanel: () => {},
      onSaveEditPanel: () => {},
      onToggleEditPanelRequiredOnly: () => {},
      onOpenLinkableDialog: () => {},
      onCloseLinkableDialog: () => {},
      onLinkableSearchInput: () => {},
      onToggleLinkableItem: () => {},
      onToggleLinkableDisplayOnlySelected: () => {},
      onToggleLinkableShowOnlyErrors: () => {},
      onLinkableDialogScrollNearEnd: () => {},
      onClearLinkableSelection: () => {},
      onResizeLinkableColumn: () => {},
      onAddSelectedLinkableItems: () => {}
    }
    const handlers = {
      ...searchFlow.buildSearchHandlers(),
      ...(structureFlow?.buildStructureHandlers() || noopStructureHandlers),
      ...(editFlow?.buildEditPanelHandlers() || noopEditHandlers),
      ...(editFlow?.buildLinkableHandlers() || noopEditHandlers),
      ...commitFlow.buildLifecycleHandlers(modalRoot),
      onToggleDeepDuplicate(enabled: boolean) {
        state.setDeepDuplicateEnabled(enabled)
        render()
      },
      onProjectIdChange(value: string) {
        state.setProjectId(value)
        render()
      }
    }

    view.render(modalRoot, state.getSnapshot(), handlers)
  }

  function syncDom(): void {
    const isBom = dom.isBomTab(window.location.href)
    if (!isBom) {
      dom.removeCloneButton()
      closeModal()
      permissionContextKey = null
      clearPermissionState()
      emitDiagnostic('BOM_TAB_NOT_DETECTED', 'Inactive route')
      setHealthState('disabled')
      return
    }

    const resolvedContext = dom.resolveContext(window.location.href)
    refs.setContext(resolvedContext)
    if (!resolvedContext) {
      emitDiagnostic('BOM_TAB_NOT_DETECTED', 'Context parse failure')
      setHealthState('degraded')
      return
    }

    const nextPermissionKey = `${resolvedContext.tenant}:${resolvedContext.workspaceId}`
    if (permissionContextKey !== nextPermissionKey) {
      permissionContextKey = nextPermissionKey
      clearPermissionState()
      state.setPermissionsLoading(true)
    }

    const permissionSnapshot = state.getSnapshot()
    if (!permissionSnapshot.permissionsResolved) {
      if (!permissionLoadInFlight) {
        permissionLoadInFlight = resolveBomClonePermissions(runtime, resolvedContext.tenant, resolvedContext.workspaceId)
          .then((permissions) => {
            if (permissionContextKey === nextPermissionKey) {
              state.setPermissions(permissions)
              state.setPermissionsResolved(true)
            }
            return permissions
          })
          .catch(() => {
            const fallback = createEmptyBomClonePermissions()
            if (permissionContextKey === nextPermissionKey) {
              state.setPermissions(fallback)
              state.setPermissionsResolved(true)
            }
            return fallback
          })
          .finally(() => {
            if (permissionContextKey === nextPermissionKey) state.setPermissionsLoading(false)
            permissionLoadInFlight = null
            scheduleSync(0)
          })
      }
      dom.removeCloneButton()
      setHealthState('enabled')
      return
    }

    if (!permissionSnapshot.permissions.canAdd) {
      dom.removeCloneButton()
      closeModal()
      setHealthState('enabled')
      return
    }

    const button = dom.ensureCloneButton((mode) => {
      void (async () => {
        state.setPermissionsLoading(true)
        const permissions = await refreshPermissionsForCurrentContext(true)
        if (!permissions.canAdd) {
          dom.removeCloneButton()
          closeModal()
          setHealthState('enabled')
          return
        }
        void searchFlow.openCloneModal(mode)
      })()
    }, {
      disabled: false,
      title: 'Quick Create'
    })
    if (!button) {
      setHealthState('degraded')
      return
    }

    setHealthState('enabled')
  }

  function scheduleSync(delayMs = 0): void {
    if (refreshTimer !== null) return
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null
      syncDom()
    }, Math.max(0, delayMs))
  }

  function stopObserver(): void {
    if (!stopDomObservation) return
    stopDomObservation()
    stopDomObservation = null
  }

  function onUrlMaybeChanged(): void {
    const currentUrl = window.location.href
    if (currentUrl === lastUrl) return
    lastUrl = currentUrl
    scheduleSync(0)
  }

  function ensureObserver(): void {
    if (stopDomObservation) return
    stopDomObservation = dom.observeCloneButtonPresence((delayMs) => scheduleSync(delayMs))
  }

  return {
    mount() {
      health.register(window.location.href)
      if (!mounted) {
        mounted = true
        lastUrl = window.location.href
        window.addEventListener(navEventName, onUrlMaybeChanged)
        window.addEventListener('hashchange', onUrlMaybeChanged)
        window.addEventListener('popstate', onUrlMaybeChanged)
      }

      ensureObserver()
      syncDom()

      if (keepAliveTimer === null) {
        keepAliveTimer = window.setInterval(() => {
          if (!dom.isBomTab(window.location.href)) return
          if (!dom.isCloneButtonPresent()) scheduleSync(0)
        }, 300)
      }
    },
    update() {
      scheduleSync(0)
    },
    async launchClone(mode) {
      const resolvedContext = dom.resolveContext(window.location.href)
      refs.setContext(resolvedContext)
      if (!resolvedContext) return

      state.setPermissionsLoading(true)
      const permissions = await refreshPermissionsForCurrentContext(true)
      if (!permissions.canAdd) {
        dom.removeCloneButton()
        closeModal()
        setHealthState('enabled')
        return
      }

      await searchFlow.openCloneModal(mode)
    },
    unmount() {
      if (mounted) {
        mounted = false
        window.removeEventListener(navEventName, onUrlMaybeChanged)
        window.removeEventListener('hashchange', onUrlMaybeChanged)
        window.removeEventListener('popstate', onUrlMaybeChanged)
      }
      clearRefreshTimer()
      clearKeepAliveTimer()
      clearLinkableSearchDebounceTimer()
      stopObserver()
      dom.removeCloneButton()
      closeModal()
      permissionContextKey = null
      clearPermissionState()
      refs.setContext(null)
      refs.setHasCommittedOperations(false)
      setHealthState('disabled')
    }
  }
}


