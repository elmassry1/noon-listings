import JSZip from 'jszip'
import { weightLabel } from './pricing'

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

type Dom = { parser: { parseFromString(s: string, t: string): Document }; serializer: { serializeToString(n: Node): string } }
const defaultDom = (): Dom => ({ parser: new DOMParser(), serializer: new XMLSerializer() })

export type NisRow = { brand: string; title: string; barcode: string; weight_g: number; images: string[]; description: string }
export type NisTemplate = {
  zip: JSZip; sheetPath: string; doc: Document; headers: Record<string, string> // header -> column letter
  shared: string[]; leads: { row: number; family: string; product_type: string; product_subtype: string }[]
  mainSubtype: string; dom: Dom
}

const colToNum = (c: string) => c.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0)
const splitRef = (r: string) => { const m = r.match(/^([A-Z]+)(\d+)$/)!; return { col: m[1], row: +m[2] } }
const els = (n: Element | Document, tag: string) => Array.from(n.getElementsByTagNameNS(NS, tag))

function cellText(c: Element, shared: string[]): string {
  const t = c.getAttribute('t')
  if (t === 's') { const v = els(c, 'v')[0]; return v ? shared[+v.textContent!] ?? '' : '' }
  if (t === 'inlineStr') return els(c, 't').map((x) => x.textContent).join('')
  const v = els(c, 'v')[0]
  return v?.textContent ?? ''
}

export async function loadNisTemplate(data: ArrayBuffer | Uint8Array, dom: Dom = defaultDom()): Promise<NisTemplate> {
  const zip = await JSZip.loadAsync(data)
  const wb = dom.parser.parseFromString(await zip.file('xl/workbook.xml')!.async('string'), 'application/xml')
  const firstSheet = els(wb, 'sheet')[0]
  const rid = firstSheet.getAttributeNS(RNS, 'id') || firstSheet.getAttribute('r:id')
  const rels = dom.parser.parseFromString(await zip.file('xl/_rels/workbook.xml.rels')!.async('string'), 'application/xml')
  const rel = Array.from(rels.getElementsByTagName('Relationship')).find((r) => r.getAttribute('Id') === rid)!
  let target = rel.getAttribute('Target')!
  target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '')
  const shared: string[] = []
  const ssf = zip.file('xl/sharedStrings.xml')
  if (ssf) {
    const ss = dom.parser.parseFromString(await ssf.async('string'), 'application/xml')
    els(ss, 'si').forEach((si) => shared.push(els(si, 't').map((t) => t.textContent).join('')))
  }
  const doc = dom.parser.parseFromString(await zip.file(target)!.async('string'), 'application/xml')
  const headers: Record<string, string> = {}
  const rows = els(doc, 'row')
  const r1 = rows.find((r) => r.getAttribute('r') === '1')
  if (!r1) throw new Error('Template has no header row')
  els(r1, 'c').forEach((c) => { const h = cellText(c, shared).trim(); if (h) headers[h] = splitRef(c.getAttribute('r')!).col })
  if (!headers['product_title'] || !headers['pbarcodes']) throw new Error('This does not look like an NIS (Product Content Template)')
  const leads: NisTemplate['leads'] = []
  for (const r of rows) {
    const rn = +r.getAttribute('r')!
    if (rn < 2) continue
    const get = (h: string) => { const col = headers[h]; if (!col) return ''; const c = els(r, 'c').find((x) => x.getAttribute('r') === col + rn); return c ? cellText(c, shared).trim() : '' }
    const L = { row: rn, family: get('family'), product_type: get('product_type'), product_subtype: get('product_subtype') }
    if (L.family || L.product_type || L.product_subtype) leads.push(L)
  }
  const counts: Record<string, number> = {}
  leads.forEach((l) => l.product_subtype && (counts[l.product_subtype] = (counts[l.product_subtype] || 0) + 1))
  const mainSubtype = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  return { zip, sheetPath: target, doc, headers, shared, leads, mainSubtype, dom }
}

/** subtype that SKU n (0-based) will get */
export function subtypeForIndex(t: NisTemplate, i: number) {
  return t.leads.find((l) => l.row === i + 2)?.product_subtype || t.mainSubtype
}

function getRow(doc: Document, rn: number): Element {
  const sheetData = els(doc, 'sheetData')[0]
  const rows = els(sheetData, 'row')
  let row = rows.find((r) => +r.getAttribute('r')! === rn)
  if (row) return row
  row = doc.createElementNS(NS, 'row')
  row.setAttribute('r', String(rn))
  const after = rows.find((r) => +r.getAttribute('r')! > rn)
  sheetData.insertBefore(row, after ?? null)
  return row
}

function setCell(doc: Document, rn: number, col: string, value: string | number | null, styleFrom?: Element | null) {
  const row = getRow(doc, rn)
  const ref = col + rn
  const cells = els(row, 'c')
  let c = cells.find((x) => x.getAttribute('r') === ref)
  if (!c) {
    c = doc.createElementNS(NS, 'c')
    c.setAttribute('r', ref)
    const s = styleFrom?.getAttribute('s')
    if (s) c.setAttribute('s', s)
    const after = cells.find((x) => colToNum(splitRef(x.getAttribute('r')!).col) > colToNum(col))
    row.insertBefore(c, after ?? null)
  }
  while (c.firstChild) c.removeChild(c.firstChild)
  c.removeAttribute('t')
  if (value === null || value === '') return
  if (typeof value === 'number') {
    const v = doc.createElementNS(NS, 'v'); v.textContent = String(value); c.appendChild(v)
  } else {
    c.setAttribute('t', 'inlineStr')
    const is = doc.createElementNS(NS, 'is'); const t = doc.createElementNS(NS, 't')
    t.textContent = value
    if (/^\s|\s$/.test(value)) t.setAttribute('xml:space', 'preserve')
    is.appendChild(t); c.appendChild(is)
  }
}

const FIXED: Record<string, string | number> = {
  dietary_needs: 'Vegetarian', shelf_life: 365, item_pack_quantity: 'Single',
  storage_requirements: 'Ambient', f_b_country_of_origin: 'Saudi Arabia', size_unit: 'grams',
}
const CLEAR = ['partner_sku', 'zsku', 'volume', 'video_url', 'allergy_information']

export async function fillNis(t: NisTemplate, rows: NisRow[]): Promise<Uint8Array> {
  const { doc, headers } = t
  const H = (h: string) => headers[h]
  const styleRef = (col: string) => els(getRow(doc, 2), 'c').find((c) => c.getAttribute('r') === col + '2') ?? null
  const leadMain: Record<string, string> = {}
  for (const k of ['family', 'product_type', 'product_subtype'] as const) {
    const counts: Record<string, number> = {}
    t.leads.forEach((l) => l[k] && (counts[l[k]] = (counts[l[k]] || 0) + 1))
    leadMain[k] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  }
  const allRowNums = els(doc, 'row').map((r) => +r.getAttribute('r')!).filter((n) => n >= 2)
  const lastRow = Math.max(rows.length + 1, ...allRowNums)
  for (let rn = 2; rn <= lastRow; rn++) {
    const r = rows[rn - 2]
    const set = (h: string, v: string | number | null) => { const col = H(h); if (col) setCell(doc, rn, col, v, styleRef(col)) }
    if (!r) {
      // clear stale data in unused rows, keep pre-filled family/type/subtype
      if (!allRowNums.includes(rn)) continue
      Object.keys(headers).forEach((h) => { if (!['family', 'product_type', 'product_subtype'].includes(h)) set(h, null) })
      continue
    }
    const lead = t.leads.find((l) => l.row === rn)
    for (const k of ['family', 'product_type', 'product_subtype'] as const) if (!lead?.[k]) set(k, leadMain[k] || null)
    const g = Math.round(r.weight_g * 1000) / 1000
    CLEAR.forEach((h) => set(h, null))
    set('pbarcodes', String(r.barcode))
    set('weight', g)
    set('size', g)
    set('product_subtitle', weightLabel(g))
    set('product_title', r.title)
    set('brand', r.brand)
    const imgs = Array.from(new Set(r.images.filter(Boolean)))
    for (let j = 1; j <= 5; j++) set(`image_url_${j}`, imgs[j - 1] ?? null)
    set('long_description', r.description)
    Object.entries(FIXED).forEach(([k, v]) => set(k, v))
  }
  // stale hyperlinks (old image links) would survive cleared cells — drop them all
  els(doc, 'hyperlinks').forEach((h) => h.parentNode?.removeChild(h))
  // dimension
  const dim = els(doc, 'dimension')[0]
  if (dim) {
    const lastCol = Object.values(headers).sort((a, b) => colToNum(b) - colToNum(a))[0]
    dim.setAttribute('ref', `A1:${lastCol}${lastRow}`)
  }
  t.zip.file(t.sheetPath, t.dom.serializer.serializeToString(doc))
  t.zip.remove('xl/calcChain.xml')
  return t.zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

export function nisFileName(brand: string, subtype: string) {
  return `NIS_${brand.replace(/[^\w]+/g, '')}_${subtype || 'listing'}.xlsx`
}

export function templateDescription(brand: string, title: string) {
  const name = title.replace(new RegExp('^' + brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i'), '')
  return `${brand} brings you ${name}, carefully selected for quality and taste. Enjoy a rich, satisfying experience made for everyday moments. Ideal for daily enjoyment at home, at work, or when welcoming guests.`
}
