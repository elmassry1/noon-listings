import * as XLSX from 'xlsx'

export type ZskuHit = { barcode: string; partner_sku: string; zsku: string; title?: string }

const normBc = (v: unknown) => String(v ?? '').replace(/\s/g, '').replace(/\.0+$/, '').replace(/^0+/, '')

/** Reads the NIS returned by content (partner_sku + zsku per pbarcodes) or any sheet with barcode/psku/zsku columns */
export async function readZskuFile(file: File): Promise<ZskuHit[]> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
  const hits: ZskuHit[] = []
  for (const n of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, raw: false, defval: '' })
    const hi = rows.slice(0, 10).findIndex((r) => r.some((c) => /zsku/i.test(String(c))))
    if (hi < 0) continue
    const h = rows[hi].map((c) => String(c).toLowerCase().trim())
    const iz = h.findIndex((x) => x === 'zsku' || x.includes('zsku'))
    const ip = h.findIndex((x) => x === 'partner_sku' || x === 'psku' || x.includes('partner sku'))
    const ib = h.findIndex((x) => x === 'pbarcodes' || x.includes('barcode'))
    const it = h.findIndex((x) => x === 'product_title' || x === 'title')
    if (iz < 0 || ib < 0) continue
    for (const r of rows.slice(hi + 1)) {
      const z = String(r[iz] ?? '').trim()
      const b = String(r[ib] ?? '').trim()
      if (!z || !b) continue
      hits.push({ barcode: b, zsku: z, partner_sku: ip >= 0 ? String(r[ip] ?? '').trim() : '', title: it >= 0 ? String(r[it] ?? '') : undefined })
    }
  }
  return hits
}

export const sameBarcode = (a: unknown, b: unknown) => normBc(a) !== '' && normBc(a) === normBc(b)
