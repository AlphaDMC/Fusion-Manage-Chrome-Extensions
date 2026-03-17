import { describe, it, expect, vi, type MockedFunction } from 'vitest'
import { createMutateApi } from '../api/mutate'
import type { ApiClient } from '../api/client'
import type { CloneService } from '../service.contract'
import type { DuplicatePlanNode } from '../deepDuplicate.service'
import type { BomCloneContext, BomCloneNode } from '../../clone.types'

function makeContext(): BomCloneContext {
  return {
    tenant: 'test-tenant',
    workspaceId: 241,
    currentItemId: 1000,
    viewId: 1,
    viewDefId: null,
  }
}

function makeSourceNode(id: string, number: string, quantity = '1', children: BomCloneNode[] = []): BomCloneNode {
  return {
    id,
    label: `Item ${id}`,
    number,
    itemNumber: '1.1',
    iconHtml: '',
    revision: 'A',
    status: 'Released',
    quantity,
    unitOfMeasure: 'EA',
    hasExpandableChildren: children.length > 0,
    childrenLoaded: true,
    children,
  }
}

function makeNode(id: string, number: string, quantity = '1', children: DuplicatePlanNode[] = []): DuplicatePlanNode {
  return {
    sourceNode: makeSourceNode(id, number, quantity, children.map((c) => c.sourceNode)),
    kind: number.startsWith('99') ? 'reference' : 'duplicate',
    children,
  }
}

function makeClient(): ApiClient {
  return {
    getBom: vi.fn().mockResolvedValue({}),
    getBomV1: vi.fn().mockResolvedValue({}),
    getBomViews: vi.fn().mockResolvedValue({}),
    fetchFields: vi.fn().mockResolvedValue({}),
    fetchSections: vi.fn().mockResolvedValue([{ title: 'Basic', fields: [] }]),
    createItem: vi.fn().mockResolvedValue({ headers: { location: '/api/v3/workspaces/241/items/9999' } }),
    getItemDetails: vi.fn().mockResolvedValue({}),
    fetchBomLinkableItems: vi.fn().mockResolvedValue({}),
    addBomItem: vi.fn().mockResolvedValue({ ok: true }),
    updateBomItem: vi.fn().mockResolvedValue({ ok: true }),
    removeBomItem: vi.fn().mockResolvedValue({ ok: true }),
  }
}

function makeFetchItemFieldsForCopy(): MockedFunction<CloneService['fetchItemFieldsForCopy']> {
  return vi.fn().mockResolvedValue([
    { fieldId: 'TITLE', value: 'Copied Title' },
  ])
}

describe('deepDuplicateSubtree — reference node', () => {
  it('returns the original item ID without creating a new item', async () => {
    const client = makeClient()
    const fetchItemFieldsForCopy = makeFetchItemFieldsForCopy()
    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy })

    const plan = makeNode('12345', '99-001')
    const context = makeContext()

    const result = await mutateApi.deepDuplicateSubtree(context, plan, 'PRJ-001')

    expect(result).toBe(12345)
    expect(client.createItem).not.toHaveBeenCalled()
    expect(fetchItemFieldsForCopy).not.toHaveBeenCalled()
  })

  it('does not call fetchSections for a reference node', async () => {
    const client = makeClient()
    const fetchItemFieldsForCopy = makeFetchItemFieldsForCopy()
    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy })

    const plan = makeNode('55555', '99-XYZ')
    await mutateApi.deepDuplicateSubtree(makeContext(), plan, 'PRJ-001')

    expect(client.fetchSections).not.toHaveBeenCalled()
  })

  it('throws when reference node id is not a valid number', async () => {
    const client = makeClient()
    const fetchItemFieldsForCopy = makeFetchItemFieldsForCopy()
    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy })

    const plan: DuplicatePlanNode = {
      sourceNode: makeSourceNode('not-a-number', '99-001'),
      kind: 'reference',
      children: [],
    }

    await expect(
      mutateApi.deepDuplicateSubtree(makeContext(), plan, 'PRJ-001')
    ).rejects.toThrow()
  })
})

describe('deepDuplicateSubtree — duplicate node (no children)', () => {
  it('creates a new item with copied fields plus project reference', async () => {
    const client = makeClient()
    const fetchItemFieldsForCopy = makeFetchItemFieldsForCopy()
    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy })

    const plan = makeNode('5000', 'SUB-001')
    const context = makeContext()

    const newId = await mutateApi.deepDuplicateSubtree(context, plan, 'PRJ-001')

    expect(newId).toBe(9999) // resolved from location header '/items/9999'
    expect(fetchItemFieldsForCopy).toHaveBeenCalledWith(context, 5000)
    expect(client.createItem).toHaveBeenCalledOnce()

    const createCall = (client.createItem as MockedFunction<ApiClient['createItem']>).mock.calls[0][0]
    // Item number should be suffixed with the sanitized project ID (PRJ001 from PRJ-001)
    expect(createCall.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldId: 'DESCRIPTOR', value: 'SUB-001PRJ001' }),
      ])
    )
    expect(client.addBomItem).not.toHaveBeenCalled() // no children
  })

  it('calls fetchSections with correct tenant and workspaceId', async () => {
    const client = makeClient()
    const fetchItemFieldsForCopy = makeFetchItemFieldsForCopy()
    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy })

    const context = makeContext()
    const plan = makeNode('5001', 'SUB-002')

    await mutateApi.deepDuplicateSubtree(context, plan, 'PRJ-001')

    expect(client.fetchSections).toHaveBeenCalledWith({
      tenant: 'test-tenant',
      workspaceId: 241,
    })
  })

  it('uses unmodified source number when projectId is blank', async () => {
    const client = makeClient()
    const fetchItemFieldsForCopy = makeFetchItemFieldsForCopy()
    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy })

    const plan = makeNode('5002', 'SUB-003')
    await mutateApi.deepDuplicateSubtree(makeContext(), plan, '  ')

    const createCall = (client.createItem as MockedFunction<ApiClient['createItem']>).mock.calls[0][0]
    // With blank projectId, the number should remain as source number (no suffix)
    expect(createCall.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldId: 'DESCRIPTOR', value: 'SUB-003' })])
    )
  })

  it('passes sections from fetchSections to createItem', async () => {
    const sections = [{ title: 'General', fields: ['TITLE'] }, { title: 'Details', fields: [] }]
    const client = {
      ...makeClient(),
      fetchSections: vi.fn().mockResolvedValue(sections),
    } as unknown as ApiClient

    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy: makeFetchItemFieldsForCopy() })
    const plan = makeNode('5004', 'SUB-005')

    await mutateApi.deepDuplicateSubtree(makeContext(), plan, 'PRJ-001')

    const createCall = (client.createItem as MockedFunction<ApiClient['createItem']>).mock.calls[0][0]
    expect(createCall.sections).toEqual(sections)
  })

  it('resolves item id from nested headers.location', async () => {
    const client = {
      ...makeClient(),
      createItem: vi.fn().mockResolvedValue({ headers: { location: '/api/v3/workspaces/241/items/7777' } }),
    } as unknown as ApiClient

    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy: makeFetchItemFieldsForCopy() })
    const plan = makeNode('6000', 'SUB-006')

    const newId = await mutateApi.deepDuplicateSubtree(makeContext(), plan, 'PRJ-001')
    expect(newId).toBe(7777)
  })

  it('resolves item id from top-level location string property', async () => {
    const client = {
      ...makeClient(),
      createItem: vi.fn().mockResolvedValue({ location: '/api/v3/workspaces/241/items/8888' }),
    } as unknown as ApiClient

    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy: makeFetchItemFieldsForCopy() })
    const plan = makeNode('6001', 'SUB-007')

    const newId = await mutateApi.deepDuplicateSubtree(makeContext(), plan, 'PRJ-001')
    expect(newId).toBe(8888)
  })
})

describe('deepDuplicateSubtree — duplicate node with mixed children', () => {
  it('creates new items for duplicates and references originals for parts', async () => {
    const partPlan = makeNode('99001', '99-001', '2')
    const subPlan = makeNode('5001', 'SUB-002', '1')

    let createCallCount = 0
    const client = {
      ...makeClient(),
      createItem: vi.fn().mockImplementation(() => {
        createCallCount++
        const id = 9000 + createCallCount
        return Promise.resolve({ headers: { location: `/api/v3/workspaces/241/items/${id}` } })
      }),
    } as unknown as ApiClient

    const fetchItemFieldsForCopy = makeFetchItemFieldsForCopy()
    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy })

    const parentPlan = makeNode('4000', 'BLD-001', '1', [partPlan, subPlan])
    const context = makeContext()

    const newParentId = await mutateApi.deepDuplicateSubtree(context, parentPlan, 'PRJ-001')

    // Parent was created first (id 9001), then sub (id 9002)
    expect(newParentId).toBe(9001)
    expect(createCallCount).toBe(2) // parent + sub; part is referenced, not created

    // addBomItem called twice: once for part (99001), once for new sub (9002)
    expect(client.addBomItem).toHaveBeenCalledTimes(2)

    const addCalls = (client.addBomItem as MockedFunction<ApiClient['addBomItem']>).mock.calls
    // First child (part) linked with original ID 99001
    expect(addCalls[0][0]).toMatchObject({ dmsIdChild: 99001, dmsIdParent: 9001, number: 1 })
    // Second child (sub) linked with new ID 9002
    expect(addCalls[1][0]).toMatchObject({ dmsIdChild: 9002, dmsIdParent: 9001, number: 2 })
  })

  it('passes correct quantity and workspace IDs to addBomItem', async () => {
    let createCallCount = 0
    const client = {
      ...makeClient(),
      createItem: vi.fn().mockImplementation(() => {
        createCallCount++
        return Promise.resolve({ headers: { location: `/api/v3/workspaces/241/items/${9000 + createCallCount}` } })
      }),
    } as unknown as ApiClient

    const fetchItemFieldsForCopy = makeFetchItemFieldsForCopy()
    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy })

    const childPlan = makeNode('6100', 'SUB-100', '3')
    const parentPlan = makeNode('6000', 'BLD-100', '1', [childPlan])
    const context = makeContext()

    await mutateApi.deepDuplicateSubtree(context, parentPlan, 'PRJ-001')

    const addCall = (client.addBomItem as MockedFunction<ApiClient['addBomItem']>).mock.calls[0][0]
    expect(addCall).toMatchObject({
      tenant: 'test-tenant',
      wsIdParent: 241,
      wsIdChild: 241,
      quantity: '3',
    })
  })

  it('recursively creates items for deeply nested duplicate nodes', async () => {
    let createCallCount = 0
    const client = {
      ...makeClient(),
      createItem: vi.fn().mockImplementation(() => {
        createCallCount++
        return Promise.resolve({ headers: { location: `/api/v3/workspaces/241/items/${9000 + createCallCount}` } })
      }),
    } as unknown as ApiClient

    const fetchItemFieldsForCopy = makeFetchItemFieldsForCopy()
    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy })

    // grandchild → child → parent (all duplicates)
    const grandchildPlan = makeNode('1001', 'COMP-001')
    const childPlan = makeNode('1002', 'SUB-001', '1', [grandchildPlan])
    const parentPlan = makeNode('1003', 'BLD-001', '1', [childPlan])

    await mutateApi.deepDuplicateSubtree(makeContext(), parentPlan, 'PRJ-001')

    // parent (9001) + child (9002) + grandchild (9003) = 3 items created
    expect(createCallCount).toBe(3)
    expect(client.addBomItem).toHaveBeenCalledTimes(2) // child under parent, grandchild under child
  })

  it('does not call addBomItem when node has no children', async () => {
    const client = makeClient()
    const fetchItemFieldsForCopy = makeFetchItemFieldsForCopy()
    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy })

    const plan = makeNode('7000', 'LEAF-001')
    await mutateApi.deepDuplicateSubtree(makeContext(), plan, 'PRJ-001')

    expect(client.addBomItem).not.toHaveBeenCalled()
  })
})
