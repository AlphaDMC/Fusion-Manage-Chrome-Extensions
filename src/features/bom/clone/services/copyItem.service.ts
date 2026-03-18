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

function resolveFieldId(fieldRecord: Record<string, unknown>): string | null {
  const directFieldId = typeof fieldRecord.fieldId === 'string' && fieldRecord.fieldId.trim()
    ? fieldRecord.fieldId.trim()
    : null
  if (directFieldId) return directFieldId

  const fromSelf = fieldIdFromSelf(fieldRecord.__self__)
  if (fromSelf) return fromSelf

  const fromLink = fieldIdFromSelf(fieldRecord.link)
  if (fromLink) return fromLink

  return null
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
  const seen = new Set<string>()
  const result: CopyableField[] = []

  const collectField = (field: unknown): void => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) return
    const fieldRecord = field as Record<string, unknown>
    const fieldId = resolveFieldId(fieldRecord)
    if (!fieldId) return
    if (SKIP_FIELD_IDS.has(fieldId.toUpperCase())) return
    if (seen.has(fieldId)) return

    const value = stringifyValue(fieldRecord.value)
    if (value === null) return

    seen.add(fieldId)
    result.push({ fieldId, value })
  }

  const collectFieldArray = (fields: unknown): void => {
    if (!Array.isArray(fields)) return
    for (const field of fields) {
      collectField(field)
    }
  }

  const collectSections = (sections: unknown): void => {
    if (!Array.isArray(sections)) return
    for (const section of sections) {
      if (!section || typeof section !== 'object' || Array.isArray(section)) continue
      const sectionRecord = section as Record<string, unknown>
      collectFieldArray(sectionRecord.fields)
    }
  }

  const collectFromRoot = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return
    const record = candidate as Record<string, unknown>
    collectSections(record.sections)
    collectFieldArray(record.fields)
    collectFieldArray(record.viewfields)
    collectFieldArray(record.viewFields)

    const derived = record.derived
    if (derived && typeof derived === 'object' && !Array.isArray(derived)) {
      collectSections((derived as Record<string, unknown>).sections)
    }
  }

  collectFromRoot(root)
  collectFromRoot(root.data)

  return result
}
