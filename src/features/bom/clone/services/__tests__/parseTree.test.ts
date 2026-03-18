import { describe, expect, it } from 'vitest'
import { toBomTree } from '../api/parseTree'
import { toBomTreeV1 } from '../api/parseTreeV1'

describe('toBomTree', () => {
  it('reads quantity from direct edge fields when field 103 is absent', () => {
    const tree = toBomTree({
      data: {
        nodes: [
          { item: { id: 100, title: 'Root Assembly', link: '/api/v3/workspaces/241/items/100' } },
          { item: { id: 101, title: 'Child Assembly', link: '/api/v3/workspaces/241/items/101' } },
        ],
        edges: [
          {
            parent: '/api/v3/workspaces/241/items/100',
            child: '/api/v3/workspaces/241/items/101',
            depth: 1,
            itemNumber: 1,
            quantity: 3,
            fields: [],
          },
        ],
      },
    })

    expect(tree[0]?.children[0]?.quantity).toBe('3')
  })

  it('reads quantity from legacy V1 qty fields', () => {
    const tree = toBomTreeV1({
      item: { descriptor: 'Root Assembly' },
      data: {
        data: [
          {
            'bom-item': {
              bomDepthLevel: 1,
              dmsID: 101,
              descriptor: 'Child Assembly',
              itemNumber: '1',
              qty: 4,
              assembly: false,
              leaf: true,
            },
          },
        ],
      },
    }, {
      workspaceId: 241,
      rootItemId: 100,
      depth: 2,
    })

    expect(tree[0]?.children[0]?.quantity).toBe('4')
  })
})
