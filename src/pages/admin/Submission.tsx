import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase, logEvent, type Sku, type Submission as Sub, type Vendor } from '../../lib/supabase'
import { computePrice, effRebate, eanValid, fmt, pct, missingFor, stageDone, stageKeys, currentStage, recPc } from '../../lib/pricing'
import { aiEnrich } from '../../lib/ai'
import { loadNisTemplate, fillNis, subtypeForIndex, nisFileName, templateDescription, type NisTemplate } from '../../lib/nis'
import { readZskuFile, sameBarcode } from '../../lib/zsku'
import { UPLOADS, INSTOCK_HEADERS, instockRow, missingFor as upMissing, toTsv, todayRiyadh, type Ctx } from '../../lib/uploads'
import taxonomy from '../../taxonomy.json'
import { useToast } from './Shell'

type Ev = { id: number; at: string; actor: string; kind: string; detail: string }
const TABS = ['Products & pricing', 'Approval email', 'NIS', 'ZSKUs & taxonomy', 'Uploads', 'Activity'] as const
const TOGGLE: Record<string, keyof Sub> = {
  tracker: 'tracker_synced_at', approval: 'approval_drafted_at', sharif: 'sharif_approved_at', nis: 'nis_filled_at',
  creation: 'creation_drafted_at', shared: 'shared_with_content_at', listed: 'listed_9311_at', zskus: 'zskus_received_at', instock: 'instock_added_at',
}
const REL_L1 = ['tea_and_coffee', 'breakfast']
const combos = [...(taxonomy.l123 as string[][])].sort((a, b) => (REL_L1.includes(b[0]) ? 1 : 0) - (REL_L1.includes(a[0]) ? 1 : 0))
const REL_CODES = /coffee|tea|matcha|honey|jam|spread|oat|granola|cereal|halawa|malt|capsule|bean|creamer|breakfast|nut|choc/
const codes = [...(taxonomy.category_codes as string[])].sort((a, b) => (REL_CODES.test(b) ? 1 : 0) - (REL_CODES.test(a) ? 1 : 0))
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export default function Submission() {
  const { id } = useParams()
  const toast = useToast()
  const [sub, setSub] = useState<Sub | null>(null)
  const [skus, setSkus] = useState<Sku[]>([])
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [events, setEvents] = useState<Ev[]>([])
  const [tab, setTab] = useState<(typeof TABS)[number]>('Products & pricing')
  const [busy, setBusy] = useState('')

  async function load() {
    const { data } = await supabase.from('lt_submissions').select('*, lt_vendors(*)').eq('id', id!).single()
    const { data: k } = await supabase.from('lt_skus').select('*').eq('submission_id', id!).order('position')
    const { data: ev } = await supabase.from('lt_events').select('*').eq('submission_id', id!).order('at', { ascending: false })
    setSub(data as Sub); setSkus((k || []) as Sku[]); setEvents((ev || []) as Ev[]); setDirty(new Set())
  }
  useEffect(() => { load(); supabase.from('lt_vendors').select('*').order('name').then(({ data }) => setVendors((data || []) as Vendor[])) }, [id])

  const vendor = sub?.lt_vendors ?? null
  const active = skus.filter((s) => !s.excluded)
  const done = useMemo(() => (sub ? stageDone(sub, active) : {}), [sub, skus])
  const cur = sub ? currentStage(sub, active) : null

  if (!sub) return <p className="muted">Loading…</p>

  // ---------- helpers ----------
  async function patchSub(p: Partial<Sub>, ev?: string) {
    const { error } = await supabase.from('lt_submissions').update(p).eq('id', sub!.id)
    if (error) return toast(error.message)
    setSub((s) => ({ ...s!, ...p }))
    if (ev) { await logEvent(sub!.id, 'update', ev); load() }
  }
  const editSku = (sid: string, p: Partial<Sku>) => {
    setSkus((l) => l.map((s) => (s.id === sid ? { ...s, ...p } : s)))
    setDirty((d) => new Set(d).add(sid))
  }
  function priced(s: Sku): Sku {
    const r = computePrice(s.cost, effRebate(s, sub!), s.category, s.noon_price != null && s.rec_pc === -1 ? s.noon_price : null)
    return r ? { ...s, final_cost: +r.finalCost.toFixed(4), rec_pc: recPc(s.category), noon_price: +r.price.toFixed(2), pc1: +r.pc1.toFixed(4) } : s
  }
  async function saveSkus(list = skus, ids = dirty) {
    const rows = list.filter((s) => ids.has(s.id)).map((s) => {
      const p = s.rec_pc === -1 ? s : priced(s) // rec_pc -1 = manual price override marker
      const { ...row } = p
      return row
    })
    if (!rows.length) return true
    const { error } = await supabase.from('lt_skus').upsert(rows)
    if (error) { toast(error.message); return false }
    setDirty(new Set()); toast('Saved')
    return true
  }
  // recompute prices for all SKUs (on rebate/category change) and save
  async function recomputeAll(rebate: number | null) {
    const s2 = { ...sub!, rebate_pct: rebate }
    const list = skus.map((s) => {
      if (s.rec_pc === -1) return s
      const r = computePrice(s.cost, s.rebate_pct ?? rebate, s.category)
      return r ? { ...s, final_cost: +r.finalCost.toFixed(4), rec_pc: recPc(s.category), noon_price: +r.price.toFixed(2), pc1: +r.pc1.toFixed(4) } : s
    })
    setSkus(list); setSub(s2)
    await supabase.from('lt_submissions').update({ rebate_pct: rebate }).eq('id', sub!.id)
    await supabase.from('lt_skus').upsert(list)
    await logEvent(sub!.id, 'rebate', rebate == null ? 'cleared' : pct(rebate, 2))
    toast('Rebate saved, prices updated')
  }

  async function runAi() {
    setBusy('ai')
    const items = active.map((s) => ({ id: s.id, brand: s.brand || sub!.brand, title: s.title_vendor || s.title || '', weight_g: s.weight_g, notes: s.notes }))
    const res = await aiEnrich(items)
    setBusy('')
    let list = skus
    if (res.error || !res.items) {
      toast(`AI unavailable (${res.error || 'no response'}) — filled basic titles & descriptions`)
      list = skus.map((s) => ({
        ...s,
        title: s.title || (s.title_vendor && !s.title_vendor.toLowerCase().startsWith((s.brand || sub!.brand).toLowerCase()) ? `${s.brand || sub!.brand} ${s.title_vendor}` : s.title_vendor),
        description: s.description || templateDescription(s.brand || sub!.brand, s.title || s.title_vendor || ''),
      }))
    } else {
      const by = Object.fromEntries(res.items.map((i) => [i.id, i]))
      list = skus.map((s) => {
        const a = by[s.id]
        if (!a) return s
        return {
          ...s, title: s.title || a.title, category: s.category || a.category, description: s.description || a.description,
          taxonomy_code: s.taxonomy_code || a.taxonomy_code, l1: s.l1 || a.l1, l2: s.l2 || a.l2, l3: s.l3 || a.l3,
        }
      })
      toast('AI filled titles, categories, descriptions and taxonomy (blanks only)')
    }
    list = list.map((s) => (s.rec_pc === -1 ? s : priced(s)))
    setSkus(list)
    await saveSkus(list, new Set(list.map((s) => s.id)))
    await logEvent(sub!.id, 'ai', 'Enriched SKUs')
  }

  const ctx: Ctx = { sub, vendor, today: todayRiyadh() }

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}><Link to="/admin">← Tracker</Link></div>
      <div className="card">
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="grow">
            <div className="row"><h2 style={{ fontSize: 22 }}>{sub.brand}</h2><span className="pill y">{sub.ref}</span>
              {sub.is_new_brand && <span className="pill">new brand</span>}{sub.rejected_at && <span className="pill bad">rejected</span>}</div>
            <div className="muted">{sub.vendor_name} · received {new Date(sub.created_at).toLocaleString('en-GB')} · {active.length} SKUs{sub.source_filename ? ` · from ${sub.source_filename}` : ''}</div>
            {sub.is_new_brand && <div className="small" style={{ marginTop: 6 }}>Website: {sub.brand_website ? <a href={sub.brand_website} target="_blank" rel="noreferrer">{sub.brand_website}</a> : <span className="pill bad">missing</span>} · Arabic name: {sub.brand_name_ar || <span className="pill bad">missing</span>}</div>}
            {sub.vendor_notes && <div className="alert" style={{ marginBottom: 0 }}>Vendor note: {sub.vendor_notes}</div>}
          </div>
          <div className="field" style={{ minWidth: 300 }}>
            <label>Vendor record (MPA / LE)</label>
            <select className={`in ${!vendor ? 'bad' : ''}`} value={sub.vendor_id ?? ''} onChange={async (e) => { await patchSub({ vendor_id: e.target.value || null }, 'Linked vendor'); }}>
              <option value="">— not linked —</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            <span className="small muted">{vendor ? `${vendor.mpa_code || 'no MPA'} · ${vendor.le_code || 'no LE'}` : 'New vendor? Add it under Vendors, then link it here.'}</span>
          </div>
        </div>
        <div className="steps" style={{ marginTop: 18 }}>
          {stageKeys.map((k, i) => (
            <div key={k.key} className={`step ${done[k.key] ? 'done' : ''} ${cur?.idx === i ? 'cur' : ''}`}
              title={TOGGLE[k.key] ? 'Click to mark done / undo' : 'Calculated automatically'}
              onClick={() => {
                const f = TOGGLE[k.key]; if (!f) return
                const v = sub[f] ? null : new Date().toISOString()
                if (!v && !confirm(`Undo "${k.label}"?`)) return
                patchSub({ [f]: v } as Partial<Sub>, `${v ? 'Marked' : 'Unmarked'}: ${k.label}`)
              }}>
              <span className="dot">{done[k.key] ? '✓' : ''}</span>{k.label}<span className="who">{k.who}</span>
            </div>
          ))}
        </div>
        {sub.content_request && !sub.content_request_resolved_at && (
          <div className="alert bad row"><span className="grow"><b>Content team is asking:</b> {sub.content_request}</span>
            <button className="btn sm" onClick={() => patchSub({ content_request_resolved_at: new Date().toISOString() }, 'Content request resolved')}>Mark resolved</button></div>
        )}
      </div>

      <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>

      {tab === 'Products & pricing' && <Products {...{ sub, skus, editSku, dirty, saveSkus, recomputeAll, runAi, busy, patchSub }} />}
      {tab === 'Approval email' && <Approval sub={sub} skus={active} patchSub={patchSub} />}
      {tab === 'NIS' && <Nis sub={sub} skus={active} patchSub={patchSub} reload={load} />}
      {tab === 'ZSKUs & taxonomy' && <Zskus sub={sub} skus={active} editSku={editSku} dirty={dirty} saveSkus={saveSkus} patchSub={patchSub} runAi={runAi} busy={busy} />}
      {tab === 'Uploads' && <Uploads sub={sub} skus={active} ctx={ctx} patchSub={patchSub} />}
      {tab === 'Activity' && (
        <div className="card">
          <div className="field" style={{ marginBottom: 14 }}><label>Your notes</label>
            <textarea className="in" rows={3} defaultValue={sub.admin_notes ?? ''} onBlur={(e) => e.target.value !== (sub.admin_notes ?? '') && patchSub({ admin_notes: e.target.value })} /></div>
          <div className="row" style={{ marginBottom: 12 }}>
            <button className="btn sm" onClick={() => patchSub({ rejected_at: sub.rejected_at ? null : new Date().toISOString() }, sub.rejected_at ? 'Un-rejected' : 'Rejected')}>{sub.rejected_at ? 'Un-reject' : 'Reject listing'}</button>
            <button className="btn sm" onClick={() => confirm('Archive this listing? It disappears from the tracker.') && patchSub({ archived: true }, 'Archived')}>Archive</button>
          </div>
          <table className="tbl"><tbody>{events.map((e) => <tr key={e.id}><td className="muted" style={{ width: 160 }}>{new Date(e.at).toLocaleString('en-GB')}</td><td style={{ width: 200 }}>{e.actor}</td><td><b>{e.kind}</b> {e.detail}</td></tr>)}</tbody></table>
        </div>
      )}
    </>
  )
}

// ================= Products & pricing =================
function Products({ sub, skus, editSku, dirty, saveSkus, recomputeAll, runAi, busy, patchSub }: {
  sub: Sub; skus: Sku[]; editSku: (id: string, p: Partial<Sku>) => void; dirty: Set<string>; saveSkus: () => Promise<boolean>
  recomputeAll: (r: number | null) => Promise<void>; runAi: () => Promise<void>; busy: string; patchSub: (p: Partial<Sub>, ev?: string) => Promise<void>
}) {
  const [reb, setReb] = useState(sub.rebate_pct != null ? String(+(sub.rebate_pct * 100).toFixed(3)) : '')
  const active = skus.filter((s) => !s.excluded)
  const missingCount = active.filter((s) => missingFor(s).length).length
  const lowPc1 = active.filter((s) => s.pc1 != null && s.rec_pc != null && s.rec_pc !== -1 && s.pc1 < s.rec_pc - 0.01)
  const canReady = (sub.rebate_pct != null || active.every((s) => s.rebate_pct != null)) && active.every((s) => s.category)
  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'flex-end', marginBottom: 14 }}>
        <div className="field" style={{ minWidth: 150 }}>
          <label>BM rebate % (all SKUs)</label>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className={`in ${sub.rebate_pct == null ? 'bad' : ''}`} style={{ width: 90 }} value={reb} onChange={(e) => setReb(e.target.value)} placeholder="e.g. 13" />
            <button className="btn sm dark" onClick={() => recomputeAll(reb === '' ? null : parseFloat(reb) / 100)}>Set</button>
          </div>
        </div>
        <div className="field grow">
          <label>Why we list it (opening line of Sharif's email)</label>
          <input className="in" defaultValue={sub.approval_reason ?? ''} placeholder="e.g. leading brand in the Matcha sub-category, we secured admons and 100% RTV"
            onBlur={(e) => e.target.value !== (sub.approval_reason ?? '') && patchSub({ approval_reason: e.target.value })} />
        </div>
        <button className="btn" disabled={busy === 'ai'} onClick={runAi}>{busy === 'ai' ? 'Working…' : '✨ AI: titles, categories, descriptions, taxonomy'}</button>
        <button className="btn pri" disabled={!dirty.size} onClick={() => saveSkus()}>Save{dirty.size ? ` (${dirty.size})` : ''}</button>
      </div>
      {missingCount > 0 && <div className="alert">{missingCount} SKU(s) have missing data (see the Missing column). You can still proceed.</div>}
      {lowPc1.length > 0 && <div className="alert bad">{lowPc1.length} SKU(s) have PC1 more than 1pt below REC PC.</div>}
      <div className="scroll">
        <table className="tbl">
          <thead><tr>
            <th>#</th><th>Title (noon style)</th><th>Category</th><th className="num">Wt (g)</th><th className="num">Cost</th><th className="num">Rebate</th>
            <th className="num">Final cost</th><th className="num">REC PC</th><th className="num">noon price</th><th className="num">PC1</th><th>Barcode</th><th className="num">MOQ</th>
            <th>Images</th><th>Missing</th><th>Excl.</th>
          </tr></thead>
          <tbody>
            {skus.map((s) => {
              const m = missingFor(s)
              const manual = s.rec_pc === -1
              const r = computePrice(s.cost, effRebate(s, sub), s.category, manual ? s.noon_price : null)
              return (
                <tr key={s.id} style={{ opacity: s.excluded ? 0.4 : 1 }}>
                  <td className="muted">{s.position}</td>
                  <td>
                    <input className="in" style={{ minWidth: 300 }} value={s.title ?? s.title_vendor ?? ''} onChange={(e) => editSku(s.id, { title: e.target.value })} />
                    {s.title && s.title_vendor && s.title !== s.title_vendor && <div className="muted small">vendor: {s.title_vendor}</div>}
                  </td>
                  <td><select className={`in ${!s.category ? 'bad' : ''}`} value={s.category ?? ''} onChange={(e) => editSku(s.id, { category: e.target.value })}>
                    <option value="">—</option><option>T&C</option><option>Breakfast</option></select></td>
                  <td className="num"><input className="in" style={{ width: 70 }} value={s.weight_g ?? ''} onChange={(e) => editSku(s.id, { weight_g: e.target.value === '' ? null : +e.target.value })} /></td>
                  <td className="num"><input className="in" style={{ width: 75 }} value={s.cost ?? ''} onChange={(e) => editSku(s.id, { cost: e.target.value === '' ? null : +e.target.value })} /></td>
                  <td className="num"><input className="in" style={{ width: 60 }} placeholder={sub.rebate_pct != null ? String(+(sub.rebate_pct * 100).toFixed(2)) : ''} value={s.rebate_pct != null ? +(s.rebate_pct * 100).toFixed(3) : ''}
                    onChange={(e) => editSku(s.id, { rebate_pct: e.target.value === '' ? null : +e.target.value / 100 })} title="Override for this SKU (%)" /></td>
                  <td className="num">{fmt(r?.finalCost, 3)}</td>
                  <td className="num">{pct(recPc(s.category), 0)}</td>
                  <td className="num">
                    <input key={`${s.id}-${r?.price ?? ''}`} className="in" style={{ width: 75, fontWeight: 700, background: manual ? '#fff4d6' : undefined }} defaultValue={r ? r.price.toFixed(2) : ''}
                      title="Type to override the computed price" onBlur={(e) => { const v = e.target.value.trim(); if (v === (r ? r.price.toFixed(2) : '')) return; editSku(s.id, { noon_price: v === '' ? null : +v, rec_pc: v === '' ? recPc(s.category) : -1 }) }} />
                    {manual && <div><a href="#" className="small" onClick={(e) => { e.preventDefault(); editSku(s.id, { rec_pc: recPc(s.category), noon_price: null }) }}>auto</a></div>}
                  </td>
                  <td className="num" style={{ color: r && r.pc1 < recPc(s.category) - 0.01 ? '#d93025' : undefined, fontWeight: 600 }}>{pct(r?.pc1)}</td>
                  <td><input className={`in ${s.barcode && !eanValid(s.barcode) ? 'bad' : ''}`} style={{ width: 130 }} value={s.barcode ?? ''} onChange={(e) => editSku(s.id, { barcode: e.target.value })} /></td>
                  <td className="num"><input className="in" style={{ width: 55 }} placeholder="12" value={s.moq ?? ''} onChange={(e) => editSku(s.id, { moq: e.target.value === '' ? null : +e.target.value })} /></td>
                  <td><div className="row" style={{ gap: 3, flexWrap: 'nowrap' }}>
                    {(['img_front', 'img_back', 'img_ingredients', 'img_nutrition'] as const).map((f) => s[f]
                      ? <a key={f} href={s[f]!} target="_blank" rel="noreferrer" title={f.slice(4)}><img className="thumb" src={s[f]!} alt="" onError={(e) => (e.currentTarget.style.opacity = '.3')} /></a>
                      : <span key={f} className="thumb" title={`${f.slice(4)} missing`} style={{ display: 'inline-grid', placeItems: 'center', fontSize: 10, color: '#d93025' }}>✕</span>)}
                    <ImgEdit s={s} editSku={editSku} />
                  </div></td>
                  <td>{m.length ? m.map((x) => <span key={x.key} className="pill bad" style={{ marginRight: 3 }}>{x.label}</span>) : <span className="pill ok">ok</span>}</td>
                  <td><input type="checkbox" checked={s.excluded} onChange={(e) => editSku(s.id, { excluded: e.target.checked })} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: 16, padding: 14, background: '#fafbfd', borderRadius: 8 }}>
        <div className="grow">
          <b>Next: approval email to Sharif</b>
          <div className="muted small">Marks this listing ready. On the next run (or when you tell me “draft approval for {sub.ref}”), Claude creates the New Listing Tracker tab + Summary row and drafts “{sub.brand} - BTC New Listing” in your Gmail.</div>
        </div>
        {sub.ready_for_approval_at
          ? <span className="pill ok">Ready since {new Date(sub.ready_for_approval_at).toLocaleDateString('en-GB')}</span>
          : <button className="btn pri" disabled={!canReady || dirty.size > 0} title={!canReady ? 'Add the rebate and a category for every SKU first' : dirty.size ? 'Save first' : ''}
              onClick={() => patchSub({ ready_for_approval_at: new Date().toISOString() }, 'Ready for approval email')}>Ready for approval email</button>}
      </div>
    </div>
  )
}

function ImgEdit({ s, editSku }: { s: Sku; editSku: (id: string, p: Partial<Sku>) => void }) {
  const [open, setOpen] = useState(false)
  if (!open) return <button className="btn sm ghost" title="Edit image links" onClick={() => setOpen(true)}>✎</button>
  return (
    <div style={{ position: 'absolute', background: '#fff', border: '1px solid #000', borderRadius: 8, padding: 10, zIndex: 5, width: 420 }}>
      {(['img_front', 'img_back', 'img_ingredients', 'img_nutrition'] as const).map((f) => (
        <div className="field" key={f} style={{ marginBottom: 6 }}><label>{f.slice(4)}</label>
          <input className="in" value={s[f] ?? ''} onChange={(e) => editSku(s.id, { [f]: e.target.value || null })} /></div>
      ))}
      <button className="btn sm" onClick={() => setOpen(false)}>Done</button>
    </div>
  )
}

// ================= Approval email =================
function approvalHtml(sub: Sub, skus: Sku[]) {
  const H = ['Brand', 'Title', 'Category', 'Weight (in g)', 'Cost wo/ VAT', 'BM Rebate %', 'Cost W/ Rebate', 'VAT', 'Final Cost', 'REC PC', 'noon Minutes', 'noon PC1', 'Barcode']
  const yellow = new Set(['REC PC', 'noon Minutes', 'noon PC1'])
  const th = (h: string) => `<td style="border:1px solid #000;padding:2px 3px;background-color:${yellow.has(h) ? 'rgb(251,188,4)' : 'rgb(32,18,77)'};font-weight:bold;color:${yellow.has(h) ? '#000' : '#fff'};text-align:center">${esc(h)}</td>`
  const td = (v: unknown, align = '') => `<td style="border:1px solid #000;padding:2px 3px;vertical-align:bottom;${align}">${esc(v)}</td>`
  const rows = skus.map((s) => {
    const reb = effRebate(s, sub)
    const r = computePrice(s.cost, reb, s.category, s.rec_pc === -1 ? s.noon_price : null)
    const cwr = s.cost != null && reb != null ? s.cost * (1 - reb) : null
    return `<tr>${td(s.brand || sub.brand)}${td(s.title || s.title_vendor)}${td(s.category)}${td(s.weight_g, 'text-align:center')}${td(fmt(s.cost), 'text-align:right')}${td(pct(reb, 2), 'text-align:right')}${td(fmt(cwr, 3), 'text-align:right')}${td('15%', 'text-align:right')}${td(fmt(r?.finalCost, 3), 'text-align:right')}${td(pct(recPc(s.category), 0), 'text-align:right')}${td(fmt(r?.price), 'text-align:right')}${td(pct(r?.pc1), 'text-align:right')}${td(s.barcode, 'text-align:center')}</tr>`
  }).join('')
  const cols = H.map((h) => `<col width="${h === 'Title' ? 400 : 100}">`).join('')
  const opening = `PFA the listing details for ${esc(sub.brand)}${sub.approval_reason ? `, ${esc(sub.approval_reason)}` : ''}.`
  return `<div dir="ltr"><div>Hey Mohamed,</div><div><br></div><div>${opening}</div><div><br></div><table cellspacing="0" cellpadding="0" border="1" style="table-layout:fixed;font-size:10pt;font-family:Arial;border-collapse:collapse"><colgroup>${cols}</colgroup><tbody><tr style="height:21px">${H.map(th).join('')}</tr>${rows}</tbody></table><div><br></div></div>`
}

function Approval({ sub, skus, patchSub }: { sub: Sub; skus: Sku[]; patchSub: (p: Partial<Sub>, ev?: string) => Promise<void> }) {
  const toast = useToast()
  const html = approvalHtml(sub, skus)
  async function copy() {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([html.replace(/<[^>]+>/g, ' ')], { type: 'text/plain' }) })])
      toast('Email body copied — paste into Gmail')
    } catch { toast('Copy failed — select the preview and copy manually') }
  }
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="grow">
          <b>To:</b> moalsharif@noon.com · <b>CC:</b> amelsheikh, rsamantaray, kchaithra · <b>Subject:</b> {sub.brand} - BTC New Listing
          <div className="muted small">Claude drafts this in your Gmail after you click “Ready for approval email”. You review and send.</div>
        </div>
        <button className="btn" onClick={copy}>Copy email body</button>
        {sub.approval_drafted_at ? <span className="pill ok">Drafted</span> : sub.ready_for_approval_at ? <span className="pill warn">Queued for Claude</span> : <span className="pill">Not ready</span>}
        {!sub.sharif_approved_at && <button className="btn sm" onClick={() => patchSub({ sharif_approved_at: new Date().toISOString() }, 'Sharif approved (manual)')}>Mark Sharif approved</button>}
      </div>
      <div style={{ overflow: 'auto', border: '1px solid var(--line)', padding: 14, borderRadius: 8 }} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

// ================= NIS =================
function b64(u8: Uint8Array) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s) }
function download(data: Uint8Array | Blob, name: string) {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

function Nis({ sub, skus, patchSub, reload }: { sub: Sub; skus: Sku[]; patchSub: (p: Partial<Sub>, ev?: string) => Promise<void>; reload: () => Promise<void> }) {
  const toast = useToast()
  const [tpl, setTpl] = useState<NisTemplate | null>(null)
  const [tplName, setTplName] = useState('')
  const [err, setErr] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  const missingDesc = skus.filter((s) => !s.description).length
  const noImgs = skus.filter((s) => !s.img_front && !s.img_back && !s.img_ingredients && !s.img_nutrition)

  async function onTpl(f: File) {
    setErr('')
    try { setTpl(await loadNisTemplate(await f.arrayBuffer())); setTplName(f.name) } catch (e) { setErr((e as Error).message) }
  }
  async function fill() {
    if (!tpl) return
    const t = await loadNisTemplate(await (await tpl.zip.generateAsync({ type: 'uint8array' })))
    const rows = skus.map((s) => ({
      brand: s.brand || sub.brand, title: s.title || s.title_vendor || '', barcode: s.barcode || '', weight_g: s.weight_g || 0,
      images: [s.img_front, s.img_back, s.img_ingredients, s.img_nutrition].filter(Boolean) as string[],
      description: s.description || templateDescription(s.brand || sub.brand, s.title || s.title_vendor || ''),
    }))
    const out = await fillNis(t, rows)
    const name = nisFileName(sub.brand, t.mainSubtype)
    download(out, name)
    // remember subtype per SKU and keep the file for Claude's creation email
    await Promise.all(skus.map((s, i) => supabase.from('lt_skus').update({ nis_subtype: subtypeForIndex(t, i) }).eq('id', s.id)))
    const cat = skus.some((s) => s.category === 'Breakfast') && !skus.some((s) => s.category === 'T&C') ? 'Breakfast' : 'Tea & Coffee'
    await patchSub({ nis_filled_at: new Date().toISOString(), nis_b64: b64(out), nis_filename: name, nis_category: cat } as Partial<Sub>, `NIS filled: ${name}`)
    toast('NIS downloaded and saved')
    reload()
  }
  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <h3>1. Drop the NIS template</h3>
          <div className="drop" onClick={() => ref.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onTpl(f) }}>
            {tplName ? <>📄 {tplName} · main subtype <b>{tpl?.mainSubtype}</b></> : <><b>NIS (Product Content Template) .xlsx</b><div className="muted small">Pre-fill a different product_subtype on specific rows for mixed listings — each row keeps its own.</div></>}
            <input ref={ref} hidden type="file" accept=".xlsx" onChange={(e) => { const f = e.target.files?.[0]; if (f) onTpl(f); e.target.value = '' }} />
          </div>
          {err && <div className="alert bad">{err}</div>}
        </div>
      </div>
      {tpl && (
        <>
          <h3 style={{ marginTop: 18 }}>2. Check row ↔ SKU subtypes</h3>
          <div className="scroll"><table className="tbl">
            <thead><tr><th>NIS row</th><th>Subtype</th><th>SKU</th><th>Category</th><th>Images</th><th>Description</th></tr></thead>
            <tbody>{skus.map((s, i) => {
              const st = subtypeForIndex(tpl, i)
              const own = tpl.leads.find((l) => l.row === i + 2)?.product_subtype
              return <tr key={s.id}><td>{i + 2}</td><td>{own ? <b>{st}</b> : <span className="muted">{st} (main)</span>}</td><td>{s.title || s.title_vendor}</td><td>{s.category}</td>
                <td>{[s.img_front, s.img_back, s.img_ingredients, s.img_nutrition].filter(Boolean).length}/4</td>
                <td>{s.description ? <span className="pill ok">AI</span> : <span className="pill warn">template</span>}</td></tr>
            })}</tbody>
          </table></div>
          {missingDesc > 0 && <div className="alert">{missingDesc} SKU(s) have no AI description yet — a generic one will be used. Run ✨ AI on the Products tab first for better copy.</div>}
          {noImgs.length > 0 && <div className="alert bad">{noImgs.length} SKU(s) have no images at all — content will bounce them.</div>}
          <div className="row" style={{ marginTop: 14 }}><button className="btn pri" onClick={fill}>Fill & download NIS</button></div>
        </>
      )}
      {sub.nis_filled_at && (
        <div className="row" style={{ marginTop: 18, padding: 14, background: '#fafbfd', borderRadius: 8 }}>
          <div className="grow">
            <b>Next: SKU creation email to Selva</b>
            <div className="muted small">Last NIS: {(sub as Sub & { nis_filename?: string }).nis_filename} ({new Date(sub.nis_filled_at).toLocaleString('en-GB')}). Claude drafts “{sub.brand} SKU Creation (9311 - {sub.nis_category || 'Tea & Coffee'})” with it attached{sub.is_new_brand ? ' + website & Arabic name' : ''}.</div>
          </div>
          {sub.ready_for_creation_at
            ? <span className="pill ok">Queued {new Date(sub.ready_for_creation_at).toLocaleDateString('en-GB')}</span>
            : <button className="btn pri" onClick={() => patchSub({ ready_for_creation_at: new Date().toISOString() }, 'Ready for creation email')}>Ready for creation email</button>}
        </div>
      )}
    </div>
  )
}

// ================= ZSKUs & taxonomy =================
function Zskus({ sub, skus, editSku, dirty, saveSkus, patchSub, runAi, busy }: {
  sub: Sub; skus: Sku[]; editSku: (id: string, p: Partial<Sku>) => void; dirty: Set<string>; saveSkus: () => Promise<boolean>
  patchSub: (p: Partial<Sub>, ev?: string) => Promise<void>; runAi: () => Promise<void>; busy: string
}) {
  const toast = useToast()
  const ref = useRef<HTMLInputElement>(null)
  async function onFile(f: File) {
    const hits = await readZskuFile(f)
    let n = 0
    for (const s of skus) {
      const h = hits.find((x) => sameBarcode(x.barcode, s.barcode))
      if (h) { editSku(s.id, { zsku: h.zsku, partner_sku: h.partner_sku || s.partner_sku }); n++ }
    }
    toast(`Matched ${n}/${skus.length} SKUs by barcode — click Save`)
  }
  const allZ = skus.length > 0 && skus.every((s) => s.zsku && s.partner_sku)
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="grow"><b>ZSKUs from content</b> <span className="muted small">Claude imports them from Salwa/Selva's “PFA the zskus” email automatically. You can also drop the file here.</span></div>
        <button className="btn" onClick={() => ref.current?.click()}>Import ZSKU file</button>
        <input ref={ref} hidden type="file" accept=".xlsx,.xls,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
        <button className="btn" disabled={busy === 'ai'} onClick={runAi}>✨ AI taxonomy</button>
        <button className="btn pri" disabled={!dirty.size} onClick={async () => { if (await saveSkus() && allZ && !sub.zskus_received_at) patchSub({ zskus_received_at: new Date().toISOString() }, 'ZSKUs received') }}>Save{dirty.size ? ` (${dirty.size})` : ''}</button>
      </div>
      <datalist id="lt-codes">{codes.map((c) => <option key={c} value={c} />)}</datalist>
      <div className="scroll"><table className="tbl">
        <thead><tr><th>#</th><th>Title</th><th>Barcode</th><th>PSKU</th><th>ZSKU</th><th>Taxonomy category_code</th><th>L1 › L2 › L3</th></tr></thead>
        <tbody>{skus.map((s) => (
          <tr key={s.id}>
            <td className="muted">{s.position}</td>
            <td style={{ minWidth: 240 }}>{s.title || s.title_vendor}</td>
            <td>{s.barcode}</td>
            <td><input className={`in ${!s.partner_sku ? 'bad' : ''}`} style={{ width: 140 }} value={s.partner_sku ?? ''} onChange={(e) => editSku(s.id, { partner_sku: e.target.value.trim() || null })} /></td>
            <td><input className={`in ${!s.zsku ? 'bad' : ''}`} style={{ width: 230 }} value={s.zsku ?? ''} onChange={(e) => editSku(s.id, { zsku: e.target.value.trim() || null })} /></td>
            <td><input className={`in ${!s.taxonomy_code ? 'bad' : ''}`} list="lt-codes" style={{ width: 200 }} value={s.taxonomy_code ?? ''} onChange={(e) => editSku(s.id, { taxonomy_code: e.target.value || null })} /></td>
            <td><select className={`in ${!s.l3 ? 'bad' : ''}`} value={s.l1 ? `${s.l1}|${s.l2}|${s.l3}` : ''} onChange={(e) => { const [l1, l2, l3] = e.target.value.split('|'); editSku(s.id, { l1: l1 || null, l2: l2 || null, l3: l3 || null }) }}>
              <option value="">—</option>
              {s.l1 && !combos.some((c) => c.join('|') === `${s.l1}|${s.l2}|${s.l3}`) && <option value={`${s.l1}|${s.l2}|${s.l3}`}>{s.l1} › {s.l2} › {s.l3}</option>}
              {combos.map((c) => <option key={c.join('|')} value={c.join('|')}>{c[0]} › {c[1]} › {c[2]}</option>)}
            </select></td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  )
}

// ================= Uploads =================
function Uploads({ sub, skus, ctx, patchSub }: { sub: Sub; skus: Sku[]; ctx: Ctx; patchSub: (p: Partial<Sub>, ev?: string) => Promise<void> }) {
  const toast = useToast()
  const ups = sub.uploads || {}
  const ready = skus.filter((s) => s.zsku)
  async function toggle(key: string, name: string) {
    const next = { ...ups, [key]: ups[key] ? '' : new Date().toISOString() }
    if (!next[key]) delete next[key]
    await patchSub({ uploads: next }, `${next[key] ? 'Uploaded' : 'Un-marked'}: ${name}`)
  }
  async function copy(text: string, name: string) { await navigator.clipboard.writeText(text); toast(`${name} copied (headers + ${ready.length} rows)`) }
  const instock = toTsv(INSTOCK_HEADERS, ready.map((s) => instockRow(s, ctx)))
  return (
    <>
      {!ready.length && <div className="alert bad">No ZSKUs yet — uploads unlock once content shares them.</div>}
      {!ctx.vendor?.mpa_code && <div className="alert bad">Vendor isn't linked or has no MPA code — link it at the top.</div>}
      <div className="upgrid">
        {UPLOADS.map((u, i) => {
          const rows = ready.map((s) => u.row(s, ctx))
          const tsv = toTsv(u.headers, rows)
          const miss = Array.from(new Set(ready.flatMap((s) => upMissing(u, s, ctx))))
          const isDone = !!ups[u.key]
          return (
            <div key={u.key} className={`upcard ${isDone ? 'done' : ''}`}>
              <div className="row"><span className="num-badge">{i + 1}</span><b className="grow">{u.name}</b>
                <label className="row small" style={{ gap: 5 }}><input type="checkbox" checked={isDone} onChange={() => toggle(u.key, u.name)} /> Done</label></div>
              {miss.length > 0 && <div className="small" style={{ color: '#d93025' }}>Missing: {miss.join(', ')}</div>}
              <pre>{tsv}</pre>
              <div className="row">
                <button className="btn sm pri" disabled={!ready.length} onClick={() => copy(tsv, u.name)}>Copy</button>
                {u.url ? <a className="btn sm" href={u.url} target="_blank" rel="noreferrer">Open upload page ↗</a> : <span className="muted small">No link in your sheet</span>}
              </div>
            </div>
          )
        })}
        <div className={`upcard ${sub.instock_added_at ? 'done' : ''}`}>
          <div className="row"><span className="num-badge">+</span><b className="grow">INSTOCK (BTC New Listings › SKUs)</b>
            <label className="row small" style={{ gap: 5 }}><input type="checkbox" checked={!!sub.instock_added_at} onChange={() => patchSub({ instock_added_at: sub.instock_added_at ? null : new Date().toISOString() }, 'INSTOCK toggled')} /> Done</label></div>
          <div className="muted small">Claude appends these rows to the bottom of the SKUs tab once all 12 uploads are ticked.</div>
          <pre>{instock}</pre>
          <div className="row"><button className="btn sm" disabled={!ready.length} onClick={() => copy(instock.split('\n').slice(1).join('\n'), 'INSTOCK rows')}>Copy rows</button>
            <a className="btn sm" href="https://docs.google.com/spreadsheets/d/1QFM8NzkiiiWS0ZcK6l3NBjI59PVu5SRBeHmf3JKBtZU/edit" target="_blank" rel="noreferrer">Open sheet ↗</a></div>
        </div>
      </div>
    </>
  )
}
