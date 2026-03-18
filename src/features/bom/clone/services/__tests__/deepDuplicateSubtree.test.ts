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
    addBomItem: vi.fn().mockResolvedValue({ data: true, status: 200 }),
    updateBomItem: vi.fn().mockResolvedValue({ data: true, status: 200 }),
    removeBomItem: vi.fn().mockResolvedValue({ data: true, status: 200 }),
  }
}

function makeFetchItemFieldsForCopy(itemNumber?: string): MockedFunction<CloneService['fetchItemFieldsForCopy']> {
  return vi.fn().mockResolvedValue([
    { fieldId: 'NUMBER', value: itemNumber ?? 'SUB-001' },
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
        expect.objectContaining({ fieldId: 'NUMBER', value: 'SUB-001-PRJ001' }),
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
    const fetchItemFieldsForCopy = makeFetchItemFieldsForCopy('SUB-003')
    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy })

    const plan = makeNode('5002', 'SUB-003')
    await mutateApi.deepDuplicateSubtree(makeContext(), plan, '  ')

    const createCall = (client.createItem as MockedFunction<ApiClient['createItem']>).mock.calls[0][0]
    // With blank projectId, the NUMBER field should remain unchanged (no suffix)
    expect(createCall.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldId: 'NUMBER', value: 'SUB-003' })])
    )
    expect(createCall.fields).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldId: 'DESCRIPTOR' })])
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

  it('uses the original child itemLink when a V1 child is reclassified as a reference part', async () => {
    let createCallCount = 0
    const client = {
      ...makeClient(),
      createItem: vi.fn().mockImplementation(() => {
        createCallCount++
        return Promise.resolve({ headers: { location: `/api/v3/workspaces/241/items/${9000 + createCallCount}` } })
      }),
    } as unknown as ApiClient

    const fetchItemFieldsForCopy = vi.fn().mockImplementation(async (_context, itemId) => {
      if (itemId === 6000) {
        return [
          { fieldId: 'NUMBER', value: 'BLD-100' },
          { fieldId: 'TITLE', value: 'Parent' },
        ]
      }
      if (itemId === 402865) {
        return [
          { fieldId: 'NUMBER', value: '99993125' },
          { fieldId: 'TITLE', value: 'Referenced Part' },
        ]
      }
      throw new Error(`Unexpected itemId: ${itemId}`)
    }) as MockedFunction<CloneService['fetchItemFieldsForCopy']>
    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>).mockResolvedValue({
      data: {
        items: [
          {
            item: {
              id: 402865,
              link: '/api/v3/workspaces/998/items/402865',
            },
          },
        ],
      },
    })
    ;(client.getItemDetails as MockedFunction<ApiClient['getItemDetails']>).mockResolvedValue({
      __self__: '/api/v3/workspaces/998/items/402865',
    })

    const childPlan: DuplicatePlanNode = {
      sourceNode: makeSourceNode('402865', '402865', '2'),
      kind: 'duplicate',
      children: [],
    }
    childPlan.sourceNode.itemLink = '/api/v3/workspaces/998/items/402865'

    const parentPlan = makeNode('6000', 'BLD-100', '1', [childPlan])

    await createMutateApi({ client, fetchItemFieldsForCopy }).deepDuplicateSubtree(makeContext(), parentPlan, 'PRJ-001')

    expect(createCallCount).toBe(1)
    const addCall = (client.addBomItem as MockedFunction<ApiClient['addBomItem']>).mock.calls[0][0]
    expect(addCall).toMatchObject({
      wsIdParent: 241,
      wsIdChild: 998,
      dmsIdParent: 9001,
      dmsIdChild: 402865,
      linkChild: '/api/v3/workspaces/998/items/402865',
      quantity: '2',
    })
  })

  it('matches a reclassified reference child by actual item number when linkable-items uses a different id', async () => {
    let createCallCount = 0
    const client = {
      ...makeClient(),
      createItem: vi.fn().mockImplementation(() => {
        createCallCount++
        return Promise.resolve({ headers: { location: `/api/v3/workspaces/241/items/${9000 + createCallCount}` } })
      }),
    } as unknown as ApiClient

    const fetchItemFieldsForCopy = vi.fn().mockImplementation(async (_context, itemId) => {
      if (itemId === 6000) {
        return [
          { fieldId: 'NUMBER', value: 'BLD-100' },
          { fieldId: 'TITLE', value: 'Parent' },
        ]
      }
      if (itemId === 402865) {
        return [
          { fieldId: 'NUMBER', value: '99993125' },
          { fieldId: 'TITLE', value: 'Referenced Part' },
        ]
      }
      throw new Error(`Unexpected itemId: ${itemId}`)
    }) as MockedFunction<CloneService['fetchItemFieldsForCopy']>
    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>).mockResolvedValue({
      data: {
        items: [
          {
            item: {
              id: 555000,
              link: '/api/v3/workspaces/998/items/555000',
            },
            descriptor: '99993125 - Referenced Part',
          },
        ],
      },
    })
    ;(client.getItemDetails as MockedFunction<ApiClient['getItemDetails']>).mockResolvedValue({
      __self__: '/api/v3/workspaces/998/items/402865',
    })

    const childPlan: DuplicatePlanNode = {
      sourceNode: makeSourceNode('402865', '402865', '2'),
      kind: 'duplicate',
      children: [],
    }
    childPlan.sourceNode.itemLink = '/api/v3/workspaces/998/items/402865'

    const parentPlan = makeNode('6000', 'BLD-100', '1', [childPlan])

    await createMutateApi({ client, fetchItemFieldsForCopy }).deepDuplicateSubtree(makeContext(), parentPlan, 'PRJ-001')

    expect(createCallCount).toBe(1)
    const addCall = (client.addBomItem as MockedFunction<ApiClient['addBomItem']>).mock.calls[0][0]
    expect(addCall).toMatchObject({
      wsIdParent: 241,
      wsIdChild: 998,
      dmsIdParent: 9001,
      dmsIdChild: 555000,
      linkChild: '/api/v3/workspaces/998/items/555000',
      quantity: '2',
    })
  })

  it('uses the linkable proxy item id when the source item is only matchable by item number', async () => {
    let createCallCount = 0
    const client = {
      ...makeClient(),
      createItem: vi.fn().mockImplementation(() => {
        createCallCount++
        return Promise.resolve({ headers: { location: `/api/v3/workspaces/241/items/${9000 + createCallCount}` } })
      }),
    } as unknown as ApiClient

    const fetchItemFieldsForCopy = vi.fn().mockImplementation(async (_context, itemId) => {
      if (itemId === 6000) {
        return [
          { fieldId: 'NUMBER', value: 'BLD-100' },
          { fieldId: 'TITLE', value: 'Parent' },
        ]
      }
      if (itemId === 402865) {
        return [
          { fieldId: 'NUMBER', value: '99993125' },
          { fieldId: 'TITLE', value: 'Referenced Part' },
        ]
      }
      throw new Error(`Unexpected itemId: ${itemId}`)
    }) as MockedFunction<CloneService['fetchItemFieldsForCopy']>
    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>).mockResolvedValue({
      data: {
        items: [
          {
            id: 295323,
            __self__: {
              link: '/api/v3/workspaces/998/items/6000/views/5/linkable-items/295323',
            },
            descriptor: '99993125 - Referenced Part',
          },
        ],
      },
    })
    ;(client.getItemDetails as MockedFunction<ApiClient['getItemDetails']>).mockResolvedValue({
      __self__: '/api/v3/workspaces/998/items/402865',
    })

    const childPlan: DuplicatePlanNode = {
      sourceNode: makeSourceNode('402865', '402865', '2'),
      kind: 'duplicate',
      children: [],
    }
    childPlan.sourceNode.itemLink = '/api/v3/workspaces/998/items/402865'

    const parentPlan = makeNode('6000', 'BLD-100', '1', [childPlan])

    await createMutateApi({ client, fetchItemFieldsForCopy }).deepDuplicateSubtree(makeContext(), parentPlan, 'PRJ-001')

    expect(createCallCount).toBe(1)
    const addCall = (client.addBomItem as MockedFunction<ApiClient['addBomItem']>).mock.calls[0][0]
    expect(addCall).toMatchObject({
      wsIdParent: 241,
      wsIdChild: 998,
      dmsIdParent: 9001,
      dmsIdChild: 295323,
      linkChild: '/api/v3/workspaces/998/items/6000/views/5/linkable-items/295323',
      quantity: '2',
    })
  })

  it('merges duplicate wrapper children when they resolve to the same effective reference item', async () => {
    let createCallCount = 0
    const client = {
      ...makeClient(),
      createItem: vi.fn().mockImplementation(() => {
        createCallCount++
        return Promise.resolve({ headers: { location: `/api/v3/workspaces/241/items/${9000 + createCallCount}` } })
      }),
    } as unknown as ApiClient

    const fetchItemFieldsForCopy = vi.fn().mockImplementation(async (_context, itemId) => {
      if (itemId === 6000) {
        return [
          { fieldId: 'NUMBER', value: 'BLD-100' },
          { fieldId: 'TITLE', value: 'Parent' },
        ]
      }
      if (itemId === 402865 || itemId === 402866) {
        return [
          { fieldId: 'NUMBER', value: '99993125' },
          { fieldId: 'TITLE', value: 'Referenced Part' },
        ]
      }
      throw new Error(`Unexpected itemId: ${itemId}`)
    }) as MockedFunction<CloneService['fetchItemFieldsForCopy']>
    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>).mockResolvedValue({
      data: {
        items: [
          {
            item: {
              id: 555000,
              link: '/api/v3/workspaces/998/items/555000',
            },
            descriptor: '99993125 - Referenced Part',
          },
        ],
      },
    })
    ;(client.getItemDetails as MockedFunction<ApiClient['getItemDetails']>).mockResolvedValue({
      __self__: '/api/v3/workspaces/998/items/402865',
    })

    const childPlanOne: DuplicatePlanNode = {
      sourceNode: makeSourceNode('402865', '402865', '2'),
      kind: 'duplicate',
      children: [],
    }
    childPlanOne.sourceNode.itemLink = '/api/v3/workspaces/998/items/402865'

    const childPlanTwo: DuplicatePlanNode = {
      sourceNode: makeSourceNode('402866', '402866', '3'),
      kind: 'duplicate',
      children: [],
    }
    childPlanTwo.sourceNode.itemLink = '/api/v3/workspaces/998/items/402866'

    const parentPlan = makeNode('6000', 'BLD-100', '1', [childPlanOne, childPlanTwo])

    await createMutateApi({ client, fetchItemFieldsForCopy }).deepDuplicateSubtree(makeContext(), parentPlan, 'PRJ-001')

    expect(createCallCount).toBe(1)
    expect(client.addBomItem).toHaveBeenCalledTimes(1)
    expect((client.addBomItem as MockedFunction<ApiClient['addBomItem']>).mock.calls[0][0]).toMatchObject({
      wsIdParent: 241,
      wsIdChild: 998,
      dmsIdParent: 9001,
      dmsIdChild: 555000,
      linkChild: '/api/v3/workspaces/998/items/555000',
      quantity: '5',
    })
  })

  it('extracts the proxy item id from a linkable-items self link when no direct id fields are present', async () => {
    let createCallCount = 0
    const client = {
      ...makeClient(),
      createItem: vi.fn().mockImplementation(() => {
        createCallCount++
        return Promise.resolve({ headers: { location: `/api/v3/workspaces/241/items/${9000 + createCallCount}` } })
      }),
    } as unknown as ApiClient

    const fetchItemFieldsForCopy = vi.fn().mockImplementation(async (_context, itemId) => {
      if (itemId === 6000) {
        return [
          { fieldId: 'NUMBER', value: 'BLD-100' },
          { fieldId: 'TITLE', value: 'Parent' },
        ]
      }
      if (itemId === 402865) {
        return [
          { fieldId: 'NUMBER', value: '99993125' },
          { fieldId: 'TITLE', value: 'Referenced Part' },
        ]
      }
      throw new Error(`Unexpected itemId: ${itemId}`)
    }) as MockedFunction<CloneService['fetchItemFieldsForCopy']>
    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>).mockResolvedValue({
      data: {
        items: [
          {
            __self__: {
              link: '/api/v3/workspaces/998/items/6000/views/5/linkable-items/295323',
            },
            descriptor: '99993125 - Referenced Part',
          },
        ],
      },
    })
    ;(client.getItemDetails as MockedFunction<ApiClient['getItemDetails']>).mockResolvedValue({
      __self__: '/api/v3/workspaces/998/items/402865',
    })

    const childPlan: DuplicatePlanNode = {
      sourceNode: makeSourceNode('402865', '402865', '2'),
      kind: 'duplicate',
      children: [],
    }
    childPlan.sourceNode.itemLink = '/api/v3/workspaces/998/items/402865'

    const parentPlan = makeNode('6000', 'BLD-100', '1', [childPlan])

    await createMutateApi({ client, fetchItemFieldsForCopy }).deepDuplicateSubtree(makeContext(), parentPlan, 'PRJ-001')

    expect(createCallCount).toBe(1)
    const addCall = (client.addBomItem as MockedFunction<ApiClient['addBomItem']>).mock.calls[0][0]
    expect(addCall).toMatchObject({
      wsIdParent: 241,
      wsIdChild: 998,
      dmsIdParent: 9001,
      dmsIdChild: 295323,
      linkChild: '/api/v3/workspaces/998/items/6000/views/5/linkable-items/295323',
      quantity: '2',
    })
  })

  it('resolves proxy workspace from the linkable alias item details when the alias workspace differs from the real item workspace', async () => {
    let createCallCount = 0
    const client = {
      ...makeClient(),
      createItem: vi.fn().mockImplementation(() => {
        createCallCount++
        return Promise.resolve({ headers: { location: `/api/v3/workspaces/241/items/${9000 + createCallCount}` } })
      }),
    } as unknown as ApiClient

    const fetchItemFieldsForCopy = vi.fn().mockImplementation(async (_context, itemId) => {
      if (itemId === 6000) {
        return [
          { fieldId: 'NUMBER', value: 'BLD-100' },
          { fieldId: 'TITLE', value: 'Parent' },
        ]
      }
      if (itemId === 402865) {
        return [
          { fieldId: 'NUMBER', value: '99993125' },
          { fieldId: 'TITLE', value: 'Referenced Part' },
        ]
      }
      throw new Error(`Unexpected itemId: ${itemId}`)
    }) as MockedFunction<CloneService['fetchItemFieldsForCopy']>
    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>).mockResolvedValue({
      data: {
        items: [
          {
            __self__: {
              link: '/api/v3/workspaces/307/items/6000/views/5/linkable-items/295323',
            },
            item: {
              link: '/api/v3/workspaces/998/items/295323',
            },
            descriptor: '99993125 - Referenced Part',
          },
        ],
      },
    })
    ;(client.getItemDetails as MockedFunction<ApiClient['getItemDetails']>).mockResolvedValue({
      __self__: '/api/v3/workspaces/998/items/402865',
    })

    const childPlan: DuplicatePlanNode = {
      sourceNode: makeSourceNode('402865', '402865', '2'),
      kind: 'duplicate',
      children: [],
    }
    childPlan.sourceNode.itemLink = '/api/v3/workspaces/998/items/402865'

    const parentPlan = makeNode('6000', 'BLD-100', '1', [childPlan])

    await createMutateApi({ client, fetchItemFieldsForCopy }).deepDuplicateSubtree(makeContext(), parentPlan, 'PRJ-001')

    expect(createCallCount).toBe(1)
    const addCall = (client.addBomItem as MockedFunction<ApiClient['addBomItem']>).mock.calls[0][0]
    expect(addCall).toMatchObject({
      wsIdParent: 241,
      wsIdChild: 998,
      dmsIdParent: 9001,
      dmsIdChild: 295323,
      linkChild: '/api/v3/workspaces/307/items/6000/views/5/linkable-items/295323',
      quantity: '2',
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

  it('uses the source parent linkable alias when adding a duplicated assembly child', async () => {
    let createCallCount = 0
    const client = {
      ...makeClient(),
      createItem: vi.fn().mockImplementation(() => {
        createCallCount++
        return Promise.resolve({ headers: { location: `/api/v3/workspaces/241/items/${9000 + createCallCount}` } })
      }),
    } as unknown as ApiClient

    const fetchItemFieldsForCopy = vi.fn().mockImplementation(async (_context, itemId) => {
      if (itemId === 6000) {
        return [
          { fieldId: 'NUMBER', value: 'BLD-100' },
          { fieldId: 'TITLE', value: 'Parent' },
        ]
      }
      if (itemId === 6100) {
        return [
          { fieldId: 'NUMBER', value: 'SUB-100' },
          { fieldId: 'TITLE', value: 'Child' },
        ]
      }
      throw new Error(`Unexpected itemId: ${itemId}`)
    }) as MockedFunction<CloneService['fetchItemFieldsForCopy']>

    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>).mockResolvedValue({
      data: {
        items: [
          {
            __self__: '/api/v3/workspaces/241/items/6000/views/1/linkable-items/9100',
            item: {
              link: '/api/v3/workspaces/241/items/6100',
            },
            descriptor: 'SUB-100 - Child',
          },
        ],
        totalCount: 1,
        offset: 0,
        limit: 1000,
      },
    })

    const childPlan = makeNode('6100', 'SUB-100', '3')
    const parentPlan = makeNode('6000', 'BLD-100', '1', [childPlan])

    await createMutateApi({ client, fetchItemFieldsForCopy }).deepDuplicateSubtree(makeContext(), parentPlan, 'PRJ-001')

    // Fast path adds extra search calls: 1 (source parent fast-path hit) + 1 (new parent fast-path
    // miss for 'SUB-100-PRJ001') + 3 (3 full-fetch attempts for new parent, no match) = 5 total
    // targetDuplicateChildTemplateReference uses the populated full cache from attempt 3, no extra call
    expect(client.fetchBomLinkableItems).toHaveBeenCalledTimes(5)
    expect(client.addBomItem).toHaveBeenCalledWith(expect.objectContaining({
      dmsIdParent: 9001,
      dmsIdChild: 9002,
      wsIdChild: 241,
      linkChild: '/api/v3/workspaces/241/items/6000/views/1/linkable-items/9100',
      quantity: '3',
    }))
  })

  it('does not switch to a canonical copy source when the canonical NUMBER differs from the source child NUMBER', async () => {
    let createCallCount = 0
    const client = {
      ...makeClient(),
      createItem: vi.fn().mockImplementation(() => {
        createCallCount++
        return Promise.resolve({ headers: { location: `/api/v3/workspaces/241/items/${9000 + createCallCount}` } })
      }),
      getItemDetails: vi.fn().mockImplementation(async ({ workspaceId, dmsId }) => {
        if (workspaceId === 998 && dmsId === 9100) {
          return {
            sections: [
              {
                fields: [
                  { fieldId: 'NUMBER', value: '999-REF-100' },
                  { fieldId: 'TITLE', value: 'Canonical Reference Child' },
                ],
              },
            ],
          }
        }
        return {}
      }),
    } as unknown as ApiClient

    const fetchItemFieldsForCopy = vi.fn().mockImplementation(async (_context, itemId) => {
      if (itemId === 6000) {
        return [
          { fieldId: 'NUMBER', value: 'BLD-100' },
          { fieldId: 'TITLE', value: 'Parent' },
        ]
      }
      if (itemId === 6100) {
        return [
          { fieldId: 'NUMBER', value: 'SUB-100' },
          { fieldId: 'TITLE', value: 'Child' },
        ]
      }
      throw new Error(`Unexpected itemId: ${itemId}`)
    }) as MockedFunction<CloneService['fetchItemFieldsForCopy']>

    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>).mockResolvedValue({
      data: {
        items: [
          {
            __self__: '/api/v3/workspaces/241/items/6000/views/1/linkable-items/9100',
            item: {
              link: '/api/v3/workspaces/998/items/9100',
            },
            descriptor: 'SUB-100 - Child',
          },
        ],
        totalCount: 1,
        offset: 0,
        limit: 1000,
      },
    })

    const childPlan = makeNode('6100', 'SUB-100', '3')
    const parentPlan = makeNode('6000', 'BLD-100', '1', [childPlan])

    await createMutateApi({ client, fetchItemFieldsForCopy }).deepDuplicateSubtree(makeContext(), parentPlan, 'PRJ-001')

    expect(createCallCount).toBe(2)
    expect(client.createItem).toHaveBeenNthCalledWith(2, expect.objectContaining({
      workspaceId: 241,
      fields: expect.arrayContaining([
        expect.objectContaining({ fieldId: 'NUMBER', value: 'SUB-100-PRJ001' }),
      ]),
    }))
    expect(client.addBomItem).toHaveBeenCalledWith(expect.objectContaining({
      dmsIdParent: 9001,
      dmsIdChild: 9002,
      wsIdChild: 241,
      linkChild: '/api/v3/workspaces/241/items/6000/views/1/linkable-items/9100',
      quantity: '3',
    }))
  })

  it('prefers the cloned parent linkable alias for the original child shape when adding a duplicated assembly child', async () => {
    let createCallCount = 0
    const client = {
      ...makeClient(),
      createItem: vi.fn().mockImplementation(() => {
        createCallCount++
        return Promise.resolve({ headers: { location: `/api/v3/workspaces/241/items/${9000 + createCallCount}` } })
      }),
    } as unknown as ApiClient

    const fetchItemFieldsForCopy = vi.fn().mockImplementation(async (_context, itemId) => {
      if (itemId === 6000) {
        return [
          { fieldId: 'NUMBER', value: 'BLD-100' },
          { fieldId: 'TITLE', value: 'Parent' },
        ]
      }
      if (itemId === 6100) {
        return [
          { fieldId: 'NUMBER', value: 'SUB-100' },
          { fieldId: 'TITLE', value: 'Child' },
        ]
      }
      throw new Error(`Unexpected itemId: ${itemId}`)
    }) as MockedFunction<CloneService['fetchItemFieldsForCopy']>

    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>)
      .mockResolvedValueOnce({
        data: {
          items: [],
          totalCount: 0,
          offset: 0,
          limit: 1000,
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [],
          totalCount: 0,
          offset: 0,
          limit: 1000,
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              __self__: '/api/v3/workspaces/241/items/9001/views/1/linkable-items/9101',
              item: {
                link: '/api/v3/workspaces/241/items/9002',
              },
              descriptor: 'SUB-100 - Child',
            },
          ],
          totalCount: 1,
          offset: 0,
          limit: 1000,
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              __self__: '/api/v3/workspaces/241/items/9001/views/1/linkable-items/9101',
              item: {
                link: '/api/v3/workspaces/241/items/9002',
              },
              descriptor: 'SUB-100 - Child',
            },
          ],
          totalCount: 1,
          offset: 0,
          limit: 1000,
        },
      })

    const childPlan = makeNode('6100', 'SUB-100', '3')
    const parentPlan = makeNode('6000', 'BLD-100', '1', [childPlan])

    await createMutateApi({ client, fetchItemFieldsForCopy }).deepDuplicateSubtree(makeContext(), parentPlan, 'PRJ-001')

    expect(client.fetchBomLinkableItems).toHaveBeenCalledTimes(3)
    expect(client.addBomItem).toHaveBeenCalledWith(expect.objectContaining({
      dmsIdParent: 9001,
      dmsIdChild: 9002,
      wsIdChild: 241,
      linkChild: '/api/v3/workspaces/241/items/9001/views/1/linkable-items/9101',
      quantity: '3',
    }))
  })

  it('retries a referenced child lookup after fetching its NUMBER when the cache-backed lookup misses', async () => {
    const client = makeClient()
    const fetchItemFieldsForCopy = vi.fn().mockImplementation(async (_context, itemId) => {
      if (itemId === 6000) {
        return [
          { fieldId: 'NUMBER', value: 'BLD-100' },
          { fieldId: 'TITLE', value: 'Parent' },
        ]
      }
      if (itemId === 405680) {
        return [
          { fieldId: 'NUMBER', value: '99997689' },
          { fieldId: 'TITLE', value: 'Referenced Child' },
        ]
      }
      throw new Error(`Unexpected itemId: ${itemId}`)
    }) as MockedFunction<CloneService['fetchItemFieldsForCopy']>

    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>)
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              __self__: '/api/v3/workspaces/241/items/6000/views/1/linkable-items/9102',
              item: {
                link: '/api/v3/workspaces/998/items/9102',
              },
              descriptor: '99997689 - Referenced Child',
            },
          ],
          totalCount: 1,
          offset: 0,
          limit: 1000,
        },
      })

    const referenceChildPlan: DuplicatePlanNode = {
      sourceNode: makeSourceNode('405680', '405680', '2'),
      kind: 'duplicate',
      children: [],
    }
    const parentPlan = makeNode('6000', 'BLD-100', '1', [referenceChildPlan])

    await createMutateApi({ client, fetchItemFieldsForCopy }).deepDuplicateSubtree(makeContext(), parentPlan, 'PRJ-001')

    expect(client.fetchBomLinkableItems).toHaveBeenCalledTimes(1)
    expect(client.addBomItem).toHaveBeenCalledWith(expect.objectContaining({
      dmsIdParent: 9999,
      dmsIdChild: 9102,
      wsIdChild: 998,
      linkChild: '/api/v3/workspaces/241/items/6000/views/1/linkable-items/9102',
      quantity: '2',
    }))
  })

  it('retries duplicate child linkable lookup instead of caching the first miss', async () => {
    vi.useFakeTimers()
    try {
      let createCallCount = 0
      const client = {
        ...makeClient(),
        createItem: vi.fn().mockImplementation(() => {
          createCallCount++
          return Promise.resolve({ headers: { location: `/api/v3/workspaces/241/items/${9000 + createCallCount}` } })
        }),
      } as unknown as ApiClient

      const fetchItemFieldsForCopy = vi.fn().mockImplementation(async (_context, itemId) => {
        if (itemId === 6000) {
          return [
            { fieldId: 'NUMBER', value: 'BLD-100' },
            { fieldId: 'TITLE', value: 'Parent' },
          ]
        }
        if (itemId === 6100) {
          return [
            { fieldId: 'NUMBER', value: 'SUB-100' },
            { fieldId: 'TITLE', value: 'Child' },
          ]
        }
        throw new Error(`Unexpected itemId: ${itemId}`)
      }) as MockedFunction<CloneService['fetchItemFieldsForCopy']>

      const emptyPage = {
        data: { items: [], totalCount: 0, offset: 0, limit: 1000 },
      }
      const childIndexedPage = {
        data: {
          items: [
            {
              __self__: '/api/v3/workspaces/241/items/9001/views/1/linkable-items/9100',
              item: { link: '/api/v3/workspaces/241/items/9002' },
              descriptor: 'SUB-100-PRJ001 - Child',
            },
          ],
          totalCount: 1,
          offset: 0,
          limit: 1000,
        },
      }
      // call order with fast-path optimisation:
      // 1. fast-path search 'SUB-100' in parent 6000 → empty (child not in source parent pool)
      // 2. full-fetch page for parent 6000 → empty
      // 3. fast-path search 'SUB-100-PRJ001' in new parent 9001 (attempt 0) → empty (not indexed yet)
      // 4. full-fetch for parent 9001 (attempt 0) → empty
      // 5. full-fetch for parent 9001 (attempt 1, forceRefresh) → child now indexed → match
      ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>)
        .mockResolvedValueOnce(emptyPage)
        .mockResolvedValueOnce(emptyPage)
        .mockResolvedValueOnce(emptyPage)
        .mockResolvedValueOnce(emptyPage)
        .mockResolvedValueOnce(childIndexedPage)

      const childPlan = makeNode('6100', 'SUB-100', '3')
      const parentPlan = makeNode('6000', 'BLD-100', '1', [childPlan])

      const pending = createMutateApi({ client, fetchItemFieldsForCopy })
        .deepDuplicateSubtree(makeContext(), parentPlan, 'PRJ-001')

      await vi.runAllTimersAsync()
      await pending

      expect(client.fetchBomLinkableItems).toHaveBeenCalledTimes(5)
      expect(client.addBomItem).toHaveBeenCalledWith(expect.objectContaining({
        dmsIdParent: 9001,
        dmsIdChild: 9002,
        wsIdChild: 241,
        linkChild: '/api/v3/workspaces/241/items/9001/views/1/linkable-items/9100',
        quantity: '3',
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('reuses fetched linkable pages for multiple reference children under the same parent', async () => {
    const client = makeClient()
    const fetchItemFieldsForCopy = vi.fn().mockImplementation(async (_context, itemId) => {
      if (itemId === 6000) {
        return [
          { fieldId: 'NUMBER', value: 'BLD-100' },
          { fieldId: 'TITLE', value: 'Parent' },
        ]
      }
      if (itemId === 401903) {
        return [
          { fieldId: 'NUMBER', value: '99991186' },
          { fieldId: 'TITLE', value: 'Ref 1' },
        ]
      }
      if (itemId === 401925) {
        return [
          { fieldId: 'NUMBER', value: '99991224' },
          { fieldId: 'TITLE', value: 'Ref 2' },
        ]
      }
      throw new Error(`Unexpected itemId: ${itemId}`)
    }) as MockedFunction<CloneService['fetchItemFieldsForCopy']>

    const refItems = [
      {
        __self__: '/api/v3/workspaces/241/items/6000/views/1/linkable-items/9101',
        item: { link: '/api/v3/workspaces/998/items/9101' },
        descriptor: '99991186 - Ref 1',
      },
      {
        __self__: '/api/v3/workspaces/241/items/6000/views/1/linkable-items/9102',
        item: { link: '/api/v3/workspaces/998/items/9102' },
        descriptor: '99991224 - Ref 2',
      },
    ]
    // call order with fast-path optimisation:
    // 1. fast-path search '99991186' in parent 6000 → empty (items are on page 2, not first 100)
    // 2. full-fetch page 0 → empty, totalCount=1001 → continue to page 1
    // 3. full-fetch page 1 → both ref items → reachedTotal → stop; cache populated
    // child 401925 lookup reuses the populated cache → no extra call
    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>)
      .mockResolvedValueOnce({
        data: { items: [], totalCount: 1001, offset: 0, limit: 1000 },
      })
      .mockResolvedValueOnce({
        data: { items: [], totalCount: 1001, offset: 0, limit: 1000 },
      })
      .mockResolvedValueOnce({
        data: { items: refItems, totalCount: 1001, offset: 1000, limit: 1000 },
      })

    const childPlanA: DuplicatePlanNode = {
      sourceNode: makeSourceNode('401903', '401903', '2'),
      kind: 'duplicate',
      children: [],
    }
    const childPlanB: DuplicatePlanNode = {
      sourceNode: makeSourceNode('401925', '401925', '3'),
      kind: 'duplicate',
      children: [],
    }
    const parentPlan = makeNode('6000', 'BLD-100', '1', [childPlanA, childPlanB])

    await createMutateApi({ client, fetchItemFieldsForCopy }).deepDuplicateSubtree(makeContext(), parentPlan, 'PRJ-001')

    expect(client.fetchBomLinkableItems).toHaveBeenCalledTimes(3)
    expect(client.addBomItem).toHaveBeenNthCalledWith(1, expect.objectContaining({
      dmsIdParent: 9999,
      dmsIdChild: 9101,
      wsIdChild: 998,
      linkChild: '/api/v3/workspaces/241/items/6000/views/1/linkable-items/9101',
      quantity: '2',
    }))
    expect(client.addBomItem).toHaveBeenNthCalledWith(2, expect.objectContaining({
      dmsIdParent: 9999,
      dmsIdChild: 9102,
      wsIdChild: 998,
      linkChild: '/api/v3/workspaces/241/items/6000/views/1/linkable-items/9102',
      quantity: '3',
    }))
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

describe('commitBomCloneItem', () => {
  it('uses the canonical child link from item details when committing a reference item', async () => {
    const client = makeClient()
    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>).mockResolvedValue({
      data: {
        items: [
          {
            item: {
              id: 407279,
              link: '/api/v3/workspaces/998/items/407279',
            },
          },
        ],
      },
    })
    ;(client.getItemDetails as MockedFunction<ApiClient['getItemDetails']>)
      .mockResolvedValueOnce({
        __self__: '/api/v3/workspaces/241/items/1000',
        sections: [],
      })
      .mockResolvedValueOnce({
        __self__: '/api/v3/workspaces/998/items/407279',
        sections: [],
      })

    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy: makeFetchItemFieldsForCopy() })
    await mutateApi.commitBomCloneItem(makeContext(), {
      sourceItemId: 407279,
      sourceItemLink: '/api/v3/workspaces/241/items/407279',
      itemNumber: 1,
      quantity: '1',
    })

    expect(client.addBomItem).toHaveBeenCalledWith(expect.objectContaining({
      wsIdParent: 241,
      linkParent: '/api/v3/workspaces/241/items/1000',
      wsIdChild: 998,
      dmsIdChild: 407279,
      linkChild: '/api/v3/workspaces/998/items/407279',
    }))
    expect(client.fetchBomLinkableItems).toHaveBeenCalledWith(expect.not.objectContaining({
      relatedWorkspaceId: expect.anything(),
    }))
  })

  it('falls back to item details when linkable-items does not include the source item', async () => {
    const client = makeClient()
    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>).mockResolvedValue({
      data: { items: [] },
    })
    ;(client.getItemDetails as MockedFunction<ApiClient['getItemDetails']>)
      .mockResolvedValueOnce({
        __self__: '/api/v3/workspaces/241/items/1000',
        sections: [],
      })
      .mockResolvedValueOnce({
        __self__: '/api/v3/workspaces/998/items/407279',
        sections: [],
      })

    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy: makeFetchItemFieldsForCopy() })
    await mutateApi.commitBomCloneItem(makeContext(), {
      sourceItemId: 407279,
      sourceItemLink: '/api/v3/workspaces/241/items/407279',
      itemNumber: 1,
      quantity: '1',
    })

    expect(client.addBomItem).toHaveBeenCalledWith(expect.objectContaining({
      linkParent: '/api/v3/workspaces/241/items/1000',
      wsIdChild: 998,
      linkChild: '/api/v3/workspaces/998/items/407279',
    }))
  })

  it('matches the nested item id when the wrapper entry id differs', async () => {
    const client = makeClient()
    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>).mockResolvedValue({
      data: {
        items: [
          {
            id: 12,
            item: {
              id: 407279,
              link: '/api/v3/workspaces/998/items/407279',
            },
          },
        ],
      },
    })
    ;(client.getItemDetails as MockedFunction<ApiClient['getItemDetails']>).mockResolvedValue({
      __self__: '/api/v3/workspaces/241/items/1000',
      sections: [],
    })

    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy: makeFetchItemFieldsForCopy() })
    await mutateApi.commitBomCloneItem(makeContext(), {
      sourceItemId: 407279,
      sourceItemLink: '/api/v3/workspaces/241/items/407279',
      itemNumber: 1,
      quantity: '1',
    })

    expect(client.addBomItem).toHaveBeenCalledWith(expect.objectContaining({
      wsIdChild: 998,
      linkChild: '/api/v3/workspaces/998/items/407279',
    }))
  })

  it('matches linkable-items entries when the item id only appears inside a nested link', async () => {
    const client = makeClient()
    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>).mockResolvedValue({
      data: {
        items: [
          {
            descriptor: 'Referenced Part',
            item: {
              self: {
                link: '/api/v3/workspaces/998/items/407279',
              },
            },
          },
        ],
      },
    })
    ;(client.getItemDetails as MockedFunction<ApiClient['getItemDetails']>).mockResolvedValue({
      __self__: '/api/v3/workspaces/241/items/1000',
      sections: [],
    })

    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy: makeFetchItemFieldsForCopy() })
    await mutateApi.commitBomCloneItem(makeContext(), {
      sourceItemId: 407279,
      sourceItemLink: '/api/v3/workspaces/241/items/407279',
      itemNumber: 1,
      quantity: '1',
    })

    expect(client.addBomItem).toHaveBeenCalledWith(expect.objectContaining({
      wsIdChild: 998,
      linkChild: '/api/v3/workspaces/998/items/407279',
    }))
  })

  it('paginates linkable-items until the matching source item is found', async () => {
    const client = makeClient()
    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>)
      .mockResolvedValueOnce({
        data: {
          items: [
            { item: { id: 111111, link: '/api/v3/workspaces/998/items/111111' } },
          ],
          totalCount: 1001,
          offset: 0,
          limit: 1000,
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            { item: { id: 407279, link: '/api/v3/workspaces/998/items/407279' } },
          ],
          totalCount: 1001,
          offset: 1000,
          limit: 1000,
        },
      })
    ;(client.getItemDetails as MockedFunction<ApiClient['getItemDetails']>).mockResolvedValue({
      __self__: '/api/v3/workspaces/241/items/1000',
      sections: [],
    })

    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy: makeFetchItemFieldsForCopy() })
    await mutateApi.commitBomCloneItem(makeContext(), {
      sourceItemId: 407279,
      sourceItemLink: '/api/v3/workspaces/241/items/407279',
      itemNumber: 1,
      quantity: '1',
    })

    expect(client.fetchBomLinkableItems).toHaveBeenCalledTimes(2)
    expect(client.addBomItem).toHaveBeenCalledWith(expect.objectContaining({
      wsIdChild: 998,
      linkChild: '/api/v3/workspaces/998/items/407279',
    }))
  })

  it('uses the canonical parent link when the target root resolves to a different workspace link', async () => {
    const client = makeClient()
    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>).mockResolvedValue({
      data: { items: [] },
    })
    ;(client.getItemDetails as MockedFunction<ApiClient['getItemDetails']>)
      .mockResolvedValueOnce({
        __self__: '/api/v3/workspaces/307/items/408562',
        sections: [],
      })
      .mockResolvedValueOnce({
        __self__: '/api/v3/workspaces/998/items/407279',
        sections: [],
      })

    const mutateApi = createMutateApi({ client, fetchItemFieldsForCopy: makeFetchItemFieldsForCopy() })
    await mutateApi.commitBomCloneItem({
      ...makeContext(),
      workspaceId: 57,
      currentItemId: 408562,
    }, {
      sourceItemId: 407279,
      sourceItemLink: '/api/v3/workspaces/57/items/407279',
      itemNumber: 1,
      quantity: '1',
    })

    expect(client.addBomItem).toHaveBeenCalledWith(expect.objectContaining({
      wsIdParent: 307,
      linkParent: '/api/v3/workspaces/307/items/408562',
      wsIdChild: 998,
      linkChild: '/api/v3/workspaces/998/items/407279',
    }))
  })
})
