/**
 * Fields that Fusion Manage manages automatically.
 * These are never copied when duplicating an item.
 */
const SKIP_FIELD_IDS = new Set([
  'DESCRIPTOR',
  'REVISION',
  'WF_CURRENT_STATE',
  'CREATED_ON',
  'LAST_MODIFIED_ON',
  'CREATED_BY',
  'LAST_MODIFIED_BY',
  'ITEM_NUMBER',
  'VERSION',
  'WF_STATE',
  'LIFECYCLE_STATE',
])

function fieldIdFromSelf(self: unknown): string | null {
  if (typeof self !== 'string' || !self.trim()) return null
  const parts = self.trim().split('/')
  const last = parts[parts.length - 1]?.split('?')[0]
  return last?.trim() || null
}

function stringifyValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

export type CopyableField = { fieldId: string; value: string }

/**
 * Extracts all non-system fields with non-empty values from a
 * getItemDetails API response. Safe to call with any unknown payload.
 */
export function extractCopyableFields(payload: unknown): CopyableField[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const root = payload as Record<string, unknown>
  const sections = Array.isArray(root.sections) ? root.sections : []
  const seen = new Set<string>()
  const result: CopyableField[] = []

  for (const section of sections) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue
    const sectionRecord = section as Record<string, unknown>
    const fields = Array.isArray(sectionRecord.fields) ? sectionRecord.fields : []

    for (const field of fields) {
      if (!field || typeof field !== 'object' || Array.isArray(field)) continue
      const fieldRecord = field as Record<string, unknown>
      const fieldId = fieldIdFromSelf(fieldRecord.__self__)
      if (!fieldId) continue
      if (SKIP_FIELD_IDS.has(fieldId.toUpperCase())) continue
      if (seen.has(fieldId)) continue

      const value = stringifyValue(fieldRecord.value)
      if (value === null) continue

      seen.add(fieldId)
      result.push({ fieldId, value })
    }
  }

  return result
}
