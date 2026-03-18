import type {
  ItemSelectorAttachment,
  ItemSelectorDetailRow,
  ItemSelectorDetailSection,
  ItemSelectorSearchField,
  ItemSelectorSearchFilter,
  ItemSelectorSearchFilterGroup,
  ItemSelectorSearchResult
} from '../../../shared/item-selector/types'
import type { BomClonePermissions } from './clone.permissions'
import type { FormFieldDefinition } from './services/form/types'

export type { FormFieldDefinition }
export const TEMP_OPERATION_NAME_FIELD_ID = '__temp_operation_name__'

/**
 * BOM Clone domain types.
 * Reuses shared search feature contracts for selector payloads and
 * adds clone-specific context/state/tree models.
 */
export type ClonePhase = 'search' | 'validation' | 'structure'
export type CloneLaunchMode = 'engineering' | 'manufacturing'
export type CloneQuickCreateAction = CloneLaunchMode | 'deep-clone'
export type CloneEditPanelMode = 'item' | 'bom'
export type SourceStatusFilter = 'all' | 'not-added' | 'modified' | 'added'

export type BomCloneStructureRow = {
  id: string
  label: string
  level: number
}

export type BomCloneContext = {
  tenant: string
  workspaceId: number
  currentItemId: number
  viewId: number
  viewDefId: number | null
}

export type BomCloneSearchResult = ItemSelectorSearchResult

export type BomCloneItemDetailRow = ItemSelectorDetailRow

export type BomCloneItemDetailSection = ItemSelectorDetailSection

export type BomCloneAttachment = ItemSelectorAttachment

export type BomCloneSearchField = ItemSelectorSearchField

export type BomCloneSearchFilter = ItemSelectorSearchFilter

export type BomCloneSearchFilterGroup = ItemSelectorSearchFilterGroup

export type BomCloneLinkableItem = {
  id: number
  label: string
  workspace: string
  lifecycle: string
}

export type BomCloneCommitError = {
  nodeId: string
  descriptor: string
  message: string
}

export type BomCloneFormSection = {
  title: string
  expandedByDefault: boolean
  fieldIds: string[]
}

export type BomCloneNode = {
  id: string
  bomEdgeId?: string
  bomEdgeLink?: string
  bomFieldValues?: Record<string, string>
  isPinned?: boolean
  itemLink?: string
  label: string
  number: string
  itemNumber: string
  iconHtml: string
  revision: string
  status: string
  quantity: string
  unitOfMeasure: string
  fromLinkableDialog?: boolean
  stagedOperationDraft?: boolean
  stagedSplitDraft?: boolean
  splitSourceNodeId?: string
  hasExpandableChildren: boolean
  childrenLoaded: boolean
  children: BomCloneNode[]
}

export type BomCloneStateSnapshot = {
  permissions: BomClonePermissions
  permissionsLoading: boolean
  permissionsResolved: boolean
  cloneLaunchMode: CloneLaunchMode
  manufacturingSelectedOperationNodeId: string | null
  manufacturingOperationBySourceNodeId: Record<string, string>
  advancedMode: boolean
  searchQuery: string
  fieldSearchTerm: string
  groupLogicExpression: string
  availableSearchFields: BomCloneSearchField[]
  appliedSearchFilterGroups: BomCloneSearchFilterGroup[]
  searchQueryPreview: string
  searchResults: BomCloneSearchResult[]
  detailsItemId: number | null
  detailsItemLabel: string
  detailsSections: BomCloneItemDetailSection[]
  detailsLoading: boolean
  detailsError: string | null
  attachments: BomCloneAttachment[]
  attachmentsLoading: boolean
  attachmentsError: string | null
  selectedSourceItemId: number | null
  selectedNodesToClone: string[]
  pendingAddNodeIds: string[]
  expandingNodeIds: string[]
  sourceExpandAllLoading: boolean
  targetExpandAllLoading: boolean
  linkableDialogOpen: boolean
  linkableSearch: string
  linkableItems: BomCloneLinkableItem[]
  linkableOffset: number
  linkableLimit: number
  linkableTotal: number
  linkableLoading: boolean
  linkableSelectedItemIds: number[]
  linkableDisplayOnlySelected: boolean
  linkableError: string | null
  linkableItemErrors: Record<string, string>
  linkableShowOnlyErrors: boolean
  linkableAdding: boolean
  linkableAddProgressCurrent: number
  linkableAddProgressTotal: number
  linkableOnTargetBomItemIds: number[]
  targetBomPreExistingItemIds: number[]
  linkableColumnWidths: {
    item: number
    workspace: number
    lifecycle: number
  }
  targetItemNumberOverrides: Record<string, string>
  targetQuantityOverrides: Record<string, string>
  targetMarkedForDeleteNodeIds: string[]
  commitInProgress: boolean
  commitProgressCurrent: number
  commitProgressTotal: number
  commitErrors: BomCloneCommitError[]
  commitErrorsModalOpen: boolean
  showCommitErrorsOnly: boolean
  sourceExpandedNodeIds: string[]
  targetExpandedNodeIds: string[]
  sourceBomTree: BomCloneNode[]
  targetBomTree: BomCloneNode[]
  initialTargetBomTree: BomCloneNode[]
  initialTargetExpandedNodeIds: string[]
  initialTargetBomPreExistingItemIds: number[]
  initialLinkableOnTargetBomItemIds: number[]
  initialManufacturingSelectedOperationNodeId: string | null
  clonePhase: ClonePhase
  offset: number
  limit: number
  totalResults: number
  errorMessage: string | null
  loading: boolean
  bomViewDefId: number | null
  bomViewDefIds: number[]
  bomViewFields: FormFieldDefinition[]
  bomViewFieldMetaLinks: Record<string, string>
  bomViewFieldIdToFieldId: Record<string, string>
  bomViewFieldsLoading: boolean
  operationFormFields: FormFieldDefinition[]
  operationFormSections: BomCloneFormSection[]
  operationFormFieldMetaLinks: Record<string, string>
  operationFormFieldsLoading: boolean
  operationFormFieldsError: string | null
  validationStatusLines: string[]
  editingNodeId: string | null
  editingPanelMode: CloneEditPanelMode
  editPanelRequiredOnly: boolean
  sourceStatusFilter: SourceStatusFilter
  targetFieldOverrides: Record<string, Record<string, string>>
  deepDuplicateEnabled: boolean
  projectId: string
}

export type BomCloneCapabilityState = 'initializing' | 'enabled' | 'degraded' | 'disabled'

export type BomCloneDiagnosticCode =
  | 'BOM_TAB_NOT_DETECTED'
  | 'WORKSPACE_FIELD_LOAD_FAILURE'
  | 'SEARCH_API_FAILURE'
  | 'VALIDATION_FAILURE'
  | 'BOM_STRUCTURE_PARSING_FAILURE'

