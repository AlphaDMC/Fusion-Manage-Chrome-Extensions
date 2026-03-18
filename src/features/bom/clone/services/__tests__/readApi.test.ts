import { describe, it, expect, vi, type MockedFunction } from 'vitest'
import { createReadApi } from '../api/read'
import type { ApiClient } from '../api/client'
import type { BomCloneContext } from '../../clone.types'

function makeContext(): BomCloneContext {
  return {
    tenant: 'test-tenant',
    workspaceId: 241,
    currentItemId: 1000,
    viewId: 1,
    viewDefId: 5,
  }
}

function makeClient(): ApiClient {
  return {
    getBom: vi.fn().mockResolvedValue({}),
    getBomV1: vi.fn().mockResolvedValue({}),
    getBomViews: vi.fn().mockResolvedValue({}),
    fetchFields: vi.fn().mockResolvedValue({}),
    fetchSections: vi.fn().mockResolvedValue({}),
    createItem: vi.fn().mockResolvedValue({}),
    getItemDetails: vi.fn().mockResolvedValue({}),
    fetchBomLinkableItems: vi.fn().mockResolvedValue({}),
    addBomItem: vi.fn().mockResolvedValue({}),
    updateBomItem: vi.fn().mockResolvedValue({}),
    removeBomItem: vi.fn().mockResolvedValue({}),
  }
}

describe('createReadApi.fetchSourceBomStructure', () => {
  it('prefers the v3 BOM reader before falling back to v1', async () => {
    const client = makeClient()
    ;(client.getBom as MockedFunction<ApiClient['getBom']>).mockResolvedValue({
      data: {
        item: {
          id: 2000,
          title: 'Root Assembly',
        },
      },
    })

    const tree = await createReadApi({ client }).fetchSourceBomStructure(makeContext(), 2000, { depth: 3 })

    expect(tree[0]?.id).toBe('2000')
    expect(client.getBom).toHaveBeenCalledOnce()
    expect(client.getBomV1).not.toHaveBeenCalled()
  })

  it('falls back to v1 when the v3 BOM read fails', async () => {
    const client = makeClient()
    ;(client.getBom as MockedFunction<ApiClient['getBom']>).mockRejectedValue(new Error('v3 failed'))
    ;(client.getBomV1 as MockedFunction<ApiClient['getBomV1']>).mockResolvedValue({
      item: { descriptor: 'Root Assembly' },
      data: {
        data: [
          {
            'bom-item': {
              bomDepthLevel: 1,
              dmsID: 3001,
              descriptor: 'Child Part',
              itemNumber: '1',
              assembly: false,
              leaf: true,
            },
          },
        ],
      },
    })

    const tree = await createReadApi({ client }).fetchSourceBomStructure(makeContext(), 3000, { depth: 2 })

    expect(client.getBom).toHaveBeenCalledOnce()
    expect(client.getBomV1).toHaveBeenCalledOnce()
    expect(tree[0]?.children[0]?.id).toBe('3001')
  })
})

describe('createReadApi.validateLinkableItem', () => {
  it('accepts linkable-items payloads that wrap the id under item', async () => {
    const client = makeClient()
    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>).mockResolvedValue({
      data: {
        items: [
          {
            item: {
              id: 407279,
              link: '/api/v3/workspaces/307/items/407279',
            },
          },
        ],
      },
    })

    const result = await createReadApi({ client }).validateLinkableItem(makeContext(), 407279)
    expect(result).toBe(true)
  })

  it('prefers the nested item id when the wrapper entry id differs', async () => {
    const client = makeClient()
    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>).mockResolvedValue({
      data: {
        items: [
          {
            id: 12,
            item: {
              id: 407279,
              link: '/api/v3/workspaces/307/items/407279',
            },
          },
        ],
      },
    })

    const result = await createReadApi({ client }).validateLinkableItem(makeContext(), 407279)
    expect(result).toBe(true)
  })

  it('matches linkable-items when the only discoverable id is inside a nested link', async () => {
    const client = makeClient()
    ;(client.fetchBomLinkableItems as MockedFunction<ApiClient['fetchBomLinkableItems']>).mockResolvedValue({
      data: {
        items: [
          {
            descriptor: 'Referenced Part',
            item: {
              self: {
                link: '/api/v3/workspaces/307/items/407279',
              },
            },
          },
        ],
      },
    })

    const result = await createReadApi({ client }).validateLinkableItem(makeContext(), 407279)
    expect(result).toBe(true)
  })
})
