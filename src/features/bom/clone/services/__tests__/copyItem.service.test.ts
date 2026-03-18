import { describe, it, expect } from 'vitest'
import { extractCopyableFields } from '../copyItem.service'

function makePayload(fields: Array<{ selfPath: string; value: unknown }>) {
  return {
    sections: [
      {
        title: 'Basic',
        fields: fields.map(({ selfPath, value }) => ({
          __self__: selfPath,
          title: 'Field',
          value,
        })),
      },
    ],
  }
}

describe('extractCopyableFields', () => {
  it('extracts a simple string field', () => {
    const payload = makePayload([
      { selfPath: '/api/v3/workspaces/241/views/1/fields/TITLE', value: 'My Title' },
    ])
    const result = extractCopyableFields(payload)
    expect(result).toContainEqual({ fieldId: 'TITLE', value: 'My Title' })
  })

  it('skips DESCRIPTOR field', () => {
    const payload = makePayload([
      { selfPath: '/api/v3/workspaces/241/views/1/fields/DESCRIPTOR', value: 'AS-001' },
    ])
    expect(extractCopyableFields(payload)).toHaveLength(0)
  })

  it('skips REVISION field', () => {
    const payload = makePayload([
      { selfPath: '/api/v3/workspaces/241/views/1/fields/REVISION', value: 'A' },
    ])
    expect(extractCopyableFields(payload)).toHaveLength(0)
  })

  it('skips WF_CURRENT_STATE field', () => {
    const payload = makePayload([
      { selfPath: '/api/v3/workspaces/241/views/1/fields/WF_CURRENT_STATE', value: 'Released' },
    ])
    expect(extractCopyableFields(payload)).toHaveLength(0)
  })

  it('skips fields with null value', () => {
    const payload = makePayload([
      { selfPath: '/api/v3/workspaces/241/views/1/fields/TITLE', value: null },
    ])
    expect(extractCopyableFields(payload)).toHaveLength(0)
  })

  it('skips fields with empty string value', () => {
    const payload = makePayload([
      { selfPath: '/api/v3/workspaces/241/views/1/fields/TITLE', value: '' },
    ])
    expect(extractCopyableFields(payload)).toHaveLength(0)
  })

  it('includes numeric values as strings', () => {
    const payload = makePayload([
      { selfPath: '/api/v3/workspaces/241/views/1/fields/WEIGHT', value: 42 },
    ])
    const result = extractCopyableFields(payload)
    expect(result).toContainEqual({ fieldId: 'WEIGHT', value: '42' })
  })

  it('returns empty array for null or unknown payload shape', () => {
    expect(extractCopyableFields(null)).toEqual([])
    expect(extractCopyableFields({})).toEqual([])
    expect(extractCopyableFields({ sections: [] })).toEqual([])
  })

  it('deduplicates field IDs (first occurrence wins)', () => {
    const payload = {
      sections: [
        {
          title: 'A',
          fields: [
            { __self__: '/api/v3/workspaces/241/views/1/fields/TITLE', value: 'First' },
          ],
        },
        {
          title: 'B',
          fields: [
            { __self__: '/api/v3/workspaces/241/views/1/fields/TITLE', value: 'Second' },
          ],
        },
      ],
    }
    const result = extractCopyableFields(payload)
    const titleFields = result.filter((f) => f.fieldId === 'TITLE')
    expect(titleFields).toHaveLength(1)
    expect(titleFields[0].value).toBe('First')
  })
})
