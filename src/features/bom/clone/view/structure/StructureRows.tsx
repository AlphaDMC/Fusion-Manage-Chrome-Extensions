import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { BomCloneStateSnapshot } from '../../clone.types'
import type { CloneStructureViewModel, SourceRowDiscrepancy, SourceRowStatus } from '../../services/viewModel.service'
import { buildRowRequiredValidationSummary } from '../../services/viewModel.service'
import { findNode, resolveNodeItemId, type BomCloneStructureRow } from '../../services/structure/tree.service'
import { resolveManufacturingProcessNodeIds } from '../../services/structure/structure.service'
import {
  applyRequiredIndicator,
  getDisplayItemNumber,
  getDraggedNodeId,
  MANUFACTURING_NUMBER_LAYOUT,
  type CloneStructureHandlers
} from './structure.rows.view'
import { resolveStructureModeView } from './structure.mode.view'

const ACTIVE_DRAG_NODE_ATTR = 'data-plm-bom-clone-drag-node-id'
const ACTIVE_DRAG_KIND_ATTR = 'data-plm-bom-clone-drag-kind'
const DRAG_KIND_MIME = 'application/x-plm-bom-clone-drag-kind'

type DragKind = 'source' | 'target'

type DropPlacement = 'before' | 'after' | 'inside'

type DropState = {
  rowId: string
  placement: DropPlacement
}

type RowSharedContext = {
  snapshot: BomCloneStateSnapshot
  structureContext: CloneStructureViewModel
  handlers: CloneStructureHandlers
  isSource: boolean
  rows: BomCloneStructureRow[]
  sourceTopLevelNodeIds: Set<string>
  targetPreExistingItemIds: Set<number>
  targetRowIds: Set<string>
  rowById: Map<string, BomCloneStructureRow>
  rowParentById: Map<string, string | null>
  manufacturingProcessNodeIds: Set<string>
  failedCommitNodeIds: Set<string>
  hasEditableBomFields: boolean
  canEvaluateRequiredFields: boolean
  selectedOperationNodeId: string | null
  modeView: ReturnType<typeof resolveStructureModeView>
}

type ActionButtonSpec = {
  key: string
  tone: 'add' | 'edit' | 'remove' | 'open'
  label: string
  icon: React.ReactNode
  disabled?: boolean
  active?: boolean
  tooltip?: string
  onClick?: () => void
}

function setActiveDragNodeId(nodeId: string | null): void {
  if (!document.body) return
  if (!nodeId) {
    document.body.removeAttribute(ACTIVE_DRAG_NODE_ATTR)
    return
  }
  document.body.setAttribute(ACTIVE_DRAG_NODE_ATTR, nodeId)
}

function setActiveDragKind(kind: DragKind | null): void {
  if (!document.body) return
  if (!kind) {
    document.body.removeAttribute(ACTIVE_DRAG_KIND_ATTR)
    return
  }
  document.body.setAttribute(ACTIVE_DRAG_KIND_ATTR, kind)
}

function clearActiveDragState(): void {
  setActiveDragNodeId(null)
  setActiveDragKind(null)
}

function getDraggedKind(event: DragEvent): DragKind | null {
  const transferKind = event.dataTransfer?.getData(DRAG_KIND_MIME).trim()
  if (transferKind === 'source' || transferKind === 'target') return transferKind
  const activeKind = document.body?.getAttribute(ACTIVE_DRAG_KIND_ATTR)?.trim()
  return activeKind === 'source' || activeKind === 'target' ? activeKind : null
}

function StructureDragHandle(props: {
  label: string
  draggable?: boolean
  onDragStart?: (event: React.DragEvent<HTMLSpanElement>) => void
  onDragEnd?: () => void
}): React.JSX.Element {
  const { label, draggable = false, onDragStart, onDragEnd } = props
  return (
    <span
      className="plm-extension-bom-structure-drag-handle"
      title={label}
      aria-hidden="true"
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <span className="zmdi zmdi-unfold-more" aria-hidden="true" />
    </span>
  )
}

function autoScrollStructurePane(container: HTMLElement, clientY: number): void {
  const rect = container.getBoundingClientRect()
  const edgeThresholdPx = 48
  const maxStepPx = 28

  if (clientY <= rect.top + edgeThresholdPx) {
    const distance = Math.max(0, (rect.top + edgeThresholdPx) - clientY)
    container.scrollTop -= Math.min(maxStepPx, Math.max(10, Math.ceil(distance / 2)))
    return
  }

  if (clientY >= rect.bottom - edgeThresholdPx) {
    const distance = Math.max(0, clientY - (rect.bottom - edgeThresholdPx))
    container.scrollTop += Math.min(maxStepPx, Math.max(10, Math.ceil(distance / 2)))
  }
}

function CubeGlyph(props: { assembly?: boolean }): React.JSX.Element {
  return (
    <svg className="plm-extension-bom-structure-part-glyph" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        d={['M12 3L4 8V16L12 21L20 16V8Z', 'M4 8L12 13L20 8', 'M12 13V21'].join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={props.assembly ? 'is-assembly-badge' : undefined}
      />
    </svg>
  )
}

function ListAddGlyph(): React.JSX.Element {
  return (
    <svg className="plm-extension-bom-structure-list-add-glyph" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <rect x="2.5" y="3" width="14.5" height="17" rx="2.2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M5.8 8H13.5 M5.8 11.7H13.5 M5.8 15.4H13.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="18.5" cy="18.5" r="4.5" fill="currentColor" />
      <circle cx="18.5" cy="18.5" r="4.5" fill="none" stroke="#ffffff" strokeWidth="1.2" />
      <path d="M18.5 16.1V20.9 M16.1 18.5H20.9" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function SplitBalanceGlyph(): React.JSX.Element {
  return (
    <svg className="plm-extension-bom-structure-split-glyph" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <rect x="8.4" y="2.8" width="2.4" height="18.4" rx="1.2" fill="currentColor" />
      <rect x="13.2" y="2.8" width="2.4" height="18.4" rx="1.2" fill="currentColor" />
      <path d="M8.4 10.9H4.9L6.6 9.2L5.4 8L2.2 11.2L5.4 14.4L6.6 13.2L4.9 11.5H8.4V10.9Z" fill="currentColor" />
      <path d="M15.6 10.9H19.1L17.4 9.2L18.6 8L21.8 11.2L18.6 14.4L17.4 13.2L19.1 11.5H15.6V10.9Z" fill="currentColor" />
    </svg>
  )
}

function StructureActionButton(props: ActionButtonSpec): React.JSX.Element {
  const { tone, label, icon, disabled = false, active = false, tooltip, onClick } = props
  return (
    <button
      type="button"
      className={`plm-extension-bom-structure-action-btn plm-extension-btn plm-extension-btn--secondary is-${tone}${active ? ' is-active' : ''}`}
      title={tooltip || label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="plm-extension-bom-structure-action-icon-host" aria-hidden="true">{icon}</span>
    </button>
  )
}

function RequiredIndicator(props: {
  nodeId: string
  completion: ReturnType<typeof buildRowRequiredValidationSummary>['combined']
  tooltip: string
}): React.JSX.Element {
  const { nodeId, completion, tooltip } = props
  const ref = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    const indicator = ref.current
    if (!indicator) return
    applyRequiredIndicator(indicator, completion)
    indicator.title = tooltip
  }, [completion, tooltip])

  return <span ref={ref} className="plm-extension-bom-structure-required-indicator" data-plm-required-indicator-node-id={nodeId} />
}

function buildRowParentMap(rows: BomCloneStructureRow[]): Map<string, string | null> {
  const parentById = new Map<string, string | null>()
  const ancestors: Array<{ id: string; level: number }> = []
  for (const row of rows) {
    if (row.level < 0) {
      parentById.set(row.id, null)
      ancestors.length = 0
      continue
    }
    while (ancestors.length > 0 && ancestors[ancestors.length - 1].level >= row.level) ancestors.pop()
    parentById.set(row.id, ancestors.length > 0 ? ancestors[ancestors.length - 1].id : null)
    ancestors.push({ id: row.id, level: row.level })
  }
  return parentById
}

function canAddToBom(snapshot: Pick<BomCloneStateSnapshot, 'permissions'>): boolean {
  return snapshot.permissions.canAdd
}

function canEditTargetRow(snapshot: Pick<BomCloneStateSnapshot, 'permissions'>, isNewlyStagedTargetRow: boolean): boolean {
  return snapshot.permissions.canAdd && isNewlyStagedTargetRow
}

function canRemoveTargetRow(
  snapshot: Pick<BomCloneStateSnapshot, 'permissions'>,
  isPersistedTargetRow: boolean,
  isNewlyStagedTargetRow: boolean
): boolean {
  if (isPersistedTargetRow) return snapshot.permissions.canDelete
  return isNewlyStagedTargetRow
}

function canSplitTargetRowForPermissions(
  snapshot: Pick<BomCloneStateSnapshot, 'permissions'>,
  isPersistedTargetRow: boolean,
  isNewlyStagedTargetRow: boolean
): boolean {
  if (isPersistedTargetRow) return snapshot.permissions.canDelete
  return snapshot.permissions.canAdd && isNewlyStagedTargetRow
}

function resolveSourceStatus(
  rowId: string,
  targetTableNodeIds: Set<string>,
  hasQtyOverride: boolean,
  sourceStatusByNodeId: Record<string, SourceRowStatus>
): SourceRowStatus {
  return sourceStatusByNodeId[rowId]
    || (targetTableNodeIds.has(rowId) && hasQtyOverride ? 'modified' : targetTableNodeIds.has(rowId) ? 'added' : 'not-added')
}

function resolveTargetDiscrepancy(
  rowId: string,
  row: BomCloneStructureRow,
  sourceDiscrepancyByNodeId: Record<string, SourceRowDiscrepancy>,
  isSource: boolean
): SourceRowDiscrepancy {
  const discrepancyNodeId = !isSource ? String(row.node.splitSourceNodeId || rowId || '').trim() : rowId
  return sourceDiscrepancyByNodeId[discrepancyNodeId] || {
    severity: 'none',
    sourceQuantity: '0.0',
    allocatedQuantity: '0.0',
    remainingQuantity: '0.0',
    tooltip: null
  }
}

function hasPositiveRemainingQuantity(discrepancy: Pick<SourceRowDiscrepancy, 'remainingQuantity'>): boolean {
  const remaining = Number.parseFloat(String(discrepancy.remainingQuantity || '').trim())
  return Number.isFinite(remaining) && remaining > 0
}

function StructureNodeControl(props: {
  hasChildren: boolean
  expanded: boolean
  loading: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { hasChildren, expanded, loading, onToggle } = props
  if (!hasChildren) return <span className="plm-extension-bom-structure-chevron-spacer" aria-hidden="true" />
  return (
    <button
      type="button"
      className={`plm-extension-bom-structure-chevron${loading ? ' is-loading' : ''}`}
      disabled={loading}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
    >
      <span className={loading ? 'zmdi zmdi-refresh zmdi-hc-spin' : (expanded ? 'zmdi zmdi-chevron-down' : 'zmdi zmdi-chevron-right')} />
    </button>
  )
}

function StructureRootRow(props: {
  row: BomCloneStructureRow
  snapshot: BomCloneStateSnapshot
  isSource: boolean
  selectedOperationNodeId: string | null
  onSelectManufacturingRoot: () => void
}): React.JSX.Element {
  const { row, snapshot, isSource, selectedOperationNodeId, onSelectManufacturingRoot } = props
  const useStructuredTreeLayout = snapshot.cloneLaunchMode === 'engineering'
  return (
    <tr className="plm-extension-bom-structure-root-row">
      <td colSpan={4} className="plm-extension-bom-structure-root-merged-cell">
        <div className="plm-extension-bom-structure-root-wrap">
          <span
            className={
              ((isSource && snapshot.cloneLaunchMode === 'manufacturing') || useStructuredTreeLayout)
                ? 'plm-extension-bom-structure-root-prefix-host'
                : 'plm-extension-bom-structure-root-prefix-box'
            }
          >
            {!isSource && snapshot.cloneLaunchMode === 'manufacturing' ? (
              <input
                type="radio"
                name="plm-bom-clone-manufacturing-operation"
                className="plm-extension-bom-structure-operation-radio plm-extension-bom-structure-root-radio"
                checked={!selectedOperationNodeId}
                title="Select root to add process"
                aria-label="Select root to add process"
                onChange={(event) => {
                  if (!event.target.checked) return
                  onSelectManufacturingRoot()
                }}
              />
            ) : ((isSource && snapshot.cloneLaunchMode === 'manufacturing') || useStructuredTreeLayout) ? (
              <span className="plm-extension-bom-structure-root-icon-box">
                <span className="zmdi zmdi-layers plm-extension-bom-structure-root-assembly-icon" aria-hidden="true" />
              </span>
            ) : (
              <span className="plm-extension-bom-structure-root-prefix">
                <span className="zmdi zmdi-layers" aria-hidden="true" />
              </span>
            )}
          </span>
          <div className="plm-extension-bom-structure-descriptor-scroll" title={row.node.label}>
            {row.node.label}
          </div>
        </div>
      </td>
    </tr>
  )
}

function StructureRow(props: {
  row: BomCloneStructureRow
  index: number
  context: RowSharedContext
  dropState: DropState | null
  onSetDropState: (state: DropState | null) => void
  onMarkDropped: (rowId: string) => void
  droppedRowId: string | null
}): React.JSX.Element {
  const { row, index, context, dropState, onSetDropState, onMarkDropped, droppedRowId } = props
  const { snapshot, structureContext, handlers, isSource } = context
  const [qtyDraft, setQtyDraft] = useState<string | null>(null)

  useEffect(() => {
    setQtyDraft(null)
  }, [row.id])

  if (row.level < 0) {
    return (
      <StructureRootRow
        row={row}
        snapshot={snapshot}
        isSource={isSource}
        selectedOperationNodeId={context.selectedOperationNodeId}
        onSelectManufacturingRoot={handlers.onSelectManufacturingRoot}
      />
    )
  }

  const modeView = context.modeView
  const isManufacturingMode = snapshot.cloneLaunchMode === 'manufacturing'
  const useStructuredTreeLayout = isManufacturingMode || snapshot.cloneLaunchMode === 'engineering'
  const isSourceTopLevel = isSource && context.sourceTopLevelNodeIds.has(row.id)
  const isManufacturingSource = isSource && isManufacturingMode
  const isSourceComponent = !row.hasChildren
  const canAddFromSourceRow = (isManufacturingSource ? isSourceComponent : isSourceTopLevel) && canAddToBom(snapshot)
  const showOperationSelector = modeView.shouldRenderOperationSelector(snapshot, row, isSource)
  const isTargetTopLevel = !isSource && row.level === 0
  const isManufacturingTargetTopLevel = isManufacturingMode && isTargetTopLevel
  const isAddProcessRow = isManufacturingTargetTopLevel && context.manufacturingProcessNodeIds.has(row.id)
  const originalTargetNode = !isSource ? findNode(snapshot.targetBomTree, row.id) : null
  const targetItemId = !isSource ? resolveNodeItemId(row.node) : null
  const isPersistedTargetRow = !isSource
    && Boolean(originalTargetNode)
    && !originalTargetNode?.stagedOperationDraft
    && !originalTargetNode?.stagedSplitDraft
    && (
      structureContext.targetExistingNodeIds.has(row.id)
      || (targetItemId !== null && context.targetPreExistingItemIds.has(targetItemId))
      || Boolean(String(originalTargetNode?.bomEdgeId || '').trim())
    )
  const isNewlyStagedTargetRow = !isSource
    && !isPersistedTargetRow
    && (
      structureContext.selectedNodeIds.has(row.id)
      || Boolean(row.node.stagedOperationDraft)
      || Boolean(row.node.stagedSplitDraft)
    )

  let hasMarkedDeleteAncestor = false
  if (!isSource) {
    let ancestorId = context.rowParentById.get(row.id) || null
    while (ancestorId) {
      if (structureContext.markedForDeleteIds.has(ancestorId)) {
        hasMarkedDeleteAncestor = true
        break
      }
      ancestorId = context.rowParentById.get(ancestorId) || null
    }
  }

  const isMarkedForDelete = isPersistedTargetRow && structureContext.markedForDeleteIds.has(row.id)
  const isEffectivelyMarkedForDelete = isMarkedForDelete || hasMarkedDeleteAncestor
  const isStagedSplitDraftRow = Boolean(row.node.stagedSplitDraft)
  const currentOperationNodeId = String(snapshot.manufacturingOperationBySourceNodeId[row.id] || '').trim()
  const hasSplitDestination = snapshot.cloneLaunchMode === 'manufacturing'
    ? (currentOperationNodeId
      ? Array.from(context.manufacturingProcessNodeIds).some((operationId) => operationId !== currentOperationNodeId)
      : context.manufacturingProcessNodeIds.size > 0)
    : false
  const splitSourceNodeId = String(row.node.splitSourceNodeId || row.id || '').trim()
  const splitSourceNode = !isSource && splitSourceNodeId ? findNode(snapshot.sourceBomTree, splitSourceNodeId) : null
  const isSplitComponentCandidate = Boolean(splitSourceNode && !splitSourceNode.hasExpandableChildren && splitSourceNode.children.length === 0)
  const canSplitTargetRow = !isSource
    && snapshot.cloneLaunchMode === 'manufacturing'
    && !row.node.stagedOperationDraft
    && isSplitComponentCandidate
    && hasSplitDestination
    && (structureContext.selectedNodeIds.has(row.id) || isPersistedTargetRow || isStagedSplitDraftRow)
    && !isEffectivelyMarkedForDelete
    && canSplitTargetRowForPermissions(snapshot, isPersistedTargetRow, isNewlyStagedTargetRow)
  const canEditCurrentTargetRow = canEditTargetRow(snapshot, isNewlyStagedTargetRow)
  const canRemoveCurrentTargetRow = canRemoveTargetRow(snapshot, isPersistedTargetRow, isNewlyStagedTargetRow)
  const hasQtyOverride = Object.prototype.hasOwnProperty.call(snapshot.targetQuantityOverrides, row.id)
  const targetSourceDiscrepancy = resolveTargetDiscrepancy(row.id, row, structureContext.sourceDiscrepancyByNodeId, isSource)
  const showTargetQtyMismatch = !isSource && !isEffectivelyMarkedForDelete && targetSourceDiscrepancy.severity !== 'none'
  const hasRootDescriptorRow = context.rows.some((entry) => entry.level < 0)
  const visualLevel = row.level + (hasRootDescriptorRow ? 1 : 0)
  const indentPx = isAddProcessRow ? 0 : useStructuredTreeLayout ? Math.max(0, row.level) * MANUFACTURING_NUMBER_LAYOUT.selectorColumnWidth : Math.min(visualLevel * 12, 40)
  const showTreeIconBox = useStructuredTreeLayout && !isAddProcessRow
  const showAssemblyIconBox = showTreeIconBox && row.hasChildren
  const showPartIconBox = showTreeIconBox && !row.hasChildren
  const effectiveNumber = isSource ? row.node.itemNumber : snapshot.targetItemNumberOverrides[row.id] ?? row.node.itemNumber ?? ''
  const defaultQty = String(row.node.quantity || '').trim() || '1.0'
  const committedQty = hasQtyOverride
    ? String(snapshot.targetQuantityOverrides[row.id] ?? '')
    : String(row.node.quantity ?? '').trim()
  const effectiveQty = qtyDraft !== null ? qtyDraft : (committedQty || defaultQty)
  const sourceStatus = resolveSourceStatus(row.id, structureContext.targetTableNodeIds, hasQtyOverride, structureContext.sourceStatusByNodeId)
  const sourceDiscrepancy = structureContext.sourceDiscrepancyByNodeId[row.id] || {
    severity: 'none',
    sourceQuantity: '0.0',
    allocatedQuantity: '0.0',
    remainingQuantity: '0.0',
    tooltip: null
  }
  const shouldShowRequiredWarning = !isSource && !isEffectivelyMarkedForDelete && context.canEvaluateRequiredFields && (
    isTargetTopLevel
    || (snapshot.cloneLaunchMode === 'manufacturing' && row.level > 0 && (structureContext.selectedNodeIds.has(row.id) || isStagedSplitDraftRow))
  )
  const requiredSummary = shouldShowRequiredWarning
    ? buildRowRequiredValidationSummary(snapshot, row.node, snapshot.cloneLaunchMode === 'manufacturing' && isAddProcessRow)
    : null
  const canDragTargetRow = !isEffectivelyMarkedForDelete && (isTargetTopLevel || (isManufacturingMode && structureContext.selectedNodeIds.has(row.id)))
  const isDraggableRow = isSource ? canAddFromSourceRow : canDragTargetRow
  const handleDragEnd = (): void => {
    onSetDropState(null)
    clearActiveDragState()
  }

  const handleDragStart = (event: React.DragEvent<HTMLSpanElement>): void => {
    event.stopPropagation()
    if (isSource) {
      if (!canAddFromSourceRow) {
        event.preventDefault()
        return
      }
      setActiveDragNodeId(row.id)
      setActiveDragKind('source')
      event.dataTransfer.setData('text/plain', row.id)
      event.dataTransfer.setData(DRAG_KIND_MIME, 'source')
      event.dataTransfer.effectAllowed = 'copy'
      return
    }

    if (!canDragTargetRow) {
      event.preventDefault()
      return
    }
    setActiveDragNodeId(row.id)
    setActiveDragKind('target')
    event.dataTransfer.setData('text/plain', row.id)
    event.dataTransfer.setData(DRAG_KIND_MIME, 'target')
    event.dataTransfer.effectAllowed = 'move'
  }
  const sharedDragProps = isDraggableRow
    ? {
      draggable: true,
      onDragStart: handleDragStart,
      onDragEnd: handleDragEnd
    }
    : {}

  const classes = [
    useStructuredTreeLayout ? 'plm-extension-bom-structure-row-manufacturing' : '',
    isSource ? 'plm-extension-bom-structure-source-tr' : '',
    !isSource ? 'plm-extension-bom-structure-target-drop-row' : '',
    !isSource && isEffectivelyMarkedForDelete ? 'plm-extension-bom-structure-row-marked-delete' : '',
    !isSource && canDragTargetRow ? 'plm-extension-bom-structure-target-draggable' : '',
    isAddProcessRow ? 'plm-extension-bom-structure-process-selector-row' : '',
    dropState?.rowId === row.id && dropState.placement === 'before' ? 'is-over-before' : '',
    dropState?.rowId === row.id && dropState.placement === 'after' ? 'is-over-after' : '',
    dropState?.rowId === row.id && dropState.placement === 'inside' ? 'is-over-inside' : '',
    droppedRowId === row.id ? 'is-dropped' : ''
  ].filter(Boolean).join(' ')

  const actions: React.JSX.Element[] = []
  if (isSource) {
    if (!row.hasChildren) {
      actions.push(<span key="status" className={`plm-extension-bom-structure-status-rail ${sourceStatus === 'added' ? 'is-added' : sourceStatus === 'modified' ? 'is-modified' : 'is-not-added'}`} />)
      if (sourceDiscrepancy.severity !== 'none' && sourceDiscrepancy.tooltip) {
        actions.push(
          <span key="discrepancy" className={`plm-extension-bom-structure-source-discrepancy is-${sourceDiscrepancy.severity}`} title={sourceDiscrepancy.tooltip} aria-label={sourceDiscrepancy.tooltip}>
            <span className="zmdi zmdi-alert-triangle" aria-hidden="true" />
          </span>
        )
      }
    }
    if (canAddFromSourceRow && canAddToBom(snapshot)) {
      const isPending = structureContext.pendingAddNodeIds.has(row.id)
      const needsOperationSelection = modeView.sourceAddRequiresOperationSelection(snapshot)
      const canShowSourceSplit = isManufacturingSource
        && !row.hasChildren
        && sourceDiscrepancy.severity !== 'over'
        && hasPositiveRemainingQuantity(sourceDiscrepancy)
      const canShowAddRemaining = sourceDiscrepancy.severity === 'under'

      if (canShowSourceSplit) {
        const button = (
          <StructureActionButton
            key="split-source"
            tone="open"
            label={`Split remaining ${sourceDiscrepancy.remainingQuantity} of ${row.node.label} to another process`}
            icon={<SplitBalanceGlyph />}
            disabled={needsOperationSelection}
            onClick={needsOperationSelection ? undefined : () => handlers.onSplitSourceNode(row.id)}
          />
        )
        actions.push(needsOperationSelection ? <span key="split-source-wrap" className="plm-extension-bom-structure-action-tooltip-host" title="Select process first">{button}</span> : button)
      }

      if (canShowAddRemaining) {
        const button = (
          <StructureActionButton
            key="add-remaining"
            tone="add"
            label={`Add remaining ${sourceDiscrepancy.remainingQuantity} of ${row.node.label}`}
            icon={<span className={isPending ? 'zmdi zmdi-refresh zmdi-hc-spin' : 'zmdi zmdi-plus'} />}
            disabled={isPending || needsOperationSelection}
            onClick={isPending || needsOperationSelection ? undefined : () => handlers.onAddRemainingSourceNode(row.id)}
          />
        )
        actions.push(needsOperationSelection ? <span key="add-remaining-wrap" className="plm-extension-bom-structure-action-tooltip-host" title="Select process first">{button}</span> : button)
      } else if (sourceStatus === 'not-added' || (isSourceTopLevel && !structureContext.selectedNodeIds.has(row.id))) {
        const button = (
          <StructureActionButton
            key="add"
            tone="add"
            label={
              isPending
                ? `Adding ${row.node.label} to target BOM`
                : needsOperationSelection
                  ? 'Select process first'
                  : isManufacturingSource
                    ? `Add ${row.node.label} to target MBOM`
                    : `Add ${row.node.label} to target BOM`
            }
            icon={<span className={isPending ? 'zmdi zmdi-refresh zmdi-hc-spin' : 'zmdi zmdi-plus'} />}
            disabled={isPending || needsOperationSelection}
            onClick={isPending || needsOperationSelection ? undefined : () => handlers.onDropNodeToTarget(row.id)}
          />
        )
        actions.push(needsOperationSelection ? <span key="add-wrap" className="plm-extension-bom-structure-action-tooltip-host" title="Select process first">{button}</span> : button)
      } else {
        actions.push(<span key="spacer" className="plm-extension-bom-structure-action-spacer" aria-hidden="true" />)
      }
    } else {
      const needsOperationSelection = modeView.sourceAddRequiresOperationSelection(snapshot)
      const canAddAssemblySubcomponents = isManufacturingSource && row.hasChildren
      if (canAddAssemblySubcomponents && canAddToBom(snapshot)) {
        const allLeafPartsAlreadyOnTarget = structureContext.sourceAllLeafPartsOnTargetByNodeId[row.id] === true
        if (allLeafPartsAlreadyOnTarget) {
          actions.push(<span key="spacer" className="plm-extension-bom-structure-action-spacer" aria-hidden="true" />)
        } else {
          const button = (
            <StructureActionButton
              key="add-subcomponents"
              tone="add"
              label={needsOperationSelection ? 'Select process first' : `Add all subcomponents of ${row.node.label} to target MBOM`}
              icon={<ListAddGlyph />}
              disabled={needsOperationSelection}
              onClick={needsOperationSelection ? undefined : () => handlers.onDropSourceAssemblySubcomponentsToTarget(row.id)}
            />
          )
          actions.push(needsOperationSelection ? <span key="add-subcomponents-wrap" className="plm-extension-bom-structure-action-tooltip-host" title="Select process first">{button}</span> : button)
        }
      } else {
        actions.push(<span key="spacer" className="plm-extension-bom-structure-action-spacer" aria-hidden="true" />)
      }
    }
  } else {
    if (row.level === 0) {
      if (!row.hasChildren && row.node.fromLinkableDialog) {
        actions.push(<span key="status" className={`plm-extension-bom-structure-status-rail ${hasQtyOverride ? 'is-modified' : 'is-added'}`} />)
      } else if (!row.hasChildren && hasQtyOverride && structureContext.selectedNodeIds.has(row.id)) {
        actions.push(<span key="status" className="plm-extension-bom-structure-status-rail is-modified" />)
      }
    }
    if (requiredSummary) {
      actions.push(<RequiredIndicator key="required" nodeId={row.id} completion={requiredSummary.combined} tooltip={requiredSummary.tooltip} />)
    }
    if (row.level === 0) {
      const isEditing = snapshot.editingNodeId === row.id
      const isEditingItem = isEditing && snapshot.editingPanelMode !== 'bom'
      const isEditingBom = isEditing && snapshot.editingPanelMode === 'bom'
      const isAnyEditOpen = Boolean(snapshot.editingNodeId)
      if (snapshot.cloneLaunchMode === 'manufacturing') {
        const bomDetailsDisabled = isAnyEditOpen || !context.hasEditableBomFields
        const bomDetailsReason = !context.hasEditableBomFields
          ? 'No editable BOM fields'
          : bomDetailsDisabled
            ? 'Unavailable while editing'
            : `Edit BOM Details for ${row.node.label}`
        if (isAddProcessRow && canEditCurrentTargetRow) {
          actions.push(
            <StructureActionButton
              key="item-details"
              tone="open"
              label={isEditingItem ? `Editing ${row.node.label}` : `Edit Item Details for ${row.node.label}`}
              icon={<span className="zmdi zmdi-assignment" />}
              disabled={isAnyEditOpen}
              active={isEditingItem}
              tooltip={isAnyEditOpen ? 'Unavailable while editing' : `Edit Item Details for ${row.node.label}`}
              onClick={isAnyEditOpen ? undefined : () => handlers.onOpenProcessItemDetails(row.id)}
            />
          )
        }
        if (canEditCurrentTargetRow) {
          actions.push(
            <StructureActionButton
              key="bom-details"
              tone="open"
              label={isEditingBom ? `Editing BOM Details for ${row.node.label}` : `Edit BOM Details for ${row.node.label}`}
              icon={<span className="zmdi zmdi-view-list-alt" />}
              disabled={bomDetailsDisabled}
              active={isEditingBom}
              tooltip={bomDetailsReason}
              onClick={bomDetailsDisabled ? undefined : () => handlers.onOpenProcessBomDetails(row.id)}
            />
          )
        }
      } else if (canEditCurrentTargetRow) {
        actions.push(
          <StructureActionButton
            key="edit"
            tone="edit"
            label={isEditing ? `Editing ${row.node.label}` : `Edit ${row.node.label}`}
            icon={<span className="zmdi zmdi-edit" />}
            active={isEditing}
            onClick={() => handlers.onEditNode(row.id)}
          />
        )
      }
      if (canSplitTargetRow) {
        actions.push(
          <StructureActionButton
            key="split-target"
            tone="open"
            label={`Split ${row.node.label} to another process`}
            icon={<SplitBalanceGlyph />}
            onClick={() => handlers.onSplitTargetNode(row.id)}
          />
        )
      }
      if (canRemoveCurrentTargetRow) {
        actions.push(
          <StructureActionButton
            key="remove-target"
            tone="remove"
            label={isMarkedForDelete ? `Undo remove ${row.node.label} from target BOM` : `Remove ${row.node.label} from target BOM`}
            icon={<span className={isMarkedForDelete ? 'zmdi zmdi-undo' : 'zmdi zmdi-delete'} />}
            onClick={() => handlers.onRemoveTargetNode(row.id)}
          />
        )
      }
    } else if (snapshot.cloneLaunchMode === 'manufacturing' && !row.node.stagedOperationDraft) {
      const isEditing = snapshot.editingNodeId === row.id
      const isEditingBom = isEditing && snapshot.editingPanelMode === 'bom'
      const bomDetailsDisabled = Boolean(snapshot.editingNodeId) || !context.hasEditableBomFields
      const bomDetailsReason = !context.hasEditableBomFields
        ? 'No editable BOM fields'
        : bomDetailsDisabled
          ? 'Unavailable while editing'
          : `Edit BOM Details for ${row.node.label}`
      if (canEditCurrentTargetRow) {
        actions.push(
          <StructureActionButton
            key="bom-details"
            tone="open"
            label={isEditingBom ? `Editing BOM Details for ${row.node.label}` : `Edit BOM Details for ${row.node.label}`}
            icon={<span className="zmdi zmdi-view-list-alt" />}
            active={isEditingBom}
            disabled={bomDetailsDisabled}
            tooltip={bomDetailsReason}
            onClick={bomDetailsDisabled ? undefined : () => handlers.onOpenProcessBomDetails(row.id)}
          />
        )
      }
      const useStagedChildRemove = modeView.shouldRenderStagedChildRemove(
        snapshot,
        row,
        structureContext.selectedNodeIds,
        structureContext.targetExistingNodeIds,
        isSource
      )
      if (canSplitTargetRow) {
        actions.push(
          <StructureActionButton
            key="split-target"
            tone="open"
            label={`Split ${row.node.label} to another process`}
            icon={<SplitBalanceGlyph />}
            onClick={() => handlers.onSplitTargetNode(row.id)}
          />
        )
      }
      if (canRemoveCurrentTargetRow) {
        actions.push(
          <StructureActionButton
            key="remove-target"
            tone="remove"
            label={useStagedChildRemove
              ? modeView.stagedChildRemoveLabel(row.node.label)
              : isMarkedForDelete
                ? `Undo remove ${row.node.label} from target BOM`
                : `Remove ${row.node.label} from target BOM`}
            icon={<span className={isMarkedForDelete ? 'zmdi zmdi-undo' : 'zmdi zmdi-delete'} />}
            onClick={() => handlers.onRemoveTargetNode(row.id)}
          />
        )
      }
    }
  }

  return (
    <tr
      className={classes}
      data-node-id={isSource ? row.id : undefined}
      onDragOver={!isSource ? (event) => {
        event.preventDefault()
        event.stopPropagation()
        const scrollContainer = event.currentTarget.closest('.plm-extension-bom-structure-pane-body')
        if (scrollContainer instanceof HTMLElement) autoScrollStructurePane(scrollContainer, event.clientY)
        const draggedNodeId = getDraggedNodeId(event.nativeEvent)
        if (!draggedNodeId || draggedNodeId === row.id) return
        const draggedKind = getDraggedKind(event.nativeEvent)
        const isDraggingTargetRow = draggedKind === 'target'
        if (!isDraggingTargetRow) {
          onSetDropState({ rowId: row.id, placement: 'inside' })
          return
        }
        const draggedRow = context.rowById.get(draggedNodeId)
        if (
          isDraggingTargetRow
          && isManufacturingMode
          && draggedRow
          && isAddProcessRow
          && !context.manufacturingProcessNodeIds.has(draggedNodeId)
        ) {
          onSetDropState({ rowId: row.id, placement: 'inside' })
          return
        }
        const rect = event.currentTarget.getBoundingClientRect()
        const midpoint = rect.top + rect.height / 2
        const deadZonePx = Math.min(10, rect.height * 0.12)
        let placement: DropPlacement
        if (event.clientY <= midpoint - deadZonePx) {
          placement = 'before'
        } else if (event.clientY >= midpoint + deadZonePx) {
          placement = 'after'
        } else if (dropState?.rowId === row.id) {
          placement = dropState.placement
        } else {
          placement = event.clientY < midpoint ? 'before' : 'after'
        }
        onSetDropState({ rowId: row.id, placement })
      } : undefined}
      onDragLeave={!isSource ? (event) => {
        const nextTarget = event.relatedTarget
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
        const currentTarget = event.currentTarget
        const { clientX, clientY } = event
        window.requestAnimationFrame(() => {
          const hovered = document.elementFromPoint(clientX, clientY)
          if (hovered instanceof Node && currentTarget.contains(hovered)) return
          onSetDropState(null)
        })
      } : undefined}
      onDrop={!isSource ? (event) => {
        event.preventDefault()
        event.stopPropagation()
        onSetDropState(null)
        clearActiveDragState()
        const draggedNodeId = getDraggedNodeId(event.nativeEvent)
        if (!draggedNodeId || draggedNodeId === row.id) return
        const draggedKind = getDraggedKind(event.nativeEvent)
        if (draggedKind !== 'target') {
          if (!snapshot.permissions.canAdd) return
          if (isManufacturingTargetTopLevel && !isAddProcessRow) handlers.onSelectManufacturingRoot()
          else if (isManufacturingMode && row.level > 0) {
            const parentId = context.rowParentById.get(row.id) || null
            if (parentId) handlers.onSelectManufacturingOperation(parentId)
            else handlers.onSelectManufacturingRoot()
          } else {
            modeView.onExternalDropToTargetRow(row.id, handlers.onSelectManufacturingOperation)
          }
          const explicitOperationNodeId = isManufacturingMode
            ? (isAddProcessRow ? row.id : row.level > 0 ? (context.rowParentById.get(row.id) || null) : null)
            : undefined
          handlers.onDropNodeToTarget(draggedNodeId, explicitOperationNodeId)
          onMarkDropped(row.id)
          return
        }
        const draggedRow = context.rowById.get(draggedNodeId)
        if (
          isManufacturingMode
          && draggedRow
          && isAddProcessRow
          && !context.manufacturingProcessNodeIds.has(draggedNodeId)
        ) {
          handlers.onReorderTargetNode(draggedNodeId, row.id, 'inside')
          onMarkDropped(row.id)
          return
        }
        const placement = dropState?.rowId === row.id && dropState.placement !== 'inside'
          ? dropState.placement
          : (() => {
            const rect = event.currentTarget.getBoundingClientRect()
            return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
          })()
        handlers.onReorderTargetNode(draggedNodeId, row.id, placement)
        onMarkDropped(row.id)
      } : undefined}
    >
      <td colSpan={2} className="plm-extension-bom-structure-number-descriptor-merged-cell">
        <div className="plm-extension-bom-structure-number-descriptor-merged-wrap">
          <div className={`plm-extension-bom-structure-number${isAddProcessRow ? ' is-process-selector-row' : ''}`} style={{ paddingLeft: `${indentPx}px` }}>
            <StructureNodeControl
              hasChildren={row.hasChildren}
              expanded={row.expanded}
              loading={snapshot.expandingNodeIds.includes(row.id)}
              onToggle={() => {
                if (isSource) handlers.onToggleSourceNodeExpanded(row.id)
                else handlers.onToggleTargetNodeExpanded(row.id)
              }}
            />
            {isAddProcessRow ? (
              showOperationSelector ? (
                <span className="plm-extension-bom-structure-operation-radio-box">
                  <input
                    type="radio"
                    name="plm-bom-clone-manufacturing-operation"
                    className="plm-extension-bom-structure-operation-radio"
                    checked={context.selectedOperationNodeId === row.id}
                    title={`Use ${row.node.label} as active process`}
                    aria-label={`Use ${row.node.label} as active process`}
                    onChange={(event) => {
                      if (!event.target.checked) return
                      handlers.onSelectManufacturingOperation(row.id)
                    }}
                  />
                </span>
              ) : null
            ) : (
              <>
                {showAssemblyIconBox ? <span className="plm-extension-bom-structure-assembly-icon-box"><CubeGlyph assembly /></span> : null}
                {showPartIconBox ? <span className="plm-extension-bom-structure-part-icon-box"><CubeGlyph /></span> : null}
                {showOperationSelector ? (
                  <input
                    type="radio"
                    name="plm-bom-clone-manufacturing-operation"
                    className="plm-extension-bom-structure-operation-radio"
                    checked={context.selectedOperationNodeId === row.id}
                    title={`Use ${row.node.label} as active process`}
                    aria-label={`Use ${row.node.label} as active process`}
                    onChange={(event) => {
                      if (!event.target.checked) return
                      handlers.onSelectManufacturingOperation(row.id)
                    }}
                  />
                ) : null}
              </>
            )}
            {isDraggableRow ? (
              <StructureDragHandle
                label={isSource ? `Drag ${row.node.label} to stage it in the target BOM` : `Drag ${row.node.label} to reorder it`}
                {...sharedDragProps}
              />
            ) : null}
            <span
              className={[
                'plm-extension-bom-structure-number-value',
                !isSource && context.failedCommitNodeIds.has(row.id) ? 'is-commit-failed' : '',
                isDraggableRow ? 'is-draggable' : ''
              ].filter(Boolean).join(' ')}
              {...sharedDragProps}
            >
              {getDisplayItemNumber(effectiveNumber)}
            </span>
          </div>
          <div
            className={`plm-extension-bom-structure-descriptor-scroll${isDraggableRow ? ' is-draggable' : ''}`}
            title={row.node.label}
            {...sharedDragProps}
          >
            {row.node.label}
          </div>
        </div>
      </td>
      <td className={`plm-extension-bom-structure-qty-cell${showTargetQtyMismatch ? ' is-qty-modified' : ''}`}>
        {!isSource && !isEffectivelyMarkedForDelete && canEditCurrentTargetRow ? (
          <input
            type="text"
            inputMode="decimal"
            pattern="^\\d*(\\.\\d*)?$"
            className={`plm-extension-bom-structure-edit-input plm-extension-bom-structure-qty-input${showTargetQtyMismatch ? ' is-qty-modified' : ''}`}
            value={effectiveQty}
            data-plm-focus-key={`target-qty-${row.id}`}
            onMouseDown={(event) => event.stopPropagation()}
            onFocus={() => setQtyDraft(committedQty || defaultQty)}
            onDragStart={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onChange={(event) => {
              const sanitized = event.currentTarget.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1')
              setQtyDraft(sanitized)
            }}
            onBlur={(event) => {
              const sanitized = event.currentTarget.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1').trim()
              handlers.onEditTargetQuantity(row.id, sanitized || defaultQty)
              setQtyDraft(null)
            }}
          />
        ) : (
          isSource ? (String(row.node.quantity || '').trim() || '-') : effectiveQty
        )}
      </td>
      <td className="plm-extension-bom-structure-action-cell">
        <div className="plm-extension-bom-structure-action-wrap">{actions}</div>
      </td>
    </tr>
  )
}

export function CloneStructureRows(props: {
  rows: CloneStructureViewModel['filteredSourceRows'] | CloneStructureViewModel['selectedRows']
  snapshot: BomCloneStateSnapshot
  structureContext: CloneStructureViewModel
  handlers: CloneStructureHandlers
  sourceSide: boolean
  emptyMessage: string
}): React.JSX.Element {
  const { rows, snapshot, structureContext, handlers, sourceSide, emptyMessage } = props
  const [dropState, setDropState] = useState<DropState | null>(null)
  const [droppedRowId, setDroppedRowId] = useState<string | null>(null)

  const updateDropState = (nextState: DropState | null): void => {
    setDropState((current) => {
      if (current === nextState) return current
      if (!current && !nextState) return current
      if (
        current
        && nextState
        && current.rowId === nextState.rowId
        && current.placement === nextState.placement
      ) {
        return current
      }
      return nextState
    })
  }

  useEffect(() => {
    if (!droppedRowId) return
    const timeout = window.setTimeout(() => setDroppedRowId(null), 180)
    return () => window.clearTimeout(timeout)
  }, [droppedRowId])

  useEffect(() => {
    const handleGlobalDragEnd = (): void => {
      updateDropState(null)
      clearActiveDragState()
    }

    window.addEventListener('dragend', handleGlobalDragEnd)
    window.addEventListener('drop', handleGlobalDragEnd)
    return () => {
      window.removeEventListener('dragend', handleGlobalDragEnd)
      window.removeEventListener('drop', handleGlobalDragEnd)
    }
  }, [])

  const context = useMemo<RowSharedContext>(() => ({
    snapshot,
    structureContext,
    handlers,
    isSource: sourceSide,
    rows,
    sourceTopLevelNodeIds: new Set(sourceSide ? (snapshot.sourceBomTree[0]?.children?.length ? snapshot.sourceBomTree[0].children : snapshot.sourceBomTree).map((node) => node.id) : []),
    targetPreExistingItemIds: new Set(snapshot.targetBomPreExistingItemIds.map((id) => Number(id)).filter(Number.isFinite)),
    targetRowIds: new Set(rows.map((row) => row.id)),
    rowById: new Map(rows.map((row) => [row.id, row])),
    rowParentById: buildRowParentMap(rows),
    manufacturingProcessNodeIds: snapshot.cloneLaunchMode === 'manufacturing' ? resolveManufacturingProcessNodeIds(snapshot) : new Set<string>(),
    failedCommitNodeIds: new Set(snapshot.commitErrors.map((entry) => String(entry.nodeId || '').trim()).filter(Boolean)),
    hasEditableBomFields: snapshot.bomViewFields.some((field) => field.editable),
    canEvaluateRequiredFields: !snapshot.bomViewFieldsLoading,
    selectedOperationNodeId: resolveStructureModeView(snapshot).resolveSelectedOperationNodeId(snapshot),
    modeView: resolveStructureModeView(snapshot)
  }), [snapshot, structureContext, handlers, sourceSide, rows])

  if (!rows.some((row) => row.level >= 0)) {
    return (
      <tbody>
        <tr>
          <td colSpan={4} className="plm-extension-bom-structure-empty">{emptyMessage}</td>
        </tr>
      </tbody>
    )
  }

  return (
    <tbody>
      {rows.map((row, index) => (
        <StructureRow
          key={`${row.id}:${index}`}
          row={row}
          index={index}
          context={context}
          dropState={dropState}
          onSetDropState={updateDropState}
          onMarkDropped={setDroppedRowId}
          droppedRowId={droppedRowId}
        />
      ))}
    </tbody>
  )
}
