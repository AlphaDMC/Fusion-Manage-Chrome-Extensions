import React, { useMemo } from 'react'
import type { BomCloneStateSnapshot } from '../../clone.types'
import {
  buildStructureViewModel,
  type CloneStructureViewModel
} from '../../services/viewModel.service'
import { CloneEditPanel } from './EditPanel'
import { CloneSourcePane, CloneTargetPane } from '../structure/StructurePanes'
import { applyRequiredIndicator, type CloneStructureHandlers } from '../structure/structure.rows.view'
import { DeepDuplicatePanel, type DeepDuplicatePanelHandlers } from './DeepDuplicatePanel'

export { buildOperationCounts, buildRequiredWarningSummary } from '../../services/viewModel.service'
export type { CloneStructureHandlers } from '../structure/structure.rows.view'

/**
 * Review guide:
 *
 * This file is the React entry point for the BOM structure phase.
 *
 * React now owns the phase layout, pane chrome, and edit panel composition
 * here, while the row renderer still bridges the drag/drop-heavy table body.
 * Keeping that bridge local to this file makes the root BOM view easier to
 * read and gives us one place to continue shrinking the remaining structure UI
 * hybrid safely.
 */
export type CloneStructurePhaseContentProps = {
  modalRoot: HTMLDivElement
  snapshot: BomCloneStateSnapshot
  handlers: CloneStructureHandlers
  deepDuplicateHandlers: DeepDuplicatePanelHandlers
}

export function CloneStructurePhaseContent(props: CloneStructurePhaseContentProps): React.JSX.Element {
  const { modalRoot, snapshot, handlers } = props
  const structureContext = useMemo<CloneStructureViewModel>(() => buildStructureViewModel(snapshot), [snapshot])

  return (
    <>
      <p className="plm-extension-bom-clone-description">
        Drag BOM rows from the left and drop them into the right table to prepare clone items.
      </p>
      <div className={`plm-extension-bom-structure-content${snapshot.editingNodeId ? ' is-editing' : ''}`}>
        <CloneSourcePane snapshot={snapshot} structureContext={structureContext} handlers={handlers} />
        <CloneTargetPane snapshot={snapshot} structureContext={structureContext} handlers={handlers} />
        <CloneEditPanel
          modalRoot={modalRoot}
          snapshot={snapshot}
          handlers={handlers}
          applyRequiredIndicator={applyRequiredIndicator}
        />
      </div>
      <DeepDuplicatePanel
        snapshot={snapshot}
        handlers={props.deepDuplicateHandlers}
      />
    </>
  )
}



