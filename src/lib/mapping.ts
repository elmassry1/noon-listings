import * as XLSX from 'xlsx'
import { parseNum, parseWeight } from './pricing'

export const FIELDS = ['title', 'weight_g', 'barcode', 'cost', 'moq', 'img_front', 'img_back', 'img_ingredients', 'img_nutrition', 'notes'] as const
export type Field = (typeof FIELDS)[number]
export type Row = Record<Field, string>
export const emptyRow = (): Row => Object.fromEntries(FIELDS.map((f) => [f, ''])) as Row

const SYN: Record<Field, RegExp[]> = {
  title: [/product\s*name/, /item\s*name/, /sku\s*name/, /english\s*(name|desc)/, /\bdescription\b/, /\btitle\b/, /^name$/, /^product$/, /^item$/, /اسم/, /الصنف/, /الوصف/, /المنتج/],
  weight_g: [/net\s*w/, /\bweight\b/, /\bwt\b/, /\bsize\b/, /grams?/, /\bgm\b/, /الوزن/, /الحجم/],
  barcode: [/barcode/, /bar\s*code/, /\bean\b/, /ean\s*13/, /\bupc\b/, /\bgtin\b/, /باركود/, /الباركود/],
  cost: [/cost/, /unit\s*price/, /net\s*price/, /purchase/, /buying/, /\bprice\b/, /التكلفة/, /السعر/, /سعر/],
  moq: [/case\s*pack/, /per\s*(case|carton|ctn|box)/, /carton/, /\bctn\b/, /pack\s*size/, /\bmoq\b/, /outer/, /pcs?\s*\/\s*(case|ctn|carton)/, /الكرتون/, /العبوة/],
  img_front: [/front/, /main\s*image/, /^image\s*1?$/, /^images?$/, /photo/, /picture/, /الأمامية/, /صورة/],
  img_back: [/back/, /rear/, /الخلفية/],
  img_ingredients: [/ingredient/, /المكونات/],
  img_nutrition: [/nutrition/, /nutritional/, /القيمة الغذائية/],
  notes: [/note/, /remark/, /comment/, /ملاحظ/],
}
// costs that are NOT what we want (RSP / retail / selling) — ignore so they never map to cost
const NOT_COST = [/rsp/, /retail/, /selling/, /consumer/, /shelf/, /\bsrp\b/, /msrp/, /vat\s*inc/, /incl/, /مستهلك/, /البيع/]

export type Sheet = { name: string; rows: unknown[][] }

export async function readWorkbook(file: File): Promise<Sheet[]> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array', cellDates: false })
  return wb.SheetNames.map((n) => ({
    name: n,
    rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, raw: true, defval: '', blankrows: false }),
  })).filter((s) => s.rows.length > 0)
}

const norm = (v: unknown) => String(v ?? '').toLowerCase().replace(/[_\-.:]+/g, ' ').replace(/\s+/g, ' ').trim()

export function scoreHeader(h: string, f: Field): number {
  const n = norm(h)
  if (!n) return 0
  if (f === 'cost' && NOT_COST.some((r) => r.test(n))) return 0
  const i = SYN[f].findIndex((r) => r.test(n))
  return i === -1 ? 0 : 100 - i
}

export function findHeaderRow(rows: unknown[][]): number {
  let best = 0, bestScore = -1
  rows.slice(0, 25).forEach((r, i) => {
    let s = 0
    r.forEach((c) => {
      if (typeof c !== 'string') return
      for (const f of FIELDS) if (scoreHeader(c, f) > 0) { s++; break }
    })
    if (s > bestScore) { bestScore = s; best = i }
  })
  return best
}

const isBarcodeLike = (v: unknown) => /^\d{8,14}$/.test(String(v ?? '').replace(/\s/g, '').replace(/\.0+$/, ''))
const isUrl = (v: unknown) => /^https?:\/\//i.test(String(v ?? '').trim())
const isWeightLike = (v: unknown) => /^\s*\d+(\.\d+)?\s*(g|gm|gr|grams?|kg|ml|l)\s*$/i.test(String(v ?? ''))

export type Mapping = Partial<Record<Field, number>> // field -> column index

export function autoMap(headers: string[], body: unknown[][]): Mapping {
  const map: Mapping = {}
  const used = new Set<number>()
  // pass 1: headers, best score wins per field
  const order: Field[] = ['barcode', 'img_ingredients', 'img_nutrition', 'img_back', 'img_front', 'moq', 'cost', 'weight_g', 'title', 'notes']
  for (const f of order) {
    let best = -1, bestScore = 0
    headers.forEach((h, i) => {
      if (used.has(i)) return
      const s = scoreHeader(h, f)
      if (s > bestScore) { bestScore = s; best = i }
    })
    if (best >= 0) { map[f] = best; used.add(best) }
  }
  // pass 2: content sniffing for missing essentials
  const sample = body.slice(0, 30)
  const colFrac = (i: number, test: (v: unknown) => boolean) => {
    const vals = sample.map((r) => r[i]).filter((v) => v !== '' && v != null)
    return vals.length ? vals.filter(test).length / vals.length : 0
  }
  const cols = headers.map((_, i) => i).filter((i) => !used.has(i))
  if (map.barcode == null) {
    const c = cols.find((i) => colFrac(i, isBarcodeLike) > 0.7)
    if (c != null) { map.barcode = c; used.add(c) }
  }
  if (map.weight_g == null) {
    const c = cols.find((i) => !used.has(i) && colFrac(i, isWeightLike) > 0.7)
    if (c != null) { map.weight_g = c; used.add(c) }
  }
  if (map.img_front == null) {
    const c = cols.find((i) => !used.has(i) && colFrac(i, isUrl) > 0.5)
    if (c != null) { map.img_front = c; used.add(c) }
  }
  if (map.title == null) {
    // longest average text column
    let best = -1, bestLen = 8
    cols.filter((i) => !used.has(i)).forEach((i) => {
      const vals = sample.map((r) => String(r[i] ?? '')).filter(Boolean)
      const avg = vals.reduce((a, v) => a + v.length, 0) / (vals.length || 1)
      if (avg > bestLen && colFrac(i, (v) => /[a-z؀-ۿ]/i.test(String(v))) > 0.8) { bestLen = avg; best = i }
    })
    if (best >= 0) map.title = best
  }
  return map
}

export function cellStr(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(6))
  return String(v).trim()
}

export function applyMapping(body: unknown[][], map: Mapping): Row[] {
  return body
    .map((r) => {
      const row = emptyRow()
      for (const f of FIELDS) {
        const i = map[f]
        if (i == null) continue
        let v = cellStr(r[i])
        if (f === 'barcode') v = v.replace(/\s/g, '').replace(/\.0+$/, '')
        if (f === 'weight_g') { const w = parseWeight(r[i]); v = w == null ? v : String(w) }
        if (f === 'cost') { const n = parseNum(r[i]); v = n == null ? '' : String(n) }
        if (f === 'moq') { const n = parseNum(r[i]); v = n == null ? '' : String(Math.round(n)) }
        row[f] = v
      }
      // weight from title if absent
      if (!row.weight_g && row.title) {
        const m = row.title.match(/(\d+(?:\.\d+)?)\s*(kg|g|gm|gr|grams?|ml|l)\b/i)
        if (m) row.weight_g = String(parseWeight(m[0]) ?? '')
      }
      return row
    })
    .filter((r) => r.title || r.barcode)
}
