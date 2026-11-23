import type { Sku, Submission } from './supabase'

export const recPc = (cat: string | null) => (cat === 'Breakfast' ? 0.27 : 0.25)

/** Same logic as the New Listing Tracker: Cost W/ Rebate = Cost*(1-R); Final = *1.15; price = ROUND(final/(1-REC))-0.05 */
export function computePrice(cost: number | null, rebate: number | null, cat: string | null, override?: number | null) {
  if (cost == null || rebate == null || isNaN(cost)) return null
  const finalCost = cost * (1 - rebate) * 1.15
  const rec = recPc(cat)
  const price = override != null && !isNaN(override) && override > 0 ? override : Math.round(finalCost / (1 - rec)) - 0.05
  const pc1 = (price - finalCost) / price
  return { finalCost, rec, price, pc1 }
}

export const effRebate = (s: Sku, sub: Submission) => (s.rebate_pct ?? sub.rebate_pct ?? null)

export function eanValid(code: string | null): boolean {
  if (!code) return false
  let c = code.replace(/\D/g, '')
  if (c.length === 11) c = '0' + c
  if (!/^\d{8}$|^\d{12,14}$/.test(c)) return false
  const digits = c.split('').map(Number)
  const check = digits.pop()!
  let sum = 0
  digits.reverse().forEach((d, i) => (sum += d * (i % 2 === 0 ? 3 : 1)))
  return (10 - (sum % 10)) % 10 === check
}

export type Missing = { key: string; label: string }
export function missingFor(s: Partial<Sku>): Missing[] {
  const m: Missing[] = []
  if (!(s.title || s.title_vendor)) m.push({ key: 'title', label: 'Title' })
  if (!s.weight_g) m.push({ key: 'weight', label: 'Weight' })
  if (s.cost == null) m.push({ key: 'cost', label: 'Cost' })
  if (!s.barcode) m.push({ key: 'barcode', label: 'Barcode' })
  if (!s.img_front) m.push({ key: 'front', label: 'Front img' })
  if (!s.img_ingredients) m.push({ key: 'ingredients', label: 'Ingredients img' })
  if (!s.img_nutrition) m.push({ key: 'nutrition', label: 'Nutrition img' })
  return m
}

export const fmt = (n: number | null | undefined, d = 2) => (n == null || isNaN(n) ? '' : n.toFixed(d))
export const pct = (n: number | null | undefined, d = 1) => (n == null || isNaN(n) ? '' : (n * 100).toFixed(d) + '%')

export function weightLabel(g: number) {
  return g >= 1000 ? `${+(g / 1000).toFixed(3)}kg` : `${+g.toFixed(2)}g`
}

/** Parse "250g", "1 KG", "0.5kg", "500 gm", "1L" -> grams */
export function parseWeight(v: unknown): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return v
  const s = String(v).toLowerCase().replace(',', '.')
  const m = s.match(/(\d+(?:\.\d+)?)\s*(kg|kgs|kilo|g|gm|gms|gr|grams?|ml|l|ltr|liters?|litres?|جم|جرام|غ|كجم|كغ|مل|لتر)?/)
  if (!m) return null
  const n = parseFloat(m[1])
  const u = m[2] || ''
  if (/^(kg|kgs|kilo|كجم|كغ|l|ltr|liter|liters|litre|litres|لتر)$/.test(u)) return n * 1000
  return n
}

export function parseNum(v: unknown): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return v
  const s = String(v).replace(/[^\d.,-]/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.')
  const n = parseFloat(s)
  return isNaN(n) ? null : n
}

export const stageKeys = [
  { key: 'submitted', label: 'Submitted', who: 'Vendor' },
  { key: 'data', label: 'Data complete', who: 'Vendor/You' },
  { key: 'rebate', label: 'Rebate added', who: 'You' },
  { key: 'tracker', label: 'Tracker tab', who: 'Claude' },
  { key: 'approval', label: 'Approval email', who: 'Claude → You send' },
  { key: 'sharif', label: 'Sharif approved', who: 'Sharif' },
  { key: 'nis', label: 'NIS filled', who: 'You' },
  { key: 'creation', label: 'Creation email', who: 'Claude → You send' },
  { key: 'shared', label: 'Shared w/ content', who: 'You' },
  { key: 'listed', label: 'Listed 9311', who: 'Content/Parag' },
  { key: 'zskus', label: 'ZSKUs received', who: 'Content' },
  { key: 'uploads', label: 'Uploads', who: 'You' },
  { key: 'instock', label: 'INSTOCK added', who: 'Claude' },
] as const

export const UPLOAD_COUNT = 12

export function stageDone(sub: Submission, skus: Sku[]): Record<string, boolean> {
  const active = skus.filter((s) => !s.excluded)
  const up = Object.values(sub.uploads || {}).filter(Boolean).length
  return {
    submitted: true,
    data: active.length > 0 && active.every((s) => missingFor(s).length === 0),
    rebate: sub.rebate_pct != null || (active.length > 0 && active.every((s) => s.rebate_pct != null)),
    tracker: !!sub.tracker_synced_at,
    approval: !!sub.approval_drafted_at,
    sharif: !!sub.sharif_approved_at,
    nis: !!sub.nis_filled_at,
    creation: !!sub.creation_drafted_at,
    shared: !!sub.shared_with_content_at,
    listed: !!sub.listed_9311_at,
    zskus: !!sub.zskus_received_at || (active.length > 0 && active.every((s) => !!s.zsku)),
    uploads: up >= UPLOAD_COUNT,
    instock: !!sub.instock_added_at,
  }
}

export function currentStage(sub: Submission, skus: Sku[]) {
  if (sub.rejected_at) return { label: 'Rejected', who: '', idx: -1 }
  const d = stageDone(sub, skus)
  // data completeness doesn't block the flow (content can proceed); find first undone excluding 'data'
  const idx = stageKeys.findIndex((s) => s.key !== 'data' && !d[s.key])
  if (idx === -1) return { label: 'Done', who: '', idx: stageKeys.length }
  const k = stageKeys[idx].key
  if ((k === 'tracker' || k === 'approval') && !sub.ready_for_approval_at) return { label: 'Review & mark ready', who: 'You', idx }
  if (k === 'creation' && !sub.ready_for_creation_at) return { label: 'Mark ready for creation', who: 'You', idx }
  return { label: stageKeys[idx].label, who: stageKeys[idx].who, idx }
}
