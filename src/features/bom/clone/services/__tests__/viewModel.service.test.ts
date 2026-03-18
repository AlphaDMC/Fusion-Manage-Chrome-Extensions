import { describe, expect, it } from 'vitest'
import { buildOperationCounts } from '../viewModel.service'
import type { BomCloneNode, BomCloneStateSnapshot } from '../../clone.types'

function makeNode(overrides: Partial<BomCloneNode> = {}): BomCloneNode {
  return {
    id: '1',
    label: 'Node 1',
    number: 'A-001',
    itemNumber: '1',
    iconHtml: '',
    revision: 'A',
    status: 'Released',
    quantity: '1',
    unitOfMeasure: 'EA',
    hasExpandableChildren: false,
    childrenLoaded: true,
    children: [],
    ...overrides,
  }
}

describe('buildOperationCounts', () => {
  it('does not count staged source rows as updates just because they carry a source bomEdgeId', () => {
    const snapshot = {
      targetMarkedForDeleteNodeIds: [],
      targetItemNumberOverrides: {},
      targetQuantityOverrides: {},
      targetFieldOverrides: {
        staged: {
          TITLE: 'Changed',
        },
      },
      bomViewFieldMetaLinks: {
        TITLE: '/api/v3/workspaces/241/views/1/fields/TITLE',
      },
      bomViewFields: [],
    } as unknown as BomCloneStateSnapshot

    const stagedRow = {
      id: 'staged',
      level: 0,
      hasChildren: false,
      expanded: false,
      node: makeNode({
        id: 'staged',
        bomEdgeId: 'source-edge-1',
      }),
    }

    const counts = buildOperationCounts(snapshot, {
      existingTopLevelNodeIds: new Set<string>(),
      stagedTopLevelNodeIds: new Set<string>(['staged']),
      selectedRows: [stagedRow],
      selectedNodeIds: new Set<string>(['staged']),
      targetExistingNodeIds: new Set<string>(),
    })

    expect(counts.addCount).toBe(1)
    expect(counts.updateCount).toBe(0)
  })
})
