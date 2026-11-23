import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase, SUPABASE_URL } from '../lib/supabase'
import { STR, detectLang, type Lang } from '../lib/i18n'
import { FIELDS, emptyRow, readWorkbook, findHeaderRow, autoMap, applyMapping, cellStr, type Field, type Row, type Mapping, type Sheet } from '../lib/mapping'
import { eanValid } from '../lib/pricing'
import { aiMapColumns, aiExtractFile } from '../lib/ai'

const IMG_FIELDS: Field[] = ['img_front', 'img_back', 'img_ingredients', 'img_nutrition']
const REQUIRED: Field[] = ['title', 'weight_g', 'barcode', 'cost']

async function uploadImage(file: File): Promise<string> {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')
  const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('lt-images').upload(path, file, { contentType: file.type, upsert: false })
  if (error) throw error
  return `${SUPABASE_URL}/storage/v1/object/public/lt-images/${path}`
}

export default function Vendor() {
  const [lang, setLang] = useState<Lang>(detectLang())
  const t = STR[lang]
  const [vendors, setVendors] = useState<string[]>([])
  const [company, setCompany] = useState('')
  const [brand, setBrand] = useState('')
  const [isNew, setIsNew] = useState<boolean | null>(null)
  const [website, setWebsite] = useState('')
  const [arName, setArName] = useState('')
  const [rows, setRows] = useState<Row[]>([emptyRow()])
  const [notes, setNotes] = useState('')
  const [fileName, setFileName] = useState('')
  const [sheets, setSheets] = useState<Sheet[] | null>(null)
  const [sheetIdx, setSheetIdx] = useState(0)
  const [headerRow, setHeaderRow] = useState(0)
  const [mapping, setMapping] = useState<Mapping>({})
  const [mapBusy, setMapBusy] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [doneRef, setDoneRef] = useState('')
  const [tried, setTried] = useState(false)
  const [reading, setReading] = useState(false)
  const [info, setInfo] = useState('')
  const [uploading, setUploading] = useState<Record<string, boolean>>({})
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'; document.documentElement.lang = lang }, [lang])
  useEffect(() => { supabase.rpc('lt_vendor_names').then(({ data }) => setVendors((data || []).map((v: { name: string }) => v.name))) }, [])

  const sheet = sheets?.[sheetIdx]
  const headers = useMemo(() => (sheet ? (sheet.rows[headerRow] || []).map((h, i) => cellStr(h) || `Column ${i + 1}`) : []), [sheet, headerRow])

  async function onFile(f: File) {
    setErr(''); setInfo('')
    const isDoc = /\.pdf$/i.test(f.name) || f.type === 'application/pdf' || f.type.startsWith('image/')
    if (isDoc) {
      setReading(true)
      const res = await aiExtractFile(f)
      setReading(false)
      if (res.error || !res.rows?.length) return setErr(res.error === 'too_large' ? t.tooLarge : t.pdfFail)
      setFileName(f.name); setSheets(null)
      setRows(res.rows.map((r) => {
        const row = emptyRow()
        for (const k of ['title', 'weight_g', 'barcode', 'cost', 'moq', 'notes'] as const) row[k] = (r[k] ?? '').trim()
        row.barcode = row.barcode.replace(/\D/g, '')
        // never carry RSP / retail prices into notes
        row.notes = row.notes.split(/[;|]/).map((x) => x.trim()).filter((x) => x && !/\b(rsp|srp|msrp|retail|selling|shelf|consumer)\b/i.test(x)).join('; ')
        return row
      }))
      setInfo(t.extracted)
      return
    }
    try {
      const ss = await readWorkbook(f)
      if (!ss.length) throw new Error('empty')
      // choose the sheet with the most detectable columns
      let best = 0, bestN = -1
      ss.forEach((s, i) => { const h = findHeaderRow(s.rows); const m = autoMap((s.rows[h] || []).map(cellStr), s.rows.slice(h + 1)); const n = Object.keys(m).length; if (n > bestN) { bestN = n; best = i } })
      setFileName(f.name); setSheets(ss); pickSheet(ss, best)
    } catch {
      setErr(lang === 'ar' ? 'تعذر قراءة الملف' : 'Could not read this file')
    }
  }

  async function pickSheet(ss: Sheet[], i: number) {
    setSheetIdx(i)
    const s = ss[i]
    const h = findHeaderRow(s.rows)
    setHeaderRow(h)
    const hdr = (s.rows[h] || []).map(cellStr)
    const body = s.rows.slice(h + 1)
    let m = autoMap(hdr, body)
    if (m.title == null || m.barcode == null || m.cost == null) {
      setMapBusy(true)
      const ai = await aiMapColumns(hdr, body.slice(0, 5).map((r) => r.map(cellStr)))
      setMapBusy(false)
      if (ai) {
        const merged: Mapping = { ...m }
        for (const f of FIELDS) if (merged[f] == null && typeof ai[f] === 'number' && ai[f] >= 0 && ai[f] < hdr.length) merged[f] = ai[f]
        m = merged
      }
    }
    setMapping(m)
  }

  function applyMap() {
    if (!sheet) return
    const out = applyMapping(sheet.rows.slice(headerRow + 1), mapping)
    if (!out.length) { setErr(t.errNone); return }
    setRows(out); setSheets(null)
  }

  const setCell = (i: number, f: Field, v: string) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [f]: v } : x)))
  const filled = rows.filter((r) => Object.values(r).some(Boolean))
  const invalid = (r: Row, f: Field) => tried && REQUIRED.includes(f) && !r[f]
  const badBc = (r: Row) => !!r.barcode && !eanValid(r.barcode)
  const missingImgs = filled.some((r) => !r.img_front || !r.img_ingredients || !r.img_nutrition)

  async function onImg(i: number, f: Field, file: File) {
    const k = `${i}-${f}`
    setUploading((u) => ({ ...u, [k]: true }))
    try { setCell(i, f, await uploadImage(file)) } catch (e) { setErr(String((e as Error).message || e)) }
    setUploading((u) => ({ ...u, [k]: false }))
  }

  async function submit() {
    setTried(true); setErr('')
    if (!company.trim() || !brand.trim()) return setErr(t.errCompany)
    if (!filled.length) return setErr(t.errNone)
    if (filled.some((r) => REQUIRED.some((f) => !r[f]))) return setErr(t.errRequired)
    setBusy(true)
    const { data, error } = await supabase.rpc('lt_submit', {
      payload: {
        vendor_name: company.trim(), brand: brand.trim(), is_new_brand: !!isNew,
        brand_website: isNew ? website : null, brand_name_ar: isNew ? arName : null,
        vendor_notes: notes, source_filename: fileName, lang,
        skus: filled.map((r) => ({ ...r })),
      },
    })
    setBusy(false)
    if (error) return setErr(error.message)
    setDoneRef(data as string)
    window.scrollTo(0, 0)
  }

  if (doneRef)
    return (
      <Shell lang={lang} setLang={setLang} t={t}>
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 40 }}>✓</div>
          <h2>{t.done}</h2>
          <p>{t.ref}: <span className="pill y" style={{ fontSize: 16 }}>{doneRef}</span></p>
          <p className="muted">{t.doneHint}</p>
          <button className="btn" onClick={() => { setDoneRef(''); setRows([emptyRow()]); setBrand(''); setIsNew(null); setNotes(''); setTried(false); setFileName('') }}>{t.another}</button>
        </div>
      </Shell>
    )

  return (
    <Shell lang={lang} setLang={setLang} t={t}>
      <div className="card">
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="field grow">
            <label>{t.company} *</label>
            <input className={`in ${tried && !company ? 'bad' : ''}`} list="lt-vendors" value={company} onChange={(e) => setCompany(e.target.value)} placeholder={t.companyPh} />
            <datalist id="lt-vendors">{vendors.map((v) => <option key={v} value={v} />)}</datalist>
            <span className="muted small">{t.companyHint}</span>
          </div>
          <div className="field">
            <label>{t.brand} *</label>
            <input className={`in ${tried && !brand ? 'bad' : ''}`} value={brand} onChange={(e) => setBrand(e.target.value)} placeholder={t.brandPh} />
          </div>
          <div className="field">
            <label>{t.newBrand}</label>
            <div className="row">
              <button className={`btn sm ${isNew === true ? 'dark' : ''}`} onClick={() => setIsNew(true)}>{t.yes}</button>
              <button className={`btn sm ${isNew === false ? 'dark' : ''}`} onClick={() => setIsNew(false)}>{t.no}</button>
            </div>
          </div>
        </div>
        {isNew && (
          <div className="row" style={{ marginTop: 12 }}>
            <div className="field grow"><label>{t.website}</label><input className="in" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" dir="ltr" /></div>
            <div className="field grow"><label>{t.arName}</label><input className="in" value={arName} onChange={(e) => setArName(e.target.value)} dir="rtl" /></div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 className="grow">{t.products} <span className="muted small">({filled.length} {t.rows})</span></h2>
        </div>
        {!sheets && (
          <div className="drop" style={{ opacity: reading ? 0.6 : 1, pointerEvents: reading ? 'none' : undefined }} onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('over') }}
            onDragLeave={(e) => e.currentTarget.classList.remove('over')}
            onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) onFile(f) }}>
            <b>⬆ {t.upload}</b><div className="muted small">{reading ? <b>{t.reading}</b> : t.uploadHint}</div>
            {fileName && <div className="small" style={{ marginTop: 6 }}>📄 {fileName}</div>}
            <input ref={fileRef} type="file" hidden accept=".xlsx,.xls,.csv,.xlsm,.ods,.pdf,image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
          </div>
        )}

        {sheets && sheet && (
          <div className="card" style={{ background: '#fffef3', borderColor: '#000' }}>
            <h3>{t.mapTitle}</h3>
            <p className="muted small" style={{ marginTop: -6 }}>{t.mapHint} {mapBusy && <b>· {t.aiMapping}</b>}</p>
            {sheets.length > 1 && (
              <div className="field" style={{ maxWidth: 300, marginBottom: 10 }}>
                <label>{t.sheet}</label>
                <select className="in" value={sheetIdx} onChange={(e) => pickSheet(sheets, +e.target.value)}>
                  {sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
                </select>
              </div>
            )}
            <div className="row" style={{ alignItems: 'flex-start' }}>
              {FIELDS.map((f) => {
                const col = mapping[f]
                const sample = col != null ? sheet.rows.slice(headerRow + 1).map((r) => cellStr(r[col])).find(Boolean) : ''
                return (
                  <div className="field" key={f} style={{ minWidth: 200, flex: '1 1 200px' }}>
                    <label>{t[`f_${f}` as const]} {REQUIRED.includes(f) && '*'}</label>
                    <select className={`in ${REQUIRED.includes(f) && col == null ? 'bad' : ''}`} value={col ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [f]: e.target.value === '' ? undefined : +e.target.value }))}>
                      <option value="">{t.notInFile}</option>
                      {headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                    </select>
                    <span className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} dir="ltr">{sample ? `e.g. ${sample}` : ' '}</span>
                  </div>
                )
              })}
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn pri" onClick={applyMap}>{t.apply}</button>
              <button className="btn ghost" onClick={() => setSheets(null)}>{t.cancel}</button>
            </div>
          </div>
        )}

        <div className="scroll" style={{ marginTop: 14 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>#</th>
                {FIELDS.map((f) => <th key={f}>{t[`f_${f}` as const]}{REQUIRED.includes(f) && ' *'}</th>)}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="muted">{i + 1}</td>
                  {FIELDS.map((f) => (
                    <td key={f} className={invalid(r, f) || (f === 'barcode' && tried && badBc(r)) ? 'bad' : ''}>
                      {IMG_FIELDS.includes(f) ? (
                        <div className="imgcell">
                          {r[f] && <a href={r[f]} target="_blank" rel="noreferrer"><img className="thumb" src={r[f]} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} /></a>}
                          <input className="in" value={r[f]} placeholder={t.imgHint} onChange={(e) => setCell(i, f, e.target.value)} dir="ltr" />
                          <label className="btn sm" title={t.imgHint}>
                            {uploading[`${i}-${f}`] ? '…' : '⬆'}
                            <input type="file" hidden accept="image/*" onChange={(e) => { const fl = e.target.files?.[0]; if (fl) onImg(i, f, fl); e.target.value = '' }} />
                          </label>
                        </div>
                      ) : (
                        <input className="in" value={r[f]} onChange={(e) => setCell(i, f, e.target.value)}
                          style={{ minWidth: f === 'title' ? 260 : f === 'notes' ? 160 : f === 'barcode' ? 140 : 110 }}
                          inputMode={['weight_g', 'cost', 'moq', 'barcode'].includes(f) ? 'decimal' : undefined}
                          dir={f === 'title' || f === 'notes' ? undefined : 'ltr'}
                          title={f === 'barcode' && badBc(r) ? t.badBarcode : undefined} />
                      )}
                    </td>
                  ))}
                  <td><button className="btn sm ghost" title={t.remove} onClick={() => setRows((x) => (x.length > 1 ? x.filter((_, j) => j !== i) : [emptyRow()]))}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setRows((r) => [...r, emptyRow()])}>+ {t.manual}</button>
        {info && <div className="alert ok">{info}</div>}
        {filled.length > 0 && missingImgs && <div className="alert">{t.warnImages}</div>}
        {filled.some(badBc) && <div className="alert">{t.badBarcode}: {filled.filter(badBc).map((r) => r.barcode).join(', ')}</div>}
      </div>

      <div className="card">
        <div className="field"><label>{t.notesAll}</label><textarea className="in" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        {err && <div className="alert bad">{err}</div>}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn pri" disabled={busy} onClick={submit} style={{ padding: '11px 26px' }}>{busy ? t.submitting : t.submit}</button>
        </div>
      </div>
    </Shell>
  )
}

function Shell({ children, lang, setLang, t }: { children: React.ReactNode; lang: Lang; setLang: (l: Lang) => void; t: typeof STR.en }) {
  return (
    <>
      <div className="nav"><div className="logo">noon <i>Minutes</i></div><div className="sp" /><a href="#" onClick={(e) => { e.preventDefault(); setLang(lang === 'en' ? 'ar' : 'en') }}>{t.lang}</a></div>
      <div className="hero"><div className="wrap" style={{ padding: 0 }}><h1>{t.title}</h1><p>{t.subtitle}</p></div></div>
      <div className="wrap pull">{children}</div>
    </>
  )
}
