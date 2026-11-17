/** Derive the switch from persisted session state and the live plugin default. */
import type { NativeView } from '../native-state.ts'

export function speedView(state: NativeView): { checked: boolean; inherited: boolean } {
  const { speed } = state
  if (speed.selected !== 'inherit') return { checked: speed.selected === 'fast', inherited: false }
  if (state.fastModeDefault !== undefined) return { checked: state.fastModeDefault, inherited: false }
  if (speed.effectiveTier !== undefined) return { checked: speed.effectiveTier === 'fast' || speed.effectiveTier === 'priority', inherited: false }
  return { checked: false, inherited: true }
}
