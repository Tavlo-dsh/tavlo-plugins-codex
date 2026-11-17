/** Lightning switch immediately left of the host model seat using theme tokens. */
export const FAST_STYLES = `
.tavlo-codex-fast-row {
  position: relative; display: grid; place-items: center;
  flex: 0 0 26px; width: 26px; height: 28px; margin: 0; padding: 0;
}
.tavlo-codex-fast-switch {
  position: relative; display: grid; place-items: center; width: 26px; height: 28px;
  padding: 6px; cursor: pointer;
  border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent;
  color: var(--dsw-alias-label-caption); outline: none;
  transition: color 120ms ease;
}
.tavlo-codex-fast-switch svg { width: 14px; height: 14px; overflow: visible; }
.tavlo-codex-fast-switch path {
  fill: transparent; stroke: currentColor; stroke-width: 1.35;
  stroke-linejoin: round; vector-effect: non-scaling-stroke;
  transition: fill 120ms ease;
}
.tavlo-codex-fast-switch[aria-checked="true"] {
  color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary, currentColor));
}
.tavlo-codex-fast-switch[aria-checked="true"] path { fill: currentColor; stroke: currentColor; }
.tavlo-codex-fast-switch:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.tavlo-codex-fast-switch:disabled { cursor: default; opacity: .48; }
.tavlo-codex-fast-row[aria-busy="true"] .tavlo-codex-fast-switch:not(:disabled) svg {
  animation: tavlo-codex-fast-pulse 700ms ease-in-out infinite alternate;
}
.tavlo-codex-fast-status {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
@keyframes tavlo-codex-fast-pulse {
  from { opacity: .45; transform: scale(.9); }
  to { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .tavlo-codex-fast-switch, .tavlo-codex-fast-switch path { transition: none; }
  .tavlo-codex-fast-row[aria-busy="true"] .tavlo-codex-fast-switch:not(:disabled) svg { animation: none; }
}
.tavlo-codex-stats {
  display: inline-flex; align-items: center; min-width: 0; gap: 8px;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}
.tavlo-codex-stat-anchor {
  display: inline-flex; min-width: 0;
  font-size: inherit; line-height: inherit;
}
.tavlo-codex-stat {
  display: inline-flex; align-items: center; gap: 5px; min-width: 0; padding: 1px 5px;
  border: 0; border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-label-tertiary); font: inherit; line-height: inherit;
  font-variant-numeric: tabular-nums; cursor: pointer;
}
.tavlo-codex-stat > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tavlo-codex-stat > svg { flex: none; width: 14px; height: 14px; }
.tavlo-codex-stat:hover, .tavlo-codex-stat:focus-visible,
.tavlo-codex-stat[aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.tavlo-codex-stat:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, currentColor); outline-offset: 2px; }
.tavlo-codex-stat-panel {
  position: fixed; z-index: 1100; box-sizing: border-box;
  width: max-content; min-width: min(300px, calc(100vw - 24px));
  max-width: min(420px, calc(100vw - 24px));
  padding: 16px; border: 0; border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu); backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-secondary); cursor: default;
  max-height: calc(100dvh - 12px - max(12px, var(--dsh-frame-overlay-top, 12px)));
  overflow-x: hidden; overflow-y: auto;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  position-area: none;
  top: max(12px, var(--dsh-frame-overlay-top, 12px));
  bottom: max(12px, calc(anchor(top) + 8px));
  left: max(12px, anchor(left)); right: 12px;
  position-try-fallbacks:
    --tavlo-codex-stat-window, --tavlo-codex-stat-opposite,
    --tavlo-codex-stat-wide-opposite, --tavlo-codex-stat-tall,
    --tavlo-codex-stat-viewport;
  align-self: end; justify-self: start; height: fit-content; min-height: 0; margin: 0;
  font-size: 12px; line-height: 18px;
}
.tavlo-codex-stat-title {
  display: flex; justify-content: space-between; align-items: center; gap: 16px;
  margin-bottom: 8px; color: var(--dsw-alias-label-primary); font-weight: 500;
}
.tavlo-codex-stat-title-label {
  display: inline-flex; align-items: center; gap: 6px; min-width: 0;
}
.tavlo-codex-stat-title-label svg { flex: none; width: 14px; height: 14px; }
.tavlo-codex-stat-title-value { font-variant-numeric: tabular-nums; white-space: nowrap; }
.tavlo-codex-stat-rule { margin-bottom: 10px; border-top: .5px solid var(--dsw-alias-border-l2); }
.tavlo-codex-stat-details {
  display: grid; grid-template-columns: minmax(92px, auto) minmax(0, 1fr);
  gap: 6px 16px; margin: 0; color: var(--dsw-alias-label-tertiary);
}
.tavlo-codex-stat-details dt, .tavlo-codex-stat-details dd { min-width: 0; margin: 0; }
.tavlo-codex-stat-details dd {
  color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums;
  text-align: right;
}
.tavlo-codex-stat-note {
  margin: 10px 0 0; color: var(--dsw-alias-label-tertiary);
  font-size: 12px; line-height: 18px;
}
@position-try --tavlo-codex-stat-window {
  position-area: none;
  top: max(12px, var(--dsh-frame-overlay-top, 12px));
  bottom: max(12px, calc(anchor(top) + 8px));
  left: 12px; right: 12px; margin: 0;
  align-self: safe end; justify-self: safe end;
}
@position-try --tavlo-codex-stat-opposite {
  top: max(12px, calc(anchor(bottom) + 8px));
  bottom: 12px; align-self: start;
}
@position-try --tavlo-codex-stat-wide-opposite {
  top: max(12px, calc(anchor(bottom) + 8px));
  bottom: 12px; left: 12px; right: 12px;
  align-self: start; justify-self: safe end;
}
@position-try --tavlo-codex-stat-tall {
  position-area: none;
  top: max(12px, var(--dsh-frame-overlay-top, 12px));
  bottom: 12px; left: max(12px, anchor(left)); right: 12px;
  margin: 0; align-self: safe start; justify-self: start;
}
@position-try --tavlo-codex-stat-viewport {
  position-area: none;
  inset: max(12px, var(--dsh-frame-overlay-top, 12px)) 12px 12px;
  margin: 0; align-self: safe start; justify-self: safe end;
}
`
