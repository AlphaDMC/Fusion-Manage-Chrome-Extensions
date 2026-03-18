import React from 'react'
import type { BomCloneStateSnapshot } from '../../clone.types'
import { buildDuplicatePlan, countDuplicateOperations } from '../../services/deepDuplicate.service'

export type DeepDuplicatePanelHandlers = {
  onToggleDeepDuplicate: (enabled: boolean) => void
  onProjectIdChange: (value: string) => void
}

export type DeepDuplicatePanelProps = {
  snapshot: BomCloneStateSnapshot
  handlers: DeepDuplicatePanelHandlers
}

function countRefNodes(nodes: ReturnType<typeof buildDuplicatePlan>): number {
  let n = 0
  for (const node of nodes) {
    if (node.kind === 'reference') n += 1
    n += countRefNodes(node.children)
  }
  return n
}

export function DeepDuplicatePanel(props: DeepDuplicatePanelProps): React.JSX.Element {
  const { snapshot, handlers } = props

  const stagedNodes = snapshot.targetBomTree
  const plan = buildDuplicatePlan(stagedNodes)
  const duplicateCount = countDuplicateOperations(plan)
  const totalRefCount = countRefNodes(plan)
  const sanitizedPreview = snapshot.projectId.replace(/[^a-zA-Z0-9]/g, '')

  return (
    <div
      className="plm-extension-deep-dup-panel"
      style={{
        borderTop: '1px solid #d8e1eb',
        padding: '10px 0 6px',
        marginTop: '8px',
        fontFamily: '"ArtifaktElement","Segoe UI",Arial,sans-serif',
        fontSize: '13px',
      }}
    >
      <label
        style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 600, color: '#19222e' }}
      >
        <input
          type="checkbox"
          checked={snapshot.deepDuplicateEnabled}
          onChange={(e) => handlers.onToggleDeepDuplicate(e.target.checked)}
          style={{ width: '15px', height: '15px' }}
        />
        Enable deep duplication (copy assemblies, reference parts)
      </label>

      {snapshot.deepDuplicateEnabled && (
        <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxWidth: '320px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: '#526176', letterSpacing: '0.03em' }}>
              Project ID
            </span>
            <input
              type="text"
              value={snapshot.projectId}
              onChange={(e) => handlers.onProjectIdChange(e.target.value)}
              placeholder="e.g. PRJ-2026-001"
              style={{
                height: '32px',
                padding: '0 10px',
                border: '1px solid #cfd8e3',
                borderRadius: '8px',
                fontSize: '12px',
                width: '100%',
                boxSizing: 'border-box',
              }}
            />
            {snapshot.projectId && sanitizedPreview && (
              <span style={{ fontSize: '11px', color: '#526176' }}>
                Item numbers will be suffixed with <strong>-{sanitizedPreview}</strong>
              </span>
            )}
          </label>

          {stagedNodes.length > 0 && (
            <p style={{ margin: 0, color: '#384456', fontSize: '12px' }}>
              <strong>{duplicateCount}</strong> item{duplicateCount !== 1 ? 's' : ''} will be duplicated
              {totalRefCount > 0 && (
                <>, <strong>{totalRefCount}</strong> part{totalRefCount !== 1 ? 's' : ''} will be referenced</>
              )}
              .
            </p>
          )}

          {!snapshot.projectId.trim() && (
            <p style={{ margin: 0, color: '#F9A825', fontSize: '12px' }}>
              ⚠ Enter a Project ID to generate unique item numbers for duplicated items.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
