import { describe, expect, it } from 'vitest'
import type { BomCloneNode, BomCloneStateSnapshot } from '../../clone.types'
import { resolveQuantityFallbackForNode } from '../structure/structure.service'

function makeNode(overrides: Partial<BomCloneNode> = {}): BomCloneNode {
  return {
    id: 'node-1',
    label: 'Node 1',
    number: 'A-001',
    itemNumber: '1',
    iconHtml: '',
    revision: 'A',
    status: 'Released',
    quantity: '',
    unitOfMeasure: 'EA',
    hasExpandableChildren: false,
    childrenLoaded: true,
    children: [],
    ...overrides,
  }
}

describe('resolveQuantityFallbackForNode', () => {
  it('defaults staged rows without a source quantity to 1.0', () => {
    const snapshot = {
      targetBomTree: [],
      sourceBomTree: [makeNode()],
    } as unknown as BomCloneStateSnapshot

    expect(resolveQuantityFallbackForNode(snapshot, 'node-1')).toBe('1.0')
  })

  it('preserves an existing quantity when present', () => {
    const snapshot = {
      targetBomTree: [makeNode({ quantity: '3.5' })],
      sourceBomTree: [],
    } as unknown as BomCloneStateSnapshot

    expect(resolveQuantityFallbackForNode(snapshot, 'node-1')).toBe('3.5')
  })
})
