# Deep Item Duplication Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When cloning a BOM, items whose number starts with "99" (Parts) are referenced as before; all other items (Buildings, Ubers, Subassemblies) are deep-duplicated — new items are created in Fusion Manage with a user-supplied project reference field value — and the new items are linked into the BOM in place of the originals.

**Architecture:** A new `deepDuplicate.service.ts` owns all recursive duplication logic and produces a flat ordered operation list. A new `copyItem.service.ts` extracts copyable field values from `getItemDetails` responses. The commit flow gains a new execution path that calls these services before the existing `addBomItem` calls. UI is a small panel added to the structure phase.

**Tech Stack:** TypeScript, React 19, Vitest (new), Vite, Chrome Extension MV3, Fusion Manage REST API (v3)

---

## Background knowledge for the implementer

### How the BOM Clone commit flow works today

`executeCommitOperations` in `src/features/bom/clone/services/commit.service.ts` processes four batches in order: **create** (manufacturing operation drafts), **delete**, **add** (reference existing items by calling `addBomItem`), **update**. This plan adds a new path inside the **add** batch.

### The two workspace ID bug (context for the fix in Task 7)

`mutate.ts:commitBomCloneItem` passes `wsIdChild: context.workspaceId` for every child item regardless of where that item actually lives. For the deep-duplicate path this is fine: all newly created items live in `context.workspaceId`. Do not change the existing reference path — that is a separate bug.

### Part detection rule

A node is a "Part" (reference-only) if `node.number` starts with `"99"`. `node.number` is populated from BOM field ID `732` via the v3 BOM API parser (`parseTree.ts`). The v1 parser sets `node.number = String(itemId)` — a numeric string that will never start with `"99"` for a genuine Part (item IDs are large integers). When v1 data is in use, all items will be treated as duplicatable; this is acceptable for an initial version and can be refined later.

### Item creation

`createItem` in `plm.item.ts` accepts `{ tenant, workspaceId, sections, fields }`. `sections` is the workspace template from `fetchSections`. `fields` is `Array<{ fieldId, value, type }>`. `buildItemSectionsPayload` merges `fields` into their correct section slots.

### No new background actions needed

`getItemDetails` and `createItem` are already in `ITEM_PAGE_PLM_ACTIONS` (allowlist). No changes to `plmActionAllowlist.ts`, `plm.ts`, or `plm.item.ts` are needed.

### No test framework currently installed

The project has no test runner. Task 1 installs Vitest. All subsequent tasks that include unit-testable pure functions get tests. React components and the full commit flow are verified by manual build + load in Chrome.

---

## File map

### New files
| Path | Purpose |
|---|---|
| `vitest.config.ts` | Vitest configuration |
| `src/features/bom/clone/services/deepDuplicate.service.ts` | Part detection, recursive duplication plan building, ordered operation list |
| `src/features/bom/clone/services/copyItem.service.ts` | Extract copyable fields from `getItemDetails` response |
| `src/features/bom/clone/services/__tests__/deepDuplicate.service.test.ts` | Unit tests for deepDuplicate.service |
| `src/features/bom/clone/services/__tests__/copyItem.service.test.ts` | Unit tests for copyItem.service |
| `src/features/bom/clone/view/phases/DeepDuplicatePanel.tsx` | Project reference input panel shown in structure phase |

### Modified files
| Path | Change |
|---|---|
| `package.json` | Add vitest dev dependency |
| `src/features/bom/clone/clone.types.ts` | Add `deepDuplicateEnabled`, `projectReference`, `projectReferenceFieldId` to `BomCloneStateSnapshot` |
| `src/features/bom/clone/clone.state.ts` | Add three setters for new state fields |
| `src/features/bom/clone/services/api/client.ts` | Add `getItemDetails` to `ApiClient` |
| `src/features/bom/clone/services/service.contract.ts` | Add `fetchItemFieldsForCopy` and `deepDuplicateSubtree` to `CloneService` |
| `src/features/bom/clone/services/api/read.ts` | Implement `fetchItemFieldsForCopy` |
| `src/features/bom/clone/services/api/mutate.ts` | Implement `deepDuplicateSubtree` |
| `src/features/bom/clone/services/commit.service.ts` | Branch the add-rows loop: deep-duplicate path vs reference path |
| `src/features/bom/clone/controller/commitFlow.ts` | Pass `deepDuplicateEnabled`, `projectReference`, `projectReferenceFieldId` to `executeCommitOperations` |
| `src/features/bom/clone/clone.view.tsx` | Add handlers for the three new state fields; pass to footer/structure phase |
| `src/features/bom/clone/view/phases/StructurePhase.tsx` | Render `DeepDuplicatePanel` |

---

## Chunk 1: Foundation — test runner + pure logic

### Task 1: Install and configure Vitest

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Install vitest**

```bash
cd /Users/mkblox/Code/Fusion-Manage-Chrome-Extensions
npm install --save-dev vitest
```

Expected: vitest appears in `package.json` devDependencies.

- [ ] **Step 2: Create vitest config**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
})
```

- [ ] **Step 3: Add test script to package.json**

In `package.json`, add to `"scripts"`:
```json
"test": "vitest run"
```

- [ ] **Step 4: Write smoke test to verify setup**

Create `src/features/bom/clone/services/__tests__/smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'

describe('test setup', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 5: Run tests and verify they pass**

```bash
npm test
```

Expected output: `1 passed`

- [ ] **Step 6: Delete the smoke test file**

```bash
rm src/features/bom/clone/services/__tests__/smoke.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add vitest for unit tests"
```

---

### Task 2: Part detection and duplicate plan logic

**Files:**
- Create: `src/features/bom/clone/services/deepDuplicate.service.ts`
- Create: `src/features/bom/clone/services/__tests__/deepDuplicate.service.test.ts`

#### What this module does

`isPartNode(node)` — returns `true` if `node.number` starts with `"99"` (case-insensitive trim).

`buildDuplicatePlan(nodes)` — recursively wraps each `BomCloneNode` in a `DuplicatePlanNode` that records `kind: 'duplicate' | 'reference'` for each node and its descendants.

`countDuplicateOperations(plan)` — counts how many `'duplicate'` nodes exist in the plan (used to show a summary in the UI before commit).

- [ ] **Step 1: Write the failing tests**

Create `src/features/bom/clone/services/__tests__/deepDuplicate.service.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests and confirm they fail**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../deepDuplicate.service'`

- [ ] **Step 3: Implement deepDuplicate.service.ts**

Create `src/features/bom/clone/services/deepDuplicate.service.ts`:

```typescript
import type { BomCloneNode } from '../clone.types'

export type ItemDuplicateKind = 'duplicate' | 'reference'

export type DuplicatePlanNode = {
  sourceNode: BomCloneNode
  kind: ItemDuplicateKind
  children: DuplicatePlanNode[]
}

export function isPartNode(node: Pick<BomCloneNode, 'number'>): boolean {
  const num = String(node.number ?? '').trim()
  if (!num) return false
  return num.toLowerCase().startsWith('99')
}

export function buildDuplicatePlan(nodes: BomCloneNode[]): DuplicatePlanNode[] {
  return nodes.map((node) => ({
    sourceNode: node,
    kind: isPartNode(node) ? 'reference' : 'duplicate',
    children: buildDuplicatePlan(node.children),
  }))
}

export function countDuplicateOperations(plan: DuplicatePlanNode[]): number {
  let count = 0
  for (const entry of plan) {
    if (entry.kind === 'duplicate') count += 1
    count += countDuplicateOperations(entry.children)
  }
  return count
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npm test
```

Expected: all tests in `deepDuplicate.service.test.ts` pass.

- [ ] **Step 5: Commit**

```bash
git add src/features/bom/clone/services/deepDuplicate.service.ts \
        src/features/bom/clone/services/__tests__/deepDuplicate.service.test.ts
git commit -m "feat: add part detection and duplicate plan builder"
```

---

### Task 3: Copyable field extraction

This module parses `getItemDetails` responses and returns an array of `{ fieldId, value }` pairs that are safe to copy to a new item. System fields (item number, revision, lifecycle state, audit fields) are excluded.

**Files:**
- Create: `src/features/bom/clone/services/copyItem.service.ts`
- Create: `src/features/bom/clone/services/__tests__/copyItem.service.test.ts`

#### Shape of a `getItemDetails` response (Fusion Manage v3)

```json
{
  "sections": [
    {
      "title": "Basic",
      "fields": [
        {
          "__self__": "/api/v3/workspaces/241/views/1/fields/TITLE",
          "title": "Title",
          "value": "My Assembly"
        },
        {
          "__self__": "/api/v3/workspaces/241/views/1/fields/DESCRIPTOR",
          "title": "Descriptor",
          "value": "AS-001"
        }
      ]
    }
  ]
}
```

Field IDs are extracted from the last path segment of `__self__`. Fields in `SKIP_FIELD_IDS` are excluded. Fields with a null/blank value are excluded.

- [ ] **Step 1: Write the failing tests**

Create `src/features/bom/clone/services/__tests__/copyItem.service.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests and confirm they fail**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../copyItem.service'`

- [ ] **Step 3: Implement copyItem.service.ts**

Create `src/features/bom/clone/services/copyItem.service.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npm test
```

Expected: all copyItem.service tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/features/bom/clone/services/copyItem.service.ts \
        src/features/bom/clone/services/__tests__/copyItem.service.test.ts
git commit -m "feat: add copyable field extractor for item duplication"
```

---

## Chunk 2: API and service layer

### Task 4: Add getItemDetails to ApiClient

`getItemDetails` is already registered as a PLM action (it's in `plmActionAllowlist.ts`) and already implemented in `plm.item.ts`. It just isn't exposed through the `ApiClient` abstraction that the BOM clone feature uses.

**Files:**
- Modify: `src/features/bom/clone/services/api/client.ts`

- [ ] **Step 1: Add getItemDetails to ApiClient type and implementation**

In `src/features/bom/clone/services/api/client.ts`, add to the `ApiClient` type:

```typescript
getItemDetails: (payload: Record<string, unknown>) => Promise<unknown>
```

And add to the `createApiClient` return object:

```typescript
getItemDetails(payload) {
  return runtime.requestPlmAction('getItemDetails', payload)
},
```

- [ ] **Step 2: Type-check**

```bash
npm run typecheck
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/features/bom/clone/services/api/client.ts
git commit -m "feat: expose getItemDetails through BOM clone ApiClient"
```

---

### Task 5: Add service contract methods for deep duplication

**Files:**
- Modify: `src/features/bom/clone/services/service.contract.ts`

Two new methods on `CloneService`:

**`fetchItemFieldsForCopy(context, itemId)`** — fetches item details and returns copyable fields. Used during the deep-duplicate commit phase.

**`deepDuplicateSubtree(context, plan, projectReferenceFieldId, projectReference)`** — recursively creates new items for all `'duplicate'` nodes, references Parts, and builds BOM relationships. Returns the new item ID for the root node.

- [ ] **Step 1: Add the two method signatures to CloneService**

In `src/features/bom/clone/services/service.contract.ts`, add after `fetchOperationFormDefinition`:

```typescript
fetchItemFieldsForCopy: (
  context: BomCloneContext,
  itemId: number
) => Promise<Array<{ fieldId: string; value: string }>>

deepDuplicateSubtree: (
  context: BomCloneContext,
  plan: import('./deepDuplicate.service').DuplicatePlanNode,
  projectReferenceFieldId: string,
  projectReference: string
) => Promise<number>
```

Also add the import for `DuplicatePlanNode` at the top of the file:

```typescript
import type { DuplicatePlanNode } from './deepDuplicate.service'
```

- [ ] **Step 2: Type-check**

```bash
npm run typecheck
```

Expected: errors about unimplemented methods in wherever `CloneService` is constructed. Note the files — they will be fixed in Tasks 6 and 7.

- [ ] **Step 3: Commit**

```bash
git add src/features/bom/clone/services/service.contract.ts
git commit -m "feat: add fetchItemFieldsForCopy and deepDuplicateSubtree to CloneService contract"
```

---

### Task 6: Implement fetchItemFieldsForCopy in read.ts

**Files:**
- Modify: `src/features/bom/clone/services/api/read.ts`

- [ ] **Step 1: Add fetchItemFieldsForCopy to the ReadApi type**

In `read.ts`, add `fetchItemFieldsForCopy` to the `ReadApi` type:

```typescript
type ReadApi = Pick<
  CloneService,
  | 'validateLinkableItem'
  | 'fetchWorkspaceBomViewDefIds'
  | 'fetchSourceBomStructure'
  | 'fetchSourceBomStructureAcrossViews'
  | 'fetchTargetBomChildItemIds'
  | 'fetchTargetBomChildItemIdsAcrossViews'
  | 'fetchLinkableItems'
  | 'fetchOperationFormDefinition'
  | 'fetchItemFieldsForCopy'   // ← add this
>
```

- [ ] **Step 2: Import extractCopyableFields**

Add at the top of `read.ts`:

```typescript
import { extractCopyableFields } from '../copyItem.service'
```

- [ ] **Step 3: Implement fetchItemFieldsForCopy in createReadApi**

Inside the `return` block of `createReadApi`, add:

```typescript
async fetchItemFieldsForCopy(context, itemId) {
  const payload = await client.getItemDetails({
    tenant: context.tenant,
    workspaceId: context.workspaceId,
    dmsId: itemId,
  })
  return extractCopyableFields(payload)
},
```

- [ ] **Step 4: Type-check**

```bash
npm run typecheck
```

Expected: the error about `fetchItemFieldsForCopy` being unimplemented in `read.ts` is gone.

- [ ] **Step 5: Commit**

```bash
git add src/features/bom/clone/services/api/read.ts \
        src/features/bom/clone/services/copyItem.service.ts
git commit -m "feat: implement fetchItemFieldsForCopy in BOM clone read API"
```

---

### Task 7: Implement deepDuplicateSubtree in mutate.ts

This is the core recursive logic. For each `DuplicatePlanNode`:
- If `kind === 'reference'`: return the original item's ID directly (no creation).
- If `kind === 'duplicate'`:
  1. Fetch copyable fields for the source item.
  2. Build the `fields` array: copied fields + the project reference field override.
  3. Call `createBomCloneOperationItem` to create the new item.
  4. For each child in `plan.children`, recursively call `deepDuplicateSubtree` to get the child's new ID (or original ID if reference).
  5. For each child, call `addBomItem` with `dmsIdParent = newItemId` and `dmsIdChild = childId`.
  6. Return `newItemId`.

**Files:**
- Modify: `src/features/bom/clone/services/api/mutate.ts`

- [ ] **Step 1: Add deepDuplicateSubtree to MutateApi type**

In `mutate.ts`, update the `MutateApi` type:

```typescript
type MutateApi = Pick<
  CloneService,
  | 'createBomCloneOperationItem'
  | 'commitBomCloneItem'
  | 'updateBomCloneItem'
  | 'deleteBomCloneItem'
  | 'deepDuplicateSubtree'   // ← add this
>
```

- [ ] **Step 2: Import needed types**

Add at the top of `mutate.ts`:

```typescript
import type { DuplicatePlanNode } from '../../deepDuplicate.service'
```

- [ ] **Step 3: Update createMutateApi signature to receive fetchItemFieldsForCopy**

`deepDuplicateSubtree` needs to call `fetchItemFieldsForCopy`, which is on the read API. Pass it as a parameter to `createMutateApi`:

```typescript
export function createMutateApi(params: {
  client: ApiClient
  fetchItemFieldsForCopy: CloneService['fetchItemFieldsForCopy']
}): MutateApi {
  const { client, fetchItemFieldsForCopy } = params
  // ... rest unchanged
```

- [ ] **Step 4: Implement deepDuplicateSubtree**

Add inside the `return` block of `createMutateApi`:

```typescript
async deepDuplicateSubtree(context, plan, projectReferenceFieldId, projectReference) {
  // Reference nodes: return the original item ID, no creation needed.
  if (plan.kind === 'reference') {
    const itemId = Number(plan.sourceNode.id)
    if (!Number.isFinite(itemId) || itemId <= 0) {
      throw new Error(`Cannot resolve item ID for reference node: ${plan.sourceNode.label}`)
    }
    return itemId
  }

  // Duplicate node: create a new item copying fields from the source.
  const sourceItemId = Number(plan.sourceNode.id)
  if (!Number.isFinite(sourceItemId) || sourceItemId <= 0) {
    throw new Error(`Cannot resolve source item ID for: ${plan.sourceNode.label}`)
  }

  const copiedFields = await fetchItemFieldsForCopy(context, sourceItemId)

  // Merge copied fields with the project reference (project reference wins on conflict).
  const fieldMap = new Map(copiedFields.map((f) => [f.fieldId, f.value]))
  if (projectReferenceFieldId.trim() && projectReference.trim()) {
    fieldMap.set(projectReferenceFieldId.trim(), projectReference.trim())
  }
  const fields = Array.from(fieldMap.entries()).map(([fieldId, value]) => ({
    fieldId,
    value,
    type: 'string' as const,
  }))

  const sectionsResult = await client.fetchSections({
    tenant: context.tenant,
    workspaceId: context.workspaceId,
  })
  const sections = Array.isArray(sectionsResult) ? sectionsResult : []

  const newItemId = await client.createItem({
    tenant: context.tenant,
    workspaceId: context.workspaceId,
    sections,
    fields,
  }).then((result) => {
    // createItem returns { location: url } or the full item if getDetails=true.
    // resolveCreatedItemId handles both shapes.
    return resolveCreatedItemId(result)
  })

  if (!newItemId || newItemId <= 0) {
    throw new Error(`Item creation returned invalid ID for: ${plan.sourceNode.label}`)
  }

  // Recursively process children and link them to the new item.
  for (const childPlan of plan.children) {
    const childItemId = await (this as MutateApi).deepDuplicateSubtree(
      context,
      childPlan,
      projectReferenceFieldId,
      projectReference
    )

    await client.addBomItem({
      tenant: context.tenant,
      wsIdParent: context.workspaceId,
      wsIdChild: context.workspaceId,
      dmsIdParent: newItemId,
      dmsIdChild: childItemId,
      number: 1,
      quantity: childPlan.sourceNode.quantity || '1',
    })
  }

  return newItemId
},
```

> **Note on `this`:** The recursive call uses `this` which is not available in a plain object literal. Refactor to use a named local function instead:

Replace the `return { ... }` pattern with a named function approach:

```typescript
export function createMutateApi(params: {
  client: ApiClient
  fetchItemFieldsForCopy: CloneService['fetchItemFieldsForCopy']
}): MutateApi {
  const { client, fetchItemFieldsForCopy } = params

  async function deepDuplicateSubtreeImpl(
    context: Parameters<CloneService['deepDuplicateSubtree']>[0],
    plan: DuplicatePlanNode,
    projectReferenceFieldId: string,
    projectReference: string
  ): Promise<number> {
    if (plan.kind === 'reference') {
      const itemId = Number(plan.sourceNode.id)
      if (!Number.isFinite(itemId) || itemId <= 0) {
        throw new Error(`Cannot resolve item ID for reference node: ${plan.sourceNode.label}`)
      }
      return itemId
    }

    const sourceItemId = Number(plan.sourceNode.id)
    if (!Number.isFinite(sourceItemId) || sourceItemId <= 0) {
      throw new Error(`Cannot resolve source item ID for: ${plan.sourceNode.label}`)
    }

    const copiedFields = await fetchItemFieldsForCopy(context, sourceItemId)
    const fieldMap = new Map(copiedFields.map((f) => [f.fieldId, f.value]))
    if (projectReferenceFieldId.trim() && projectReference.trim()) {
      fieldMap.set(projectReferenceFieldId.trim(), projectReference.trim())
    }
    const fields = Array.from(fieldMap.entries()).map(([fieldId, value]) => ({
      fieldId,
      value,
      type: 'string' as const,
    }))

    const sectionsResult = await client.fetchSections({
      tenant: context.tenant,
      workspaceId: context.workspaceId,
    })
    const sections = Array.isArray(sectionsResult) ? sectionsResult : []

    const createResult = await client.createItem({
      tenant: context.tenant,
      workspaceId: context.workspaceId,
      sections,
      fields,
    })
    const newItemId = resolveCreatedItemId(createResult)
    if (!newItemId || newItemId <= 0) {
      throw new Error(`Item creation returned invalid ID for: ${plan.sourceNode.label}`)
    }

    for (const childPlan of plan.children) {
      const childItemId = await deepDuplicateSubtreeImpl(
        context,
        childPlan,
        projectReferenceFieldId,
        projectReference
      )
      await client.addBomItem({
        tenant: context.tenant,
        wsIdParent: context.workspaceId,
        wsIdChild: context.workspaceId,
        dmsIdParent: newItemId,
        dmsIdChild: childItemId,
        number: 1,
        quantity: childPlan.sourceNode.quantity || '1',
      })
    }

    return newItemId
  }

  return {
    // ... existing methods unchanged ...

    deepDuplicateSubtree: deepDuplicateSubtreeImpl,
  }
}
```

- [ ] **Step 5: Fix createMutateApi call site**

Find where `createMutateApi` is called (it's in `src/features/bom/clone/clone.service.ts` or `clone.feature.ts` — search for `createMutateApi`). Pass `fetchItemFieldsForCopy` from the read API:

```bash
grep -rn "createMutateApi" /Users/mkblox/Code/Fusion-Manage-Chrome-Extensions/src/
```

Update that call to pass `fetchItemFieldsForCopy`:

```typescript
const mutateApi = createMutateApi({
  client,
  fetchItemFieldsForCopy: readApi.fetchItemFieldsForCopy,
})
```

- [ ] **Step 6: Type-check**

```bash
npm run typecheck
```

Expected: no errors related to `deepDuplicateSubtree` or `fetchItemFieldsForCopy`.

- [ ] **Step 7: Commit**

```bash
git add src/features/bom/clone/services/api/mutate.ts \
        src/features/bom/clone/services/api/client.ts
git commit -m "feat: implement deepDuplicateSubtree in BOM clone mutate API"
```

---

## Chunk 3: State and commit integration

### Task 8: Add deep duplicate state fields

Three new fields on `BomCloneStateSnapshot` and corresponding setters on `CloneState`.

**Files:**
- Modify: `src/features/bom/clone/clone.types.ts`
- Modify: `src/features/bom/clone/clone.state.ts`

- [ ] **Step 1: Add fields to BomCloneStateSnapshot**

In `clone.types.ts`, add to `BomCloneStateSnapshot` (after `showCommitErrorsOnly`):

```typescript
deepDuplicateEnabled: boolean
projectReferenceFieldId: string
projectReference: string
```

- [ ] **Step 2: Add setters to CloneState type**

In `clone.state.ts`, add to the `CloneState` type:

```typescript
setDeepDuplicateEnabled: (enabled: boolean) => void
setProjectReferenceFieldId: (fieldId: string) => void
setProjectReference: (value: string) => void
```

- [ ] **Step 3: Add defaults to the initial state**

In `clone.state.ts`, wherever the initial state object is built (look for the `reset()` function or the initial snapshot), add:

```typescript
deepDuplicateEnabled: false,
projectReferenceFieldId: '',
projectReference: '',
```

- [ ] **Step 4: Implement the three setters**

In the state factory function body in `clone.state.ts`, add:

```typescript
setDeepDuplicateEnabled(enabled) {
  snapshot.deepDuplicateEnabled = enabled
},
setProjectReferenceFieldId(fieldId) {
  snapshot.projectReferenceFieldId = fieldId
},
setProjectReference(value) {
  snapshot.projectReference = value
},
```

- [ ] **Step 5: Persist projectReferenceFieldId to localStorage**

The user should not have to re-enter the field ID every time. Update `setProjectReferenceFieldId` to also save to `localStorage`:

```typescript
setProjectReferenceFieldId(fieldId) {
  snapshot.projectReferenceFieldId = fieldId
  try {
    window.localStorage.setItem('plmExtension.deepDuplicate.fieldId', fieldId)
  } catch {
    // Non-critical; ignore storage errors.
  }
},
```

And in the state initializer, restore it:

```typescript
function readSavedFieldId(): string {
  try {
    return window.localStorage.getItem('plmExtension.deepDuplicate.fieldId') ?? ''
  } catch {
    return ''
  }
}

// In the initial state:
projectReferenceFieldId: readSavedFieldId(),
```

- [ ] **Step 6: Type-check**

```bash
npm run typecheck
```

Expected: errors about missing setters in the factory function — fix any remaining ones.

- [ ] **Step 7: Commit**

```bash
git add src/features/bom/clone/clone.types.ts \
        src/features/bom/clone/clone.state.ts
git commit -m "feat: add deep duplicate state fields with localStorage persistence"
```

---

### Task 9: Modify commit flow to use deep duplicate path

**Files:**
- Modify: `src/features/bom/clone/services/commit.service.ts`
- Modify: `src/features/bom/clone/controller/commitFlow.ts`

#### Logic change in executeCommitOperations

In the **add-rows batch**, for each node:
- If `snapshot.deepDuplicateEnabled` is `true` AND the node is not a Part (`!isPartNode(node)`):
  1. Build a `DuplicatePlanNode` from the node using `buildDuplicatePlan([node])[0]`.
  2. Call `dataService.deepDuplicateSubtree(activeContext, plan, projectReferenceFieldId, projectReference)` → get `newItemId`.
  3. Call `dataService.commitBomCloneItem(activeContext, { sourceItemId: newItemId, ... })` to add the new top-level item to the target BOM.
- Otherwise: existing `commitBomCloneItem(activeContext, { sourceItemId: originalId, ... })` unchanged.

Note: `deepDuplicateSubtree` already handles the entire subtree including all BOM links between newly created items. The final `commitBomCloneItem` call at the top level only adds the new root item to the target's BOM.

- [ ] **Step 1: Import isPartNode and buildDuplicatePlan in commit.service.ts**

Add to imports in `commit.service.ts`:

```typescript
import { isPartNode, buildDuplicatePlan } from './deepDuplicate.service'
```

- [ ] **Step 2: Extend BomCloneMutationService to include deepDuplicateSubtree**

In `commit.service.ts`, update `BomCloneMutationService`:

```typescript
export type BomCloneMutationService = Pick<
  CloneService,
  | 'createBomCloneOperationItem'
  | 'commitBomCloneItem'
  | 'updateBomCloneItem'
  | 'deleteBomCloneItem'
  | 'deepDuplicateSubtree'   // ← add this
>
```

- [ ] **Step 3: Branch the add-rows loop**

In `executeCommitOperations`, find the `for (const batch of chunkIntoBatches(addRows, ...))` loop. Inside the `async (node) => { ... }` handler, replace the existing logic with:

```typescript
async (node) => {
  try {
    const fallbackItemNumber = executionPlan.fallbackForNode(node.id)
    const effectiveItemNumber = snapshot.targetItemNumberOverrides[node.id] ?? node.itemNumber ?? `1.${fallbackItemNumber}`
    const commitItemNumber = parseCommitItemNumber(effectiveItemNumber, fallbackItemNumber)
    const quantityFallback = node.stagedOperationDraft ? '1.0' : DEFAULT_CLONE_QUANTITY
    const effectiveQuantity = String(snapshot.targetQuantityOverrides[node.id] ?? node.quantity ?? '').trim() || quantityFallback
    const commitQuantity = normalizeQuantity(effectiveQuantity, quantityFallback)

    let sourceItemId: number

    if (snapshot.deepDuplicateEnabled && !isPartNode(node)) {
      // Deep duplicate path: create a copy of the subtree rooted at this node.
      const plan = buildDuplicatePlan([node])[0]
      if (!plan) throw new Error(`Failed to build duplicate plan for node: ${node.label}`)
      sourceItemId = await dataService.deepDuplicateSubtree(
        activeContext,
        plan,
        snapshot.projectReferenceFieldId,
        snapshot.projectReference
      )
    } else {
      // Reference path (original behaviour).
      const resolved = resolveNumericItemIdFromNode(node)
      if (!resolved || resolved <= 0) throw new Error(`Unable to resolve source item id for ${node.label || node.id}`)
      sourceItemId = resolved
    }

    const parentItemId = resolveManufacturingParentItemId({
      snapshot,
      node,
      createdProcessItemIdByNodeId,
      failedProcessMessageByNodeId,
    })

    await dataService.commitBomCloneItem(activeContext, {
      sourceItemId,
      itemNumber: commitItemNumber,
      quantity: commitQuantity,
      ...(typeof parentItemId === 'number' ? { parentItemId } : {}),
      pinned: resolvePinnedForNode(node),
      fields: getCommittableFieldsForNode(node.id),
    })
    successes.push({ operation: 'add', nodeId: node.id })
  } catch (error) {
    errors.push(...buildOperationErrors({ operation: 'new', node, error }))
  } finally {
    markOperationComplete()
  }
}
```

- [ ] **Step 4: Update countExecutableCommitOperations to account for deep dup**

When `deepDuplicateEnabled` is true, each non-Part add-row will generate `1 + N` operations (create + N child creates). For now, keep the count conservative — just count top-level operations as before. The progress bar will be approximate; this is acceptable for V1.

No change needed here; just confirm existing count function still compiles.

- [ ] **Step 5: Type-check**

```bash
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/features/bom/clone/services/commit.service.ts
git commit -m "feat: branch commit add-rows loop for deep item duplication"
```

---

## Chunk 4: UI

### Task 10: Build DeepDuplicatePanel component

A small panel that appears below the BOM structure panes, above the footer. Shows:
- A checkbox: "Enable deep duplication (copy assemblies)"
- When checked:
  - Input: "Project Reference Field ID" (e.g. `PROJECT_REF`)
  - Input: "Project Reference Value"
  - Summary line: "X items will be duplicated, Y parts will be referenced"

**Files:**
- Create: `src/features/bom/clone/view/phases/DeepDuplicatePanel.tsx`

- [ ] **Step 1: Implement DeepDuplicatePanel**

Create `src/features/bom/clone/view/phases/DeepDuplicatePanel.tsx`:

```tsx
import React from 'react'
import type { BomCloneStateSnapshot } from '../../clone.types'
import { buildDuplicatePlan, countDuplicateOperations } from '../../services/deepDuplicate.service'
import { getTargetSelectedTree } from '../../services/structure/selection.service'

export type DeepDuplicatePanelHandlers = {
  onToggleDeepDuplicate: (enabled: boolean) => void
  onProjectReferenceFieldIdChange: (fieldId: string) => void
  onProjectReferenceChange: (value: string) => void
}

export type DeepDuplicatePanelProps = {
  snapshot: BomCloneStateSnapshot
  handlers: DeepDuplicatePanelHandlers
}

export function DeepDuplicatePanel(props: DeepDuplicatePanelProps): React.JSX.Element {
  const { snapshot, handlers } = props

  const selectedNodes = getTargetSelectedTree(
    snapshot.sourceBomTree,
    snapshot.selectedNodesToClone
  )
  const plan = buildDuplicatePlan(selectedNodes)
  const duplicateCount = countDuplicateOperations(plan)
  const referenceCount = selectedNodes.length === 0
    ? 0
    : plan.filter((p) => p.kind === 'reference').length
  // Count all reference nodes recursively
  function countRefNodes(nodes: ReturnType<typeof buildDuplicatePlan>): number {
    let n = 0
    for (const node of nodes) {
      if (node.kind === 'reference') n += 1
      n += countRefNodes(node.children)
    }
    return n
  }
  const totalRefCount = countRefNodes(plan)

  return (
    <div
      className="plm-extension-deep-dup-panel"
      style={{
        borderTop: '1px solid #d8e1eb',
        padding: '10px 0 6px',
        marginTop: '8px',
        fontFamily: '"ArtifaktElement","Segoe UI",Arial,sans-serif',
        fontSize: '13px',
      }}
    >
      <label
        style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 600, color: '#19222e' }}
      >
        <input
          type="checkbox"
          checked={snapshot.deepDuplicateEnabled}
          onChange={(e) => handlers.onToggleDeepDuplicate(e.target.checked)}
          style={{ width: '15px', height: '15px' }}
        />
        Enable deep duplication (copy assemblies, reference parts)
      </label>

      {snapshot.deepDuplicateEnabled && (
        <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '3px', flex: '0 0 auto' }}>
              <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: '#526176', letterSpacing: '0.03em' }}>
                Project Reference Field ID
              </span>
              <input
                type="text"
                value={snapshot.projectReferenceFieldId}
                onChange={(e) => handlers.onProjectReferenceFieldIdChange(e.target.value)}
                placeholder="e.g. PROJECT_REF"
                style={{
                  height: '32px',
                  padding: '0 10px',
                  border: '1px solid #cfd8e3',
                  borderRadius: '8px',
                  fontSize: '12px',
                  width: '200px',
                  boxSizing: 'border-box',
                }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '3px', flex: '1 1 200px' }}>
              <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: '#526176', letterSpacing: '0.03em' }}>
                Project Reference Value
              </span>
              <input
                type="text"
                value={snapshot.projectReference}
                onChange={(e) => handlers.onProjectReferenceChange(e.target.value)}
                placeholder="e.g. PRJ-2026-001"
                style={{
                  height: '32px',
                  padding: '0 10px',
                  border: '1px solid #cfd8e3',
                  borderRadius: '8px',
                  fontSize: '12px',
                  width: '100%',
                  boxSizing: 'border-box',
                }}
              />
            </label>
          </div>

          {selectedNodes.length > 0 && (
            <p style={{ margin: 0, color: '#384456', fontSize: '12px' }}>
              <strong>{duplicateCount}</strong> item{duplicateCount !== 1 ? 's' : ''} will be duplicated
              {totalRefCount > 0 && (
                <>, <strong>{totalRefCount}</strong> part{totalRefCount !== 1 ? 's' : ''} will be referenced</>
              )}
              .
            </p>
          )}

          {snapshot.deepDuplicateEnabled && !snapshot.projectReferenceFieldId.trim() && (
            <p style={{ margin: 0, color: '#F9A825', fontSize: '12px' }}>
              ⚠ Enter a Project Reference Field ID to set the field on duplicated items.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/features/bom/clone/view/phases/DeepDuplicatePanel.tsx
git commit -m "feat: add DeepDuplicatePanel UI component"
```

---

### Task 11: Wire DeepDuplicatePanel into StructurePhase and clone.view.tsx

**Files:**
- Modify: `src/features/bom/clone/view/phases/StructurePhase.tsx`
- Modify: `src/features/bom/clone/clone.view.tsx`
- Modify: `src/features/bom/clone/controller/commitFlow.ts`

#### StructurePhase.tsx

Add `DeepDuplicatePanelHandlers` to `CloneStructureHandlers` (or pass them as a separate prop) and render `<DeepDuplicatePanel>` between the structure panes and the footer.

- [ ] **Step 1: Add DeepDuplicatePanel to StructurePhase**

In `src/features/bom/clone/view/phases/StructurePhase.tsx`, add:

```tsx
import { DeepDuplicatePanel, type DeepDuplicatePanelHandlers } from './DeepDuplicatePanel'
```

Add `deepDuplicateHandlers: DeepDuplicatePanelHandlers` to `CloneStructurePhaseContentProps`.

In the `CloneStructurePhaseContent` render, after `</div>` (the `plm-extension-bom-structure-content` div), add:

```tsx
<DeepDuplicatePanel
  snapshot={snapshot}
  handlers={props.deepDuplicateHandlers}
/>
```

- [ ] **Step 2: Add handlers in clone.view.tsx**

In `src/features/bom/clone/clone.view.tsx`, add three handler functions (inside the main component or hook):

```typescript
onToggleDeepDuplicate(enabled: boolean) {
  state.setDeepDuplicateEnabled(enabled)
  render()
},
onProjectReferenceFieldIdChange(fieldId: string) {
  state.setProjectReferenceFieldId(fieldId)
  render()
},
onProjectReferenceChange(value: string) {
  state.setProjectReference(value)
  render()
},
```

Pass these as `deepDuplicateHandlers` to `CloneStructurePhaseContent`.

- [ ] **Step 3: Add validation in commitFlow.ts**

In `commitFlow.ts`, inside `commitClone()`, add a guard before the commit proceeds:

```typescript
if (snapshotBeforeCommit.deepDuplicateEnabled && !snapshotBeforeCommit.projectReference.trim()) {
  state.setErrorMessage('Enter a Project Reference Value before committing with deep duplication enabled.')
  render()
  return
}
```

- [ ] **Step 4: Type-check**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/features/bom/clone/view/phases/StructurePhase.tsx \
        src/features/bom/clone/clone.view.tsx \
        src/features/bom/clone/controller/commitFlow.ts
git commit -m "feat: wire DeepDuplicatePanel into BOM clone structure phase"
```

---

## Chunk 5: Build, verify, and wrap up

### Task 12: Build and smoke test in Chrome

- [ ] **Step 1: Run full type-check**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: all unit tests pass.

- [ ] **Step 3: Build the extension**

```bash
npm run build
```

Expected: `dist/` folder updated with no build errors.

- [ ] **Step 4: Reload extension in Chrome**

1. Open `chrome://extensions`
2. Find "Fusion Manage Chromium Extensions"
3. Click the refresh/reload icon
4. Navigate to a Fusion Manage item BOM page

- [ ] **Step 5: Smoke test the UI (no commit)**

1. Open the BOM Clone modal (engineering mode)
2. Search for and select a source item
3. Click "Validate"
4. In the structure phase, verify the "Enable deep duplication" checkbox appears below the BOM panes
5. Check the checkbox — verify the field ID and value inputs appear
6. Enter a Field ID and project reference value
7. Check the summary line shows correct duplicate/reference counts for staged rows
8. Close without committing

- [ ] **Step 6: Smoke test a shallow commit (single-level, one item)**

1. Find a source item that is NOT a Part (e.g. a Subassembly with no children)
2. Stage it in the target BOM
3. Enable deep duplication, enter a Field ID and value
4. Commit
5. In Fusion Manage, verify:
   - A new item was created in the workspace
   - The new item has the project reference field set
   - The target BOM now references the NEW item, not the original

- [ ] **Step 7: Smoke test a two-level commit (assembly + part child)**

1. Find a source Subassembly that has at least one Part child (number starts with 99)
2. Stage it, enable deep duplication, commit
3. In Fusion Manage, verify:
   - The Subassembly was duplicated (new item)
   - The Part was NOT duplicated — the original Part is referenced in the new Subassembly's BOM

- [ ] **Step 8: Final commit**

```bash
git add -p   # review all remaining changes
git commit -m "feat: deep item duplication for BOM clone with project reference"
```

---

## Known limitations (V1)

| Limitation | Impact | Future fix |
|---|---|---|
| V1 BOM API path sets `node.number` to the dmsId integer, not item number | All items loaded via v1 path treated as duplicatable | Enrich v1 parser to fetch item numbers, or always prefer v3 path |
| `countExecutableCommitOperations` does not count deep-dup child operations | Progress bar is approximate when deep dup is enabled | Pass duplicate plan to count function |
| No rollback if mid-tree creation fails | Partially created items may be left in Fusion Manage | Add an undo/cleanup step after partial failure |
| Field type mapping is always `'string'` | Picklist, boolean, and numeric fields may fail on create | Use workspace field metadata to infer correct type |
| Project reference field ID not validated against workspace schema | Silent failure if field ID is wrong (item creation may still succeed but field not set) | Validate field ID against `fetchFields` response before commit |
