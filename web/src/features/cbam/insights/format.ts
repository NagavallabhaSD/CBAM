/**
 * Chart colours (validated with the dataviz palette checker: light and dark pass).
 * Slot 1 blue for a single measure; slot 1 + slot 2 for the two tornado arms.
 * Texts always use text tokens, never the series colour.
 */
export const VIZ_VARS =
  '[--viz-1:#2a78d6] [--viz-2:#eb6834] [--viz-grid:#e4e3df] dark:[--viz-1:#3987e5] dark:[--viz-2:#d95926] dark:[--viz-grid:#383835]'

export const fmt = (n: number, d = 2) =>
  n.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
