import type { PlmExtRuntime } from '../../../../shared/runtime/types'
import type { createItemSelectorSession } from '../../../../shared/item-selector/session'
import type { createCloneState } from '../clone.state'
import type { createCloneView } from '../clone.view'
import type {
  BomCloneCapabilityState,
  BomCloneContext,
  BomCloneDiagnosticCode
} from '../clone.types'

export type CloneRuntime = Pick<PlmExtRuntime, 'requestPlmAction' | 'openModal' | 'closeModal' | 'findByIdDeep'>
export type CloneState = ReturnType<typeof createCloneState>
export type CloneView = ReturnType<typeof createCloneView>
export type CloneViewHandlers = Parameters<CloneView['render']>[2]
export type ItemSelectorSession = ReturnType<typeof createItemSelectorSession>
export type SetHealthState = (next: BomCloneCapabilityState) => void
export type EmitDiagnostic = (code: BomCloneDiagnosticCode, detail: string) => void

export type CloneControllerRefs = {
  getContext: () => BomCloneContext | null
  setContext: (next: BomCloneContext | null) => void
  getSearchModalRoot: () => HTMLDivElement | null
  setSearchModalRoot: (next: HTMLDivElement | null) => void
  getStructureModalRoot: () => HTMLDivElement | null
  setStructureModalRoot: (next: HTMLDivElement | null) => void
  getHasCommittedOperations: () => boolean
  setHasCommittedOperations: (next: boolean) => void
  getLinkableSearchDebounceTimer: () => number | null
  setLinkableSearchDebounceTimer: (next: number | null) => void
}
