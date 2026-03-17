import { describe, it, expect } from 'vitest'
import type { BomCloneNode } from '../../clone.types'
import {
  isPartNode,
  buildDuplicatePlan,
  countDuplicateOperations,
} from '../deepDuplicate.service'

function makeNode(overrides: Partial<BomCloneNode> = {}): BomCloneNode {
  return {
    id: '1',
    label: 'Test Item',
    number: 'AS-001',
    itemNumber: '1.1',
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

describe('isPartNode', () => {
  it('returns true when number starts with 99', () => {
    expect(isPartNode(makeNode({ number: '99-001' }))).toBe(true)
  })

  it('returns true when number is exactly 99', () => {
    expect(isPartNode(makeNode({ number: '99' }))).toBe(true)
  })

  it('returns false when number does not start with 99', () => {
    expect(isPartNode(makeNode({ number: 'AS-001' }))).toBe(false)
  })

  it('returns false when number is empty', () => {
    expect(isPartNode(makeNode({ number: '' }))).toBe(false)
  })

  it('returns false when number is a large integer (v1 API fallback)', () => {
    expect(isPartNode(makeNode({ number: '123456' }))).toBe(false)
  })

  it('is case-insensitive and trims whitespace', () => {
    expect(isPartNode(makeNode({ number: '  99-abc  ' }))).toBe(true)
  })
})

describe('buildDuplicatePlan', () => {
  it('marks non-part node as duplicate', () => {
    const node = makeNode({ number: 'BLD-001' })
    const [plan] = buildDuplicatePlan([node])
    expect(plan.kind).toBe('duplicate')
    expect(plan.sourceNode).toBe(node)
  })

  it('marks part node as reference', () => {
    const node = makeNode({ number: '99-001' })
    const [plan] = buildDuplicatePlan([node])
    expect(plan.kind).toBe('reference')
  })

  it('recursively classifies children', () => {
    const part = makeNode({ id: '2', number: '99-001' })
    const assembly = makeNode({
      id: '1',
      number: 'SUB-001',
      children: [part],
      hasExpandableChildren: true,
      childrenLoaded: true,
    })
    const [plan] = buildDuplicatePlan([assembly])
    expect(plan.kind).toBe('duplicate')
    expect(plan.children[0].kind).toBe('reference')
  })

  it('returns empty array for empty input', () => {
    expect(buildDuplicatePlan([])).toEqual([])
  })
})

describe('countDuplicateOperations', () => {
  it('counts only duplicate nodes', () => {
    const part = makeNode({ id: '2', number: '99-001' })
    const sub = makeNode({
      id: '3',
      number: 'SUB-001',
      children: [part],
      childrenLoaded: true,
    })
    const building = makeNode({
      id: '1',
      number: 'BLD-001',
      children: [sub],
      childrenLoaded: true,
    })
    const plan = buildDuplicatePlan([building])
    // building + sub = 2 duplicates, part = 1 reference
    expect(countDuplicateOperations(plan)).toBe(2)
  })

  it('returns 0 for all-reference plan', () => {
    const plan = buildDuplicatePlan([makeNode({ number: '99-001' })])
    expect(countDuplicateOperations(plan)).toBe(0)
  })
})
