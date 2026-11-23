import * as XLSX from 'xlsx'
import { readFileSync } from 'fs'
import { findHeaderRow, autoMap, applyMapping, cellStr } from '../src/lib/mapping.ts'
import { computePrice, eanValid } from '../src/lib/pricing.ts'
for (const f of ['/tmp/v1.xlsx', '/tmp/v2.xlsx']) {
  const wb = XLSX.read(readFileSync(f))
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '', blankrows: false })
  const h = findHeaderRow(rows); const hdr = rows[h].map(cellStr)
  const m = autoMap(hdr, rows.slice(h + 1))
  console.log(f, 'header row', h, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, hdr[v as number]])))
  console.log(applyMapping(rows.slice(h + 1), m))
}
console.log(computePrice(9.5, 0.13, 'T&C'), computePrice(3.46, 0.065, 'T&C'), eanValid('6281006000123'), eanValid('54881029124'))
