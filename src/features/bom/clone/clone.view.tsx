import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BomCloneStateSnapshot } from './clone.types'
import type { ItemSelectorSearchFilterPatch } from '../../../shared/item-selector/types'
import { buildStructureViewModel, type CloneStructureViewModel } from './services/viewModel.service'
import { CloneSearchPhaseContent } from './view/phases/SearchPhase'
import type { CloneStructureHandlers } from './view/phases/StructurePhase'
import { CloneFooter } from './view/shell/CloneFooter'
import {
  CloneBodyOverlays,
  showActionConfirm,
  showSplitQuantityDialogModal,
  type SplitQuantityDialogOptions
} from './view/dialogs/CloneDialogs'
import {
  applyPanelShellStyles,
  ClonePhaseLoader,
  CloneSearchModeToggle,
  CloneShellHeader
} from './view/shell/CloneShell'

type CloneViewHandlers = {
  onSearchInput: (value: string) => void
  onToggleAdvancedMode: (nextAdvancedMode: boolean) => void
  onGroupLogicExpressionChange: (value: string) => void
  onSearchSubmit: () => void
  onSelectResult: (itemId: number) => void
  onLoadItemDetails: (itemId: number) => void
  onCloseDetails: () => void
  onLoadMoreResults: () => void
  onValidateSelection: () => void
  onToggleNode: (nodeId: string, selected: boolean) => void
  onToggleSourceNodeExpanded: (nodeId: string) => void
  onSetSourceStatusFilter: (value: BomCloneStateSnapshot['sourceStatusFilter']) => void
  onToggleTargetNodeExpanded: (nodeId: string) => void
  onExpandAllSource: () => void
  onCollapseAllSource: () => void
  onExpandAllTarget: () => void
  onCollapseAllTarget: () => void
  onSelectManufacturingOperation: (nodeId: string) => void
  onSelectManufacturingRoot: () => void
  onAddOperation: () => void
  onToggleShowCommitErrorsOnly: () => void
  onOpenLinkableDialog: () => void
  onCloseLinkableDialog: () => void
  onLinkableSearchInput: (value: string) => void
  onToggleLinkableItem: (itemId: number, selected: boolean) => void
  onToggleLinkableDisplayOnlySelected: () => void
  onToggleLinkableShowOnlyErrors: () => void
  onLinkableDialogScrollNearEnd: () => void
  onClearLinkableSelection: () => void
  onResizeLinkableColumn: (column: 'item' | 'workspace' | 'lifecycle', width: number) => void
  onAddSelectedLinkableItems: () => void
  onDropNodeToTarget: (nodeId: string, targetOperationNodeId?: string | null) => void
  onDropSourceAssemblySubcomponentsToTarget: (nodeId: string) => void
  onSplitSourceNode: (nodeId: string) => void
  onAddRemainingSourceNode: (nodeId: string) => void
  onRemoveTargetNode: (nodeId: string) => void
  onSplitTargetNode: (nodeId: string) => void
  onEditTargetItemNumber: (nodeId: string, value: string) => void
  onEditTargetQuantity: (nodeId: string, value: string) => void
  onReorderTargetNode: (draggedNodeId: string, targetNodeId: string, placement: 'before' | 'after' | 'inside') => void
  onOpenProcessItemDetails: (nodeId: string) => void
  onOpenProcessBomDetails: (nodeId: string) => void
  onToggleSearchField: (fieldId: string, selected: boolean) => void
  onChangeSearchFilter: (
    groupId: string,
    filterId: string,
    patch: ItemSelectorSearchFilterPatch
  ) => void
  onAddGroup: () => void
  onRemoveGroup: (groupId: string) => void
  onAddFilterRow: (groupId: string) => void
  onRemoveFilterRow: (groupId: string, filterId: string) => void
  onClose: () => void
  onResetTarget: () => void
  onCommitClone: () => void
  onCloseCommitErrors: () => void
  onToggleDeepDuplicate: (enabled: boolean) => void
  onProjectIdChange: (value: string) => void
  onEditNode: (nodeId: string) => void
  onCloseEditPanel: (options?: { discardDraft?: boolean }) => void
  onSaveEditPanel: (nodeId: string, values: Record<string, string>) => void
  onToggleEditPanelRequiredOnly: (value: boolean) => void
}

type CloneView = {
  showCancelConfirm: (modalRoot: HTMLDivElement, stagedCount: number) => Promise<boolean>
  showResetConfirm: (modalRoot: HTMLDivElement, stagedCount: number) => Promise<boolean>
  showSplitQuantityDialog: (
    modalRoot: HTMLDivElement,
    options: SplitQuantityDialogOptions
  ) => Promise<{ destinationOperationNodeId: string; splitQuantity: string } | null>
  render: (modalRoot: HTMLDivElement, snapshot: BomCloneStateSnapshot, handlers: CloneViewHandlers) => void
}

type StructureViewRuntime = typeof import('./view/phases/StructurePhase')
type LinkableDialogRuntime = typeof import('./view/dialogs/LinkableDialog')

type RuntimeContext = {
  structureViewRuntime: StructureViewRuntime | null
  linkableDialogRuntime: LinkableDialogRuntime | null
  ensureStructureViewRuntime: () => void
  ensureLinkableDialogRuntime: () => void
}

/**
 * Review guide:
 *
 * This root is now the BOM modal composition layer. It selects the active
 * phase, wires lazy UI runtimes, and delegates the modal chrome, footer, and
 * dialogs to focused React view modules.
 */

function ClonePhaseContent(props: {
  modalRoot: HTMLDivElement | null
  snapshot: BomCloneStateSnapshot
  handlers: CloneViewHandlers
  runtimeContext: RuntimeContext
}): React.JSX.Element {
  const { modalRoot, snapshot, handlers, runtimeContext } = props

  if (snapshot.clonePhase === 'validation') {
    return <ClonePhaseLoader label={snapshot.validationStatusLines[0] || 'Loading Bill of Materials'} />
  }

  if (snapshot.clonePhase === 'search') {
    return <CloneSearchPhaseContent snapshot={snapshot} handlers={handlers} />
  }

  if (snapshot.clonePhase === 'structure' && runtimeContext.structureViewRuntime && modalRoot) {
    const StructureRuntime = runtimeContext.structureViewRuntime
    return (
      <StructureRuntime.CloneStructurePhaseContent
        modalRoot={modalRoot}
        snapshot={snapshot}
        handlers={handlers as CloneStructureHandlers}
        deepDuplicateHandlers={{
          onToggleDeepDuplicate: handlers.onToggleDeepDuplicate,
          onProjectIdChange: handlers.onProjectIdChange,
        }}
      />
    )
  }

  return <ClonePhaseLoader label="Loading Bill of Materials" />
}

function CloneModalShell(props: {
  snapshot: BomCloneStateSnapshot
  handlers: CloneViewHandlers
  runtimeContext: RuntimeContext
}): React.JSX.Element {
  const { snapshot, handlers, runtimeContext } = props
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [modalRoot, setModalRoot] = useState<HTMLDivElement | null>(null)
  const [isExpanded, setIsExpanded] = useState(false)
  const structureContextForFooter = useMemo<CloneStructureViewModel | null>(() => {
    if (snapshot.clonePhase !== 'structure' || !runtimeContext.structureViewRuntime) return null
    return buildStructureViewModel(snapshot)
  }, [snapshot, runtimeContext.structureViewRuntime])

  useEffect(() => {
    const host = hostRef.current
    const panel = host?.parentElement
    if (!(panel instanceof HTMLDivElement)) return
    setIsExpanded(panel.dataset.plmExpanded === 'true')
    const nextModalRoot = panel.parentElement
    if (nextModalRoot instanceof HTMLDivElement) setModalRoot(nextModalRoot)
  }, [])

  useEffect(() => {
    const panel = hostRef.current?.parentElement
    if (!(panel instanceof HTMLDivElement)) return
    applyPanelShellStyles(panel, isExpanded)
  }, [isExpanded])

  useEffect(() => {
    if (snapshot.clonePhase !== 'structure' || runtimeContext.structureViewRuntime) return
    runtimeContext.ensureStructureViewRuntime()
  }, [snapshot.clonePhase, runtimeContext])

  const launchModeTitle = snapshot.cloneLaunchMode === 'manufacturing' ? 'Manufacturing' : 'Engineering'

  return (
    <div
      ref={hostRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 auto',
        minHeight: '0',
        position: 'relative'
      }}
    >
      <CloneShellHeader
        title={`Create ${launchModeTitle} Bill of Materials`}
        isExpanded={isExpanded}
        onToggleExpanded={() => setIsExpanded((current) => !current)}
      />
      <p className="plm-extension-bom-clone-description">
        Find a source item, validate compatibility, and prepare nodes to clone into the current BOM.
      </p>
      {snapshot.clonePhase === 'search' ? (
        <CloneSearchModeToggle
          advancedMode={snapshot.advancedMode}
          onToggleAdvancedMode={handlers.onToggleAdvancedMode}
        />
      ) : null}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: '1 1 auto',
          minHeight: '0',
          position: 'relative'
        }}
      >
        <ClonePhaseContent
          modalRoot={modalRoot}
          snapshot={snapshot}
          handlers={handlers}
          runtimeContext={runtimeContext}
        />
        <CloneBodyOverlays
          modalRoot={modalRoot}
          snapshot={snapshot}
          structureContext={structureContextForFooter}
          handlers={handlers}
          linkableDialogRuntime={runtimeContext.linkableDialogRuntime}
          ensureLinkableDialogRuntime={runtimeContext.ensureLinkableDialogRuntime}
        />
      </div>
      {snapshot.errorMessage ? (
        <p className="plm-extension-bom-clone-error">{snapshot.errorMessage}</p>
      ) : null}
      <CloneFooter
        snapshot={snapshot}
        handlers={handlers}
        structureContext={structureContextForFooter}
      />
    </div>
  )
}

export function createCloneView(requestRender: () => void): CloneView {
  let structureViewRuntime: StructureViewRuntime | null = null
  let structureViewRuntimePromise: Promise<StructureViewRuntime> | null = null
  let linkableDialogRuntime: LinkableDialogRuntime | null = null
  let linkableDialogRuntimePromise: Promise<LinkableDialogRuntime> | null = null
  const modalRoots = new WeakMap<HTMLDivElement, Root>()

  function ensureStructureViewRuntime(): void {
    if (structureViewRuntime || structureViewRuntimePromise) return
    structureViewRuntimePromise = import('./view/phases/StructurePhase')
      .then((module) => {
        structureViewRuntime = module
        return module
      })
      .finally(() => {
        structureViewRuntimePromise = null
        requestRender()
      })
  }

  function ensureLinkableDialogRuntime(): void {
    if (linkableDialogRuntime || linkableDialogRuntimePromise) return
    linkableDialogRuntimePromise = import('./view/dialogs/LinkableDialog')
      .then((module) => {
        linkableDialogRuntime = module
        return module
      })
      .finally(() => {
        linkableDialogRuntimePromise = null
        requestRender()
      })
  }

  return {
    showCancelConfirm(modalRoot, stagedCount) {
      const noun = stagedCount === 1 ? 'staged result' : 'staged results'
      return showActionConfirm(modalRoot, {
        title: 'Discard Staged Changes?',
        message: `Are you sure you want to cancel? You have ${stagedCount} ${noun}.`,
        confirmLabel: 'Discard and Close',
        cancelLabel: 'Keep Editing'
      })
    },
    showResetConfirm(modalRoot, stagedCount) {
      const noun = stagedCount === 1 ? 'staged result' : 'staged results'
      return showActionConfirm(modalRoot, {
        title: 'Reset Target?',
        message: `Are you sure you want to reset? This will discard ${stagedCount} ${noun} and restore the original target BOM.`,
        confirmLabel: 'Reset Target',
        cancelLabel: 'Keep Editing'
      })
    },
    showSplitQuantityDialog(modalRoot, options) {
      return showSplitQuantityDialogModal(modalRoot, options)
    },
    render(modalRoot, snapshot, handlers) {
      const panel = modalRoot.querySelector('div')
      if (!panel) return
      let root = modalRoots.get(panel)
      if (!root) {
        root = createRoot(panel)
        modalRoots.set(panel, root)
      }

      root.render(
        <CloneModalShell
          snapshot={snapshot}
          handlers={handlers}
          runtimeContext={{
            structureViewRuntime,
            linkableDialogRuntime,
            ensureStructureViewRuntime,
            ensureLinkableDialogRuntime
          }}
        />
      )
    }
  }
}
