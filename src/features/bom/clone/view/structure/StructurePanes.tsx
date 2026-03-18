import React, { useMemo } from 'react'
import type { BomCloneStateSnapshot } from '../../clone.types'
import type { CloneStructureViewModel } from '../../services/viewModel.service'
import { resolveStructureModeView } from './structure.mode.view'
import {
  MANUFACTURING_NUMBER_LAYOUT,
  getDraggedNodeId,
  resolveNumberColumnWidth,
  type CloneStructureHandlers
} from './structure.rows.view'
import { CloneStructureRows } from './StructureRows'

type SourceStatusFilter = BomCloneStateSnapshot['sourceStatusFilter']
type DragKind = 'source' | 'target'

const ACTIVE_DRAG_KIND_ATTR = 'data-plm-bom-clone-drag-kind'
const DRAG_KIND_MIME = 'application/x-plm-bom-clone-drag-kind'

/**
 * React owns the pane chrome now: header, actions, empty states, progress bars,
 * and the drop-zone containers. The only imperative piece left here is the row
 * renderer, which still handles the highly coupled table-row drag/drop logic.
 */

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

function getDraggedKind(event: DragEvent): DragKind | null {
  const transferKind = event.dataTransfer?.getData(DRAG_KIND_MIME).trim()
  if (transferKind === 'source' || transferKind === 'target') return transferKind
  const activeKind = document.body?.getAttribute(ACTIVE_DRAG_KIND_ATTR)?.trim()
  return activeKind === 'source' || activeKind === 'target' ? activeKind : null
}

function clearActiveDragKind(): void {
  document.body?.removeAttribute(ACTIVE_DRAG_KIND_ATTR)
}

function formatProgressQuantity(value: number): string {
  const rounded = Math.round(Math.max(0, value) * 1000) / 1000
  if (Math.abs(rounded - Math.round(rounded)) < 0.000001) return rounded.toFixed(1)
  return String(rounded).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

function filterTargetRowsForCommitErrors(
  rows: CloneStructureViewModel['selectedRows'],
  snapshot: Pick<BomCloneStateSnapshot, 'commitErrors' | 'showCommitErrorsOnly'>
): CloneStructureViewModel['selectedRows'] {
  if (!snapshot.showCommitErrorsOnly || snapshot.commitErrors.length === 0) return rows

  const failedNodeIds = new Set(
    snapshot.commitErrors
      .map((entry) => String(entry.nodeId || '').trim())
      .filter(Boolean)
  )
  if (failedNodeIds.size === 0) return rows

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

  const visibleIds = new Set<string>()
  for (const failedNodeId of failedNodeIds) {
    let currentId: string | null = failedNodeId
    while (currentId) {
      visibleIds.add(currentId)
      currentId = parentById.get(currentId) || null
    }
  }

  return rows.filter((row) => row.level < 0 || visibleIds.has(row.id))
}

function StructurePaneIconButton(props: {
  iconClassName: string
  tooltip: string
  ariaLabel?: string
  disabled?: boolean
  active?: boolean
  label?: string
  onClick: () => void
}): React.JSX.Element {
  const { iconClassName, tooltip, ariaLabel, disabled = false, active = false, label, onClick } = props
  return (
    <button
      type="button"
      className={`plm-extension-bom-structure-pane-action-btn plm-extension-btn plm-extension-btn--secondary${label ? '' : ' is-icon'}${active ? ' is-active' : ''}`}
      title={tooltip}
      aria-label={ariaLabel || tooltip}
      disabled={disabled}
      onClick={onClick}
    >
      <span className={iconClassName} aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </button>
  )
}

function StructureTableColumns(): React.JSX.Element {
  return (
    <colgroup>
      <col className="plm-extension-bom-structure-col plm-extension-bom-structure-col-number" />
      <col className="plm-extension-bom-structure-col plm-extension-bom-structure-col-descriptor" />
      <col className="plm-extension-bom-structure-col plm-extension-bom-structure-col-qty" />
      <col className="plm-extension-bom-structure-col plm-extension-bom-structure-col-actions" />
    </colgroup>
  )
}

function StructureTableShell(props: {
  rows: CloneStructureViewModel['filteredSourceRows'] | CloneStructureViewModel['selectedRows']
  snapshot: BomCloneStateSnapshot
  structureContext: CloneStructureViewModel
  handlers: CloneStructureHandlers
  sourceSide: boolean
  emptyMessage: string
}): React.JSX.Element {
  const { rows, snapshot, structureContext, handlers, sourceSide, emptyMessage } = props
  return (
    <table className="plm-extension-bom-structure-table plm-extension-table">
      <StructureTableColumns />
      <CloneStructureRows
        rows={rows}
        snapshot={snapshot}
        structureContext={structureContext}
        handlers={handlers}
        sourceSide={sourceSide}
        emptyMessage={emptyMessage}
      />
    </table>
  )
}

function SourceProgress(props: {
  snapshot: BomCloneStateSnapshot
  structureContext: CloneStructureViewModel
  onSetSourceStatusFilter: CloneStructureHandlers['onSetSourceStatusFilter']
}): React.JSX.Element {
  const { snapshot, structureContext, onSetSourceStatusFilter } = props
  const resolveSourceFilterLabel = (value: SourceStatusFilter): string => {
    if (value === 'added') return 'Added'
    if (value === 'modified') return 'Partial'
    if (value === 'not-added') return 'Not Added'
    return 'All'
  }

  const counts = structureContext.sourceStatusCounts
  const quantities = structureContext.sourceStatusQuantities
  const total = Math.max(1, quantities.total)
  const segmentConfig: Array<{
    key: Exclude<SourceStatusFilter, 'all'>
    count: number
    width: number
    title: string
  }> = [
    {
      key: 'not-added',
      count: counts.notAdded,
      width: (quantities.notAdded / total) * 100,
      title: `${counts.notAdded} not added (${formatProgressQuantity(quantities.notAdded)} qty)`
    },
    {
      key: 'modified',
      count: counts.modified,
      width: (quantities.modified / total) * 100,
      title: `${counts.modified} partially added (${formatProgressQuantity(quantities.modified)} qty)`
    },
    {
      key: 'added',
      count: counts.added,
      width: (quantities.added / total) * 100,
      title: `${counts.added} fully added (${formatProgressQuantity(quantities.added)} qty)`
    }
  ]

  return (
    <div className="plm-extension-bom-structure-source-footer">
      <div className="plm-extension-bom-structure-source-progress">
        {segmentConfig.map((segment) => {
          const isActive = snapshot.sourceStatusFilter === segment.key
          const tooltip = isActive
            ? `${segment.title}. Click again to clear filter.`
            : `${segment.title}. Click to filter.`
          const label = isActive
            ? `${segment.title}. ${resolveSourceFilterLabel(segment.key)} filter active. Click again to clear filter.`
            : `${segment.title}. Filter ${resolveSourceFilterLabel(segment.key)}.`
          return (
            <button
              key={segment.key}
              type="button"
              className={`plm-extension-bom-structure-source-progress-segment is-${segment.key}${isActive ? ' is-active' : ''}`}
              style={{ width: `${Math.max(0, segment.width)}%` }}
              title={tooltip}
              aria-label={label}
              disabled={segment.count === 0}
              onClick={() => onSetSourceStatusFilter(isActive ? 'all' : segment.key)}
            />
          )
        })}
      </div>
    </div>
  )
}

export function CloneSourcePane(props: {
  snapshot: BomCloneStateSnapshot
  structureContext: CloneStructureViewModel
  handlers: CloneStructureHandlers
}): React.JSX.Element | null {
  const { snapshot, structureContext, handlers } = props
  const isEditMode = Boolean(snapshot.editingNodeId)
  if (isEditMode) return null

  return (
    <section
      className="plm-extension-bom-structure-pane"
      style={{
        ['--plm-bom-structure-number-col-width' as string]: `${resolveNumberColumnWidth(structureContext.filteredSourceRows, { manufacturing: true })}px`,
        ['--plm-bom-structure-qty-col-width' as string]: '60px',
        ['--plm-bom-structure-action-col-width' as string]: '138px',
        ['--plm-bom-structure-selector-col-width' as string]: `${MANUFACTURING_NUMBER_LAYOUT.selectorColumnWidth}px`
      }}
    >
      <div className="plm-extension-bom-structure-pane-header">
        <span>{`Source: ${structureContext.sourceRoot?.label || 'Bill of Materials'}`}</span>
        <div className="plm-extension-bom-structure-pane-actions">
          {snapshot.permissions.canAdd && (
            <StructurePaneIconButton
              iconClassName="zmdi zmdi-collection-plus"
              label="Add All"
              tooltip="Add all source items to target BOM"
              disabled={snapshot.sourceExpandAllLoading || structureContext.filteredSourceRows.filter((r) => r.level === 0).length === 0}
              onClick={() => {
                for (const row of structureContext.filteredSourceRows) {
                  if (row.level === 0) handlers.onDropNodeToTarget(row.id)
                }
              }}
            />
          )}
          <div className="plm-extension-bom-structure-pane-action-group">
            <StructurePaneIconButton
              iconClassName={snapshot.sourceExpandAllLoading ? 'zmdi zmdi-refresh zmdi-hc-spin' : 'zmdi zmdi-plus-square'}
              tooltip={
                snapshot.sourceExpandAllLoading
                  ? 'Expanding source BOM...'
                  : 'Expand all source rows'
              }
              disabled={snapshot.sourceExpandAllLoading}
              onClick={handlers.onExpandAllSource}
            />
            <StructurePaneIconButton
              iconClassName="zmdi zmdi-minus-square"
              tooltip="Collapse all source rows"
              disabled={snapshot.sourceExpandAllLoading}
              onClick={handlers.onCollapseAllSource}
            />
          </div>
        </div>
      </div>
      <div className="plm-extension-bom-structure-pane-body">
        <StructureTableShell
          rows={structureContext.filteredSourceRows}
          snapshot={snapshot}
          structureContext={structureContext}
          handlers={handlers}
          sourceSide={true}
          emptyMessage="No source rows match the selected status filter."
        />
      </div>
      <SourceProgress
        snapshot={snapshot}
        structureContext={structureContext}
        onSetSourceStatusFilter={handlers.onSetSourceStatusFilter}
      />
    </section>
  )
}

export function CloneTargetPane(props: {
  snapshot: BomCloneStateSnapshot
  structureContext: CloneStructureViewModel
  handlers: CloneStructureHandlers
}): React.JSX.Element {
  const { snapshot, structureContext, handlers } = props
  const visibleTargetRows = useMemo(
    () => filterTargetRowsForCommitErrors(structureContext.selectedRows, snapshot),
    [structureContext.selectedRows, snapshot]
  )
  const isEditMode = Boolean(snapshot.editingNodeId)
  const topLevelTargetNodeIds = visibleTargetRows.filter((row) => row.level === 0).map((row) => row.id)
  const topLevelTargetNodeIdSet = new Set(topLevelTargetNodeIds)
  const targetRowNodeIdSet = new Set(visibleTargetRows.filter((row) => row.level >= 0).map((row) => row.id))
  const firstTopLevelTargetNodeId = topLevelTargetNodeIds[0] || null
  const lastTopLevelTargetNodeId = topLevelTargetNodeIds[topLevelTargetNodeIds.length - 1] || null
  const modeView = resolveStructureModeView(snapshot)
  const addExistingState = modeView.resolveTargetAddExistingState(snapshot, topLevelTargetNodeIds)
  const modeAction = useMemo(() => modeView.resolveTargetModeAction(snapshot), [modeView, snapshot])

  return (
    <section
      className="plm-extension-bom-structure-pane plm-extension-bom-structure-pane-target"
      style={{
        ['--plm-bom-structure-number-col-width' as string]: `${resolveNumberColumnWidth(visibleTargetRows, { manufacturing: true })}px`,
        ['--plm-bom-structure-qty-col-width' as string]: '72px',
        ['--plm-bom-structure-action-col-width' as string]: '152px',
        ['--plm-bom-structure-selector-col-width' as string]: `${MANUFACTURING_NUMBER_LAYOUT.selectorColumnWidth}px`
      }}
    >
      <div className="plm-extension-bom-structure-pane-header">
        <span>{`Target: ${structureContext.targetRoot?.label || 'Items to Clone'}`}</span>
        <div className="plm-extension-bom-structure-pane-actions">
          {snapshot.commitErrors.length > 0 ? (
            <StructurePaneIconButton
              iconClassName="zmdi zmdi-alert-triangle"
              label="Show Errors Only"
              tooltip={snapshot.showCommitErrorsOnly ? 'Showing only failed rows.' : 'Show only failed rows.'}
              active={snapshot.showCommitErrorsOnly}
              onClick={handlers.onToggleShowCommitErrorsOnly}
            />
          ) : null}
          {snapshot.permissions.canAdd && modeAction ? (
            <StructurePaneIconButton
              iconClassName={modeAction.iconClassName}
              label={modeAction.label}
              tooltip={isEditMode ? 'Finish editing before adding processes' : modeAction.tooltip}
              ariaLabel={isEditMode ? 'Finish editing before adding processes' : modeAction.ariaLabel}
              disabled={isEditMode}
              onClick={handlers.onAddOperation}
            />
          ) : null}
          {snapshot.permissions.canAdd ? (
            <StructurePaneIconButton
              iconClassName="zmdi zmdi-plus"
              label={addExistingState.label}
              tooltip={isEditMode ? 'Finish editing before adding existing items' : addExistingState.tooltip}
              disabled={isEditMode || !addExistingState.enabled}
              onClick={handlers.onOpenLinkableDialog}
            />
          ) : null}
          <div className="plm-extension-bom-structure-pane-action-group">
            <StructurePaneIconButton
              iconClassName={snapshot.targetExpandAllLoading ? 'zmdi zmdi-refresh zmdi-hc-spin' : 'zmdi zmdi-plus-square'}
              tooltip={
                isEditMode
                  ? 'Finish editing before expanding target rows'
                  : snapshot.targetExpandAllLoading
                    ? 'Expanding target BOM...'
                    : 'Expand all target rows'
              }
              disabled={snapshot.targetExpandAllLoading || isEditMode}
              onClick={handlers.onExpandAllTarget}
            />
            <StructurePaneIconButton
              iconClassName="zmdi zmdi-minus-square"
              tooltip={isEditMode ? 'Finish editing before collapsing target rows' : 'Collapse all target rows'}
              disabled={snapshot.targetExpandAllLoading || isEditMode}
              onClick={handlers.onCollapseAllTarget}
            />
          </div>
        </div>
      </div>
      <div
        className="plm-extension-bom-structure-pane-body plm-extension-bom-structure-drop-zone"
        onDragOver={(event) => {
          if (!snapshot.permissions.canAdd) return
          event.preventDefault()
          autoScrollStructurePane(event.currentTarget, event.clientY)
          const nodeId = getDraggedNodeId(event.nativeEvent)
          const draggedKind = getDraggedKind(event.nativeEvent)
          const currentTarget = event.currentTarget
          const isTargetRowDrag = draggedKind === 'target'
          const isTargetReorder = draggedKind === 'target' && Boolean(nodeId && topLevelTargetNodeIdSet.has(nodeId))
          if (isTargetRowDrag && !isTargetReorder) {
            currentTarget.classList.remove('is-over', 'is-over-top', 'is-over-bottom')
            return
          }
          if (!isTargetReorder) {
            currentTarget.classList.add('is-over')
            currentTarget.classList.remove('is-over-top', 'is-over-bottom')
            return
          }

          const rect = currentTarget.getBoundingClientRect()
          const isTopZone = event.clientY <= rect.top + 28
          currentTarget.classList.remove('is-over')
          currentTarget.classList.toggle('is-over-top', isTopZone)
          currentTarget.classList.toggle('is-over-bottom', !isTopZone)
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget
          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
          event.currentTarget.classList.remove('is-over', 'is-over-top', 'is-over-bottom')
        }}
        onDrop={(event) => {
          if (!snapshot.permissions.canAdd) return
          event.preventDefault()
          const currentTarget = event.currentTarget
          currentTarget.classList.remove('is-over', 'is-over-top', 'is-over-bottom')
          clearActiveDragKind()
          const nodeId = getDraggedNodeId(event.nativeEvent)
          const draggedKind = getDraggedKind(event.nativeEvent)
          if (!nodeId) return
          if (draggedKind === 'target' && targetRowNodeIdSet.has(nodeId) && !topLevelTargetNodeIdSet.has(nodeId)) return

          if (draggedKind === 'target' && topLevelTargetNodeIdSet.has(nodeId) && (firstTopLevelTargetNodeId || lastTopLevelTargetNodeId)) {
            const rect = currentTarget.getBoundingClientRect()
            const isTopZone = event.clientY <= rect.top + 28
            if (isTopZone && firstTopLevelTargetNodeId) {
              handlers.onReorderTargetNode(nodeId, firstTopLevelTargetNodeId, 'before')
              return
            }
            if (lastTopLevelTargetNodeId) {
              handlers.onReorderTargetNode(nodeId, lastTopLevelTargetNodeId, 'after')
              return
            }
            return
          }
          handlers.onDropNodeToTarget(nodeId, snapshot.cloneLaunchMode === 'manufacturing' ? null : undefined)
        }}
      >
        <StructureTableShell
          rows={visibleTargetRows}
          snapshot={snapshot}
          structureContext={structureContext}
          handlers={handlers}
          sourceSide={false}
          emptyMessage={snapshot.showCommitErrorsOnly ? 'No failed rows to display.' : 'Drop rows here to stage BOM clone entries.'}
        />
        <div style={{ minHeight: '60px' }} aria-hidden="true" />
      </div>
    </section>
  )
}
