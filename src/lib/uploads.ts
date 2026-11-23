import type { Sku, Submission, Vendor } from './supabase'

export type UploadDef = {
  key: string; name: string; url: string
  headers: string[]
  row: (s: Sku, ctx: Ctx) => (string | number)[]
  needs: (keyof Sku | 'mpa' | 'price')[]
}
export type Ctx = { sub: Submission; vendor: Vendor | null; today: string }

const money = (n: number | null) => (n == null ? '' : n.toFixed(2))
const P = 9311

export const UPLOADS: UploadDef[] = [
  { key: 'barcode', name: 'Barcode Upload', url: 'https://noon-catalog.noon.partners/en/imports/create?project=PRJ9311',
    headers: ['id_partner', 'partner_barcode', 'partner_sku'], needs: ['barcode', 'partner_sku'],
    row: (s) => [P, s.barcode ?? '', s.partner_sku ?? ''] },
  { key: 'cost_regular', name: 'Cost Regular', url: 'https://ro.noon.team/mpa/list/?project=PRJ9311',
    headers: ['mpa_code', 'pbarcode_canonical', 'cost', 'vat_rate', 'other_vat', 'excise_base_cost', 'freight_pct', 'date_from', 'date_to', 'is_active'],
    needs: ['mpa', 'barcode', 'cost'],
    row: (s, c) => [c.vendor?.mpa_code ?? '', s.barcode ?? '', s.cost ?? '', 15, 0, 0, 0, c.today, '', 1] },
  { key: 'cost_first', name: 'Cost First Time', url: 'https://misc-importer.noon.team/import/nooninstant_first_time_cost_upload',
    headers: ['sku', 'country_code', 'cost_price'], needs: ['zsku', 'cost'],
    row: (s) => [s.zsku ?? '', 'sa', s.cost ?? ''] },
  { key: 'volumetric', name: 'Volumetric Upload', url: 'https://minutes.noon.partners/imports/?project=PRJ9311&pageNum=1&import_subtype=product_meta',
    headers: ['zsku', 'volume', 'weight'], needs: ['zsku'],
    row: (s) => [s.zsku ?? '', 1000, 0] },
  { key: 'taxonomy', name: 'Taxonomy Upload', url: 'https://minutes.noon.partners/imports/?project=PRJ9311&pageNum=1&import_subtype=mp_taxonomy',
    headers: ['zsku', 'category_code', 'country_code', 'is_active'], needs: ['zsku', 'taxonomy_code'],
    row: (s) => [s.zsku ?? '', s.taxonomy_code ?? '', 'sa', 1] },
  { key: 'msrp', name: 'MSRP Upload', url: 'https://misc-importer.noon.team/import/nooninstant_instant_msrp',
    headers: ['sku', 'country_code', 'msrp'], needs: ['zsku', 'price'],
    row: (s) => [s.zsku ?? '', 'sa', money(s.noon_price)] },
  { key: 'msrp_first', name: 'First Time MSRP Upload', url: 'https://noon-catalog.noon.partners/en/imports/create?import_type=noon_catalog_pricing_priceupdate&project=PRJ9311',
    headers: ['country_code', 'id_partner', 'partner_sku', 'price'], needs: ['partner_sku', 'price'],
    row: (s) => ['sa', P, s.partner_sku ?? '', money(s.noon_price)] },
  { key: 'l123', name: 'L1-3 Mapping', url: 'https://minutes.noon.partners/imports/?project=PRJ9311&pageNum=1&import_subtype=sku_taxonomy_mapping',
    headers: ['sku', 'L1', 'L2', 'L3'], needs: ['zsku', 'l1', 'l2', 'l3'],
    row: (s) => [s.zsku ?? '', s.l1 ?? '', s.l2 ?? '', s.l3 ?? ''] },
  { key: 'lighthouse', name: 'Light-house Upload', url: 'https://minutes-instock-alt.noon.team/commercial/assortmentManagement/assortmentStatus/summary/',
    headers: ['sku', 'country', 'status', 'date_from', 'date_to', 'notes'], needs: ['zsku'],
    row: (s) => [s.zsku ?? '', 'sa', 'active', '', '', ''] },
  { key: 'mpa', name: 'MPA Mapping', url: 'https://misc-importer.noon.team/import/nooninstant_sku_primary_vendor',
    headers: ['sku', 'country_code', 'mpa_code'], needs: ['zsku', 'mpa'],
    row: (s, c) => [s.zsku ?? '', 'sa', c.vendor?.mpa_code ?? ''] },
  { key: 'shelf_life', name: 'Shelf Life Upload', url: 'https://minutes.noon.partners/imports/?project=PRJ9311&pageNum=1&import_subtype=sku_update',
    headers: ['zsku', 'partner_sku', 'shelf_life', 'keep_life', 'is_expirable', 'is_food', 'storage_condition_ds', 'storage_condition_central'],
    needs: ['zsku', 'partner_sku'],
    row: (s) => [s.zsku ?? '', s.partner_sku ?? '', 365, 365, 1, 1, 'ambient', 'ambient'] },
  { key: 'moq', name: 'MOQ', url: 'https://ro.noon.team/mpa/list/?project=PRJ9311',
    headers: ['sku', 'mpa_code', 'division_code', 'active_barcode', 'moq', 'ats', 'crossdock', 'dts', 'first_buy_qty', 'reference_sku'],
    needs: ['zsku', 'mpa', 'barcode'],
    row: (s, c) => [s.zsku ?? '', c.vendor?.mpa_code ?? '', 'btc', s.barcode ?? '', s.moq || 12, 1, 0, 0, 0, ''] },
]

export const INSTOCK_HEADERS = ['ZSKU', 'Title', 'Brand', 'Category', 'Vendor', 'MPA Code', 'Entity Code', 'Pbarcode', 'MOQ']
export const instockRow = (s: Sku, c: Ctx) => [
  s.zsku ?? '', s.title || s.title_vendor || '', s.brand ?? c.sub.brand, s.category === 'Breakfast' ? 'Breakfast' : 'Tea & Coffee',
  c.vendor?.name ?? c.sub.vendor_name, c.vendor?.mpa_code ?? '', c.vendor?.le_code ?? '', s.barcode ?? '', s.moq || 12,
]

export function missingFor(def: UploadDef, s: Sku, c: Ctx): string[] {
  return def.needs.filter((n) => {
    if (n === 'mpa') return !c.vendor?.mpa_code
    if (n === 'price') return s.noon_price == null
    const v = s[n as keyof Sku]
    return v == null || v === ''
  }) as string[]
}

export const toTsv = (headers: string[], rows: (string | number)[][]) =>
  [headers, ...rows].map((r) => r.map((v) => String(v ?? '').replace(/[\t\n\r]+/g, ' ')).join('\t')).join('\n')

export const todayRiyadh = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10)
