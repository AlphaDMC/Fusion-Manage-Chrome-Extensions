import type {
  BomCloneAttachment,
  BomCloneCommitError,
  BomCloneItemDetailSection,
  BomCloneNode,
  BomCloneLinkableItem,
  BomCloneSearchField,
  BomCloneSearchFilterGroup,
  BomCloneSearchResult,
  BomCloneStateSnapshot,
  CloneLaunchMode,
  ClonePhase,
  FormFieldDefinition
} from './clone.types'
import { createEmptyBomClonePermissions, type BomClonePermissions } from './clone.permissions'

/**
 * Local state container for BOM Clone modal flow.
 * Stores both shared selector state (search/details) and BOM structure phase state.
 */
type CloneState = {
  getSnapshot: () => BomCloneStateSnapshot
  reset: () => void
  setPermissions: (value: BomClonePermissions) => void
  setPermissionsLoading: (value: boolean) => void
  setPermissionsResolved: (value: boolean) => void
  setAdvancedMode: (value: boolean) => void
  setSearchQuery: (value: string) => void
  setFieldSearchTerm: (value: string) => void
  setGroupLogicExpression: (value: string) => void
  setAvailableSearchFields: (fields: BomCloneSearchField[]) => void
  setAppliedSearchFilterGroups: (groups: BomCloneSearchFilterGroup[]) => void
  setSearchQueryPreview: (preview: string) => void
  setSearchResults: (items: BomCloneSearchResult[], totalResults: number) => void
  appendSearchResults: (items: BomCloneSearchResult[], totalResults: number) => void
  setDetailsItem: (itemId: number | null, itemLabel: string) => void
  setDetailsSections: (sections: BomCloneItemDetailSection[]) => void
  setDetailsLoading: (loading: boolean) => void
  setDetailsError: (message: string | null) => void
  setAttachments: (attachments: BomCloneAttachment[]) => void
  setAttachmentsLoading: (loading: boolean) => void
  setAttachmentsError: (message: string | null) => void
  setPagination: (offset: number, limit: number) => void
  setSelectedSourceItemId: (itemId: number | null) => void
  setSelectedNodesToClone: (nodeIds: string[]) => void
  setPendingAddNodeIds: (nodeIds: string[]) => void
  setExpandingNodeIds: (nodeIds: string[]) => void
  setSourceExpandAllLoading: (loading: boolean) => void
  setTargetExpandAllLoading: (loading: boolean) => void
  setLinkableDialogOpen: (open: boolean) => void
  setLinkableSearch: (value: string) => void
  setLinkableItems: (items: BomCloneLinkableItem[], totalCount: number, offset: number, limit: number) => void
  appendLinkableItems: (items: BomCloneLinkableItem[], totalCount: number, offset: number, limit: number) => void
  setLinkableLoading: (loading: boolean) => void
  setLinkableSelectedItemIds: (itemIds: number[]) => void
  setLinkableDisplayOnlySelected: (enabled: boolean) => void
  setLinkableError: (message: string | null) => void
  setLinkableItemErrors: (errors: Record<string, string>) => void
  setLinkableShowOnlyErrors: (enabled: boolean) => void
  setLinkableAdding: (loading: boolean) => void
  setLinkableAddProgress: (current: number, total: number) => void
  setLinkableOnTargetBomItemIds: (ids: number[]) => void
  setTargetBomPreExistingItemIds: (ids: number[]) => void
  setLinkableColumnWidth: (column: 'item' | 'workspace' | 'lifecycle', width: number) => void
  setTargetItemNumberOverride: (nodeId: string, value: string | null) => void
  setTargetItemNumberOverrides: (overrides: Record<string, string>) => void
  setTargetQuantityOverride: (nodeId: string, value: string | null) => void
  setTargetQuantityOverrides: (overrides: Record<string, string>) => void
  setTargetMarkedForDeleteNodeIds: (nodeIds: string[]) => void
  setCommitInProgress: (loading: boolean) => void
  setCommitProgress: (current: number, total: number) => void
  setCommitErrors: (errors: BomCloneCommitError[]) => void
  setCommitErrorsModalOpen: (open: boolean) => void
  setShowCommitErrorsOnly: (value: boolean) => void
  setSourceExpandedNodeIds: (nodeIds: string[]) => void
  setTargetExpandedNodeIds: (nodeIds: string[]) => void
  setSourceBomTree: (nodes: BomCloneNode[]) => void
  setTargetBomTree: (nodes: BomCloneNode[]) => void
  setClonePhase: (phase: ClonePhase) => void
  setCloneLaunchMode: (mode: CloneLaunchMode) => void
  setManufacturingSelectedOperationNodeId: (nodeId: string | null) => void
  setManufacturingSourceOperation: (sourceNodeId: string, operationNodeId: string | null) => void
  setManufacturingOperationAssignments: (assignments: Record<string, string>) => void
  setErrorMessage: (message: string | null) => void
  setLoading: (loading: boolean) => void
  setBomViewDefId: (id: number | null) => void
  setBomViewFields: (
    fields: FormFieldDefinition[],
    metaLinks: Record<string, string>,
    viewDefFieldIdToFieldId?: Record<string, string>,
    viewDefIds?: number[]
  ) => void
  setBomViewFieldsLoading: (loading: boolean) => void
  setOperationFormFields: (
    fields: FormFieldDefinition[],
    sections: BomCloneStateSnapshot['operationFormSections'],
    metaLinks: Record<string, string>
  ) => void
  setOperationFormFieldsLoading: (loading: boolean) => void
  setOperationFormFieldsError: (message: string | null) => void
  setValidationStatus: (lines: string[]) => void
  setEditingNodeId: (id: string | null) => void
  setEditingPanelMode: (mode: BomCloneStateSnapshot['editingPanelMode']) => void
  setEditPanelRequiredOnly: (value: boolean) => void
  setSourceStatusFilter: (value: BomCloneStateSnapshot['sourceStatusFilter']) => void
  setTargetFieldOverride: (nodeId: string, values: Record<string, string>) => void
  setTargetFieldOverrides: (overrides: Record<string, Record<string, string>>) => void
  setDeepDuplicateEnabled: (enabled: boolean) => void
  setProjectId: (value: string) => void
  setInitialTargetState: (
    targetBomTree: BomCloneNode[],
    expandedNodeIds: string[],
    targetBomPreExistingItemIds: number[],
    linkableOnTargetBomItemIds: number[],
    manufacturingSelectedOperationNodeId: string | null
  ) => void
}

const DEFAULT_LIMIT = 25

function readSavedProjectId(): string {
  try {
    return window.localStorage.getItem('plmExtension.deepDuplicate.projectId') ?? ''
  } catch {
    return ''
  }
}

function cloneBomNode(node: BomCloneNode): BomCloneNode {
  const clone: BomCloneNode = {
    ...node,
    children: node.children.map(cloneBomNode)
  }
  if (node.bomFieldValues) clone.bomFieldValues = { ...node.bomFieldValues }
  return clone
}

function cloneBomTree(nodes: BomCloneNode[]): BomCloneNode[] {
  return nodes.map(cloneBomNode)
}

function createDefaultSnapshot(): BomCloneStateSnapshot {
  return {
    permissions: createEmptyBomClonePermissions(),
    permissionsLoading: false,
    permissionsResolved: false,
    cloneLaunchMode: 'engineering',
    manufacturingSelectedOperationNodeId: null,
    manufacturingOperationBySourceNodeId: {},
    advancedMode: false,
    searchQuery: '',
    fieldSearchTerm: '',
    groupLogicExpression: '',
    availableSearchFields: [],
    appliedSearchFilterGroups: [],
    searchQueryPreview: '',
    searchResults: [],
    detailsItemId: null,
    detailsItemLabel: '',
    detailsSections: [],
    detailsLoading: false,
    detailsError: null,
    attachments: [],
    attachmentsLoading: false,
    attachmentsError: null,
    selectedSourceItemId: null,
    selectedNodesToClone: [],
    pendingAddNodeIds: [],
    expandingNodeIds: [],
    sourceExpandAllLoading: false,
    targetExpandAllLoading: false,
    linkableDialogOpen: false,
    linkableSearch: '',
    linkableItems: [],
    linkableOffset: 0,
    linkableLimit: 100,
    linkableTotal: 0,
    linkableLoading: false,
    linkableSelectedItemIds: [],
    linkableDisplayOnlySelected: false,
    linkableError: null,
    linkableItemErrors: {},
    linkableShowOnlyErrors: false,
    linkableAdding: false,
    linkableAddProgressCurrent: 0,
    linkableAddProgressTotal: 0,
    linkableOnTargetBomItemIds: [],
    targetBomPreExistingItemIds: [],
    linkableColumnWidths: {
      item: 460,
      workspace: 160,
      lifecycle: 140
    },
    targetItemNumberOverrides: {},
    targetQuantityOverrides: {},
    targetMarkedForDeleteNodeIds: [],
    commitInProgress: false,
    commitProgressCurrent: 0,
    commitProgressTotal: 0,
    commitErrors: [],
    commitErrorsModalOpen: false,
    showCommitErrorsOnly: false,
    sourceExpandedNodeIds: [],
    targetExpandedNodeIds: [],
    sourceBomTree: [],
    targetBomTree: [],
    initialTargetBomTree: [],
    initialTargetExpandedNodeIds: [],
    initialTargetBomPreExistingItemIds: [],
    initialLinkableOnTargetBomItemIds: [],
    initialManufacturingSelectedOperationNodeId: null,
    clonePhase: 'search',
    offset: 0,
    limit: DEFAULT_LIMIT,
    totalResults: 0,
    errorMessage: null,
    loading: false,
    bomViewDefId: null,
    bomViewDefIds: [],
    bomViewFields: [],
    bomViewFieldMetaLinks: {},
    bomViewFieldIdToFieldId: {},
    bomViewFieldsLoading: false,
    operationFormFields: [],
    operationFormSections: [],
    operationFormFieldMetaLinks: {},
    operationFormFieldsLoading: false,
    operationFormFieldsError: null,
    validationStatusLines: [],
    editingNodeId: null,
    editingPanelMode: 'item',
    editPanelRequiredOnly: false,
    sourceStatusFilter: 'all',
    targetFieldOverrides: {},
    deepDuplicateEnabled: false,
    projectId: readSavedProjectId()
  }
}

export function createCloneState(): CloneState {
  let snapshot = createDefaultSnapshot()

  function merge(next: Partial<BomCloneStateSnapshot>): void {
    snapshot = { ...snapshot, ...next }
  }

  return {
    getSnapshot() {
      return snapshot
    },
    reset() {
      snapshot = createDefaultSnapshot()
    },
    setPermissions(value) {
      merge({ permissions: { ...value } })
    },
    setPermissionsLoading(value) {
      merge({ permissionsLoading: value })
    },
    setPermissionsResolved(value) {
      merge({ permissionsResolved: value })
    },
    setAdvancedMode(value) {
      merge({ advancedMode: value, offset: 0 })
    },
    setSearchQuery(value) {
      merge({ searchQuery: value, offset: 0 })
    },
    setFieldSearchTerm(value) {
      merge({ fieldSearchTerm: value })
    },
    setGroupLogicExpression(value) {
      merge({ groupLogicExpression: value, offset: 0 })
    },
    setAvailableSearchFields(fields) {
      merge({ availableSearchFields: [...fields] })
    },
    setAppliedSearchFilterGroups(groups) {
      merge({ appliedSearchFilterGroups: [...groups], offset: 0 })
    },
    setSearchQueryPreview(preview) {
      merge({ searchQueryPreview: preview })
    },
    setSearchResults(items, totalResults) {
      merge({ searchResults: items, totalResults, errorMessage: null })
    },
    appendSearchResults(items, totalResults) {
      merge({ searchResults: [...snapshot.searchResults, ...items], totalResults, errorMessage: null })
    },
    setDetailsItem(itemId, itemLabel) {
      merge({ detailsItemId: itemId, detailsItemLabel: itemLabel })
    },
    setDetailsSections(sections) {
      merge({ detailsSections: [...sections] })
    },
    setDetailsLoading(loading) {
      merge({ detailsLoading: loading })
    },
    setDetailsError(message) {
      merge({ detailsError: message })
    },
    setAttachments(attachments) {
      merge({ attachments: [...attachments] })
    },
    setAttachmentsLoading(loading) {
      merge({ attachmentsLoading: loading })
    },
    setAttachmentsError(message) {
      merge({ attachmentsError: message })
    },
    setPagination(offset, limit) {
      merge({ offset, limit })
    },
    setSelectedSourceItemId(itemId) {
      merge({ selectedSourceItemId: itemId })
    },
    setSelectedNodesToClone(nodeIds) {
      merge({ selectedNodesToClone: [...nodeIds] })
    },
    setPendingAddNodeIds(nodeIds) {
      merge({ pendingAddNodeIds: [...nodeIds] })
    },
    setExpandingNodeIds(nodeIds) {
      merge({ expandingNodeIds: [...nodeIds] })
    },
    setSourceExpandAllLoading(loading) {
      merge({ sourceExpandAllLoading: loading })
    },
    setTargetExpandAllLoading(loading) {
      merge({ targetExpandAllLoading: loading })
    },
    setLinkableDialogOpen(open) {
      merge({ linkableDialogOpen: open })
    },
    setLinkableSearch(value) {
      merge({ linkableSearch: value })
    },
    setLinkableItems(items, totalCount, offset, limit) {
      merge({
        linkableItems: [...items],
        linkableTotal: totalCount,
        linkableOffset: offset,
        linkableLimit: limit
      })
    },
    appendLinkableItems(items, totalCount, offset, limit) {
      const byId = new Map<number, BomCloneLinkableItem>()
      for (const existing of snapshot.linkableItems) byId.set(existing.id, existing)
      for (const entry of items) byId.set(entry.id, entry)
      merge({
        linkableItems: Array.from(byId.values()),
        linkableTotal: totalCount,
        linkableOffset: offset,
        linkableLimit: limit
      })
    },
    setLinkableLoading(loading) {
      merge({ linkableLoading: loading })
    },
    setLinkableSelectedItemIds(itemIds) {
      merge({ linkableSelectedItemIds: [...itemIds] })
    },
    setLinkableDisplayOnlySelected(enabled) {
      merge({ linkableDisplayOnlySelected: enabled })
    },
    setLinkableError(message) {
      merge({ linkableError: message })
    },
    setLinkableItemErrors(errors) {
      merge({
        linkableItemErrors: { ...errors },
        linkableShowOnlyErrors: Object.keys(errors).length > 0 ? snapshot.linkableShowOnlyErrors : false
      })
    },
    setLinkableShowOnlyErrors(enabled) {
      merge({ linkableShowOnlyErrors: enabled && Object.keys(snapshot.linkableItemErrors).length > 0 })
    },
    setLinkableAdding(loading) {
      merge({ linkableAdding: loading })
    },
    setLinkableAddProgress(current, total) {
      merge({ linkableAddProgressCurrent: current, linkableAddProgressTotal: total })
    },
    setLinkableOnTargetBomItemIds(ids) {
      merge({ linkableOnTargetBomItemIds: [...ids] })
    },
    setTargetBomPreExistingItemIds(ids) {
      merge({ targetBomPreExistingItemIds: [...ids] })
    },
    setLinkableColumnWidth(column, width) {
      const clamped = Math.max(120, Math.min(900, Math.round(width)))
      merge({
        linkableColumnWidths: {
          ...snapshot.linkableColumnWidths,
          [column]: clamped
        }
      })
    },
    setTargetItemNumberOverride(nodeId, value) {
      const next = { ...snapshot.targetItemNumberOverrides }
      if (!value) delete next[nodeId]
      else next[nodeId] = value
      merge({ targetItemNumberOverrides: next })
    },
    setTargetItemNumberOverrides(overrides) {
      merge({ targetItemNumberOverrides: { ...overrides } })
    },
    setTargetQuantityOverride(nodeId, value) {
      const next = { ...snapshot.targetQuantityOverrides }
      if (!value) delete next[nodeId]
      else next[nodeId] = value
      merge({ targetQuantityOverrides: next })
    },
    setTargetQuantityOverrides(overrides) {
      merge({ targetQuantityOverrides: { ...overrides } })
    },
    setTargetMarkedForDeleteNodeIds(nodeIds) {
      merge({ targetMarkedForDeleteNodeIds: [...nodeIds] })
    },
    setCommitInProgress(loading) {
      merge({ commitInProgress: loading })
    },
    setCommitProgress(current, total) {
      merge({ commitProgressCurrent: current, commitProgressTotal: total })
    },
    setCommitErrors(errors) {
      merge({
        commitErrors: [...errors],
        commitErrorsModalOpen: errors.length > 0,
        showCommitErrorsOnly: errors.length > 0 ? snapshot.showCommitErrorsOnly : false
      })
    },
    setCommitErrorsModalOpen(open) {
      merge({ commitErrorsModalOpen: open && snapshot.commitErrors.length > 0 })
    },
    setShowCommitErrorsOnly(value) {
      merge({ showCommitErrorsOnly: value && snapshot.commitErrors.length > 0 })
    },
    setSourceExpandedNodeIds(nodeIds) {
      merge({ sourceExpandedNodeIds: [...nodeIds] })
    },
    setTargetExpandedNodeIds(nodeIds) {
      merge({ targetExpandedNodeIds: [...nodeIds] })
    },
    setSourceBomTree(nodes) {
      merge({ sourceBomTree: nodes })
    },
    setTargetBomTree(nodes) {
      merge({ targetBomTree: nodes })
    },
    setClonePhase(phase) {
      merge({ clonePhase: phase })
    },
    setCloneLaunchMode(mode) {
      merge({ cloneLaunchMode: mode })
    },
    setManufacturingSelectedOperationNodeId(nodeId) {
      merge({ manufacturingSelectedOperationNodeId: nodeId })
    },
    setManufacturingSourceOperation(sourceNodeId, operationNodeId) {
      const next = { ...snapshot.manufacturingOperationBySourceNodeId }
      if (!operationNodeId) delete next[sourceNodeId]
      else next[sourceNodeId] = operationNodeId
      merge({ manufacturingOperationBySourceNodeId: next })
    },
    setManufacturingOperationAssignments(assignments) {
      merge({ manufacturingOperationBySourceNodeId: { ...assignments } })
    },
    setErrorMessage(message) {
      merge({ errorMessage: message })
    },
    setLoading(loading) {
      merge({ loading })
    },
    setBomViewDefId(id) {
      merge({ bomViewDefId: id })
    },
    setBomViewFields(fields, metaLinks, viewDefFieldIdToFieldId = {}, viewDefIds = []) {
      merge({
        bomViewFields: [...fields],
        bomViewFieldMetaLinks: { ...metaLinks },
        bomViewFieldIdToFieldId: { ...viewDefFieldIdToFieldId },
        bomViewDefIds: [...viewDefIds],
        bomViewFieldsLoading: false
      })
    },
    setBomViewFieldsLoading(loading) {
      merge({ bomViewFieldsLoading: loading })
    },
    setOperationFormFields(fields, sections, metaLinks) {
      merge({
        operationFormFields: [...fields],
        operationFormSections: sections.map((section) => ({
          title: section.title,
          expandedByDefault: section.expandedByDefault,
          fieldIds: [...section.fieldIds]
        })),
        operationFormFieldMetaLinks: { ...metaLinks },
        operationFormFieldsLoading: false,
        operationFormFieldsError: null
      })
    },
    setOperationFormFieldsLoading(loading) {
      merge({ operationFormFieldsLoading: loading })
    },
    setOperationFormFieldsError(message) {
      merge({ operationFormFieldsError: message })
    },
    setValidationStatus(lines) {
      merge({
        validationStatusLines: [...lines]
      })
    },
    setEditingNodeId(id) {
      merge({
        editingNodeId: id,
        editingPanelMode: id ? snapshot.editingPanelMode : 'item'
      })
    },
    setEditingPanelMode(mode) {
      merge({ editingPanelMode: mode })
    },
    setEditPanelRequiredOnly(value) {
      merge({ editPanelRequiredOnly: value })
    },
    setSourceStatusFilter(value) {
      merge({ sourceStatusFilter: value })
    },
    setTargetFieldOverride(nodeId, values) {
      const next = { ...snapshot.targetFieldOverrides }
      if (Object.keys(values).length === 0) {
        delete next[nodeId]
      } else {
        next[nodeId] = { ...values }
      }
      merge({ targetFieldOverrides: next })
    },
    setTargetFieldOverrides(overrides) {
      const next: Record<string, Record<string, string>> = {}
      for (const [nodeId, values] of Object.entries(overrides)) {
        if (Object.keys(values).length === 0) continue
        next[nodeId] = { ...values }
      }
      merge({ targetFieldOverrides: next })
    },
    setDeepDuplicateEnabled(enabled) {
      merge({ deepDuplicateEnabled: enabled })
    },
    setProjectId(value) {
      merge({ projectId: value })
      try {
        window.localStorage.setItem('plmExtension.deepDuplicate.projectId', value)
      } catch {
        // Non-critical; ignore storage errors.
      }
    },
    setInitialTargetState(
      targetBomTree,
      expandedNodeIds,
      targetBomPreExistingItemIds,
      linkableOnTargetBomItemIds,
      manufacturingSelectedOperationNodeId
    ) {
      merge({
        initialTargetBomTree: cloneBomTree(targetBomTree),
        initialTargetExpandedNodeIds: [...expandedNodeIds],
        initialTargetBomPreExistingItemIds: [...targetBomPreExistingItemIds],
        initialLinkableOnTargetBomItemIds: [...linkableOnTargetBomItemIds],
        initialManufacturingSelectedOperationNodeId: manufacturingSelectedOperationNodeId || null
      })
    }
  }
}


