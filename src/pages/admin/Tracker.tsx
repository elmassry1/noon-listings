import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, type Submission } from '../../lib/supabase'
import { currentStage, stageDone, stageKeys, missingFor, UPLOAD_COUNT } from '../../lib/pricing'

export default function Tracker() {
  const [subs, setSubs] = useState<Submission[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'active' | 'done' | 'all'>('active')
  const [q, setQ] = useState('')
  const nav = useNavigate()

  useEffect(() => {
    supabase.from('lt_submissions').select('*, lt_vendors(*), lt_skus(*)').eq('archived', false).order('created_at', { ascending: false })
      .then(({ data }) => { setSubs((data || []) as Submission[]); setLoading(false) })
  }, [])

  const rows = useMemo(() => subs.map((s) => {
    const skus = (s.lt_skus || []).filter((k) => !k.excluded)
    const st = currentStage(s, skus)
    const d = stageDone(s, skus)
    const missing = skus.filter((k) => missingFor(k).length > 0).length
    return { s, skus, st, d, missing, ups: Object.values(s.uploads || {}).filter(Boolean).length }
  }).filter(({ s, st }) => {
    if (filter === 'active' && (st.label === 'Done' || s.rejected_at)) return false
    if (filter === 'done' && st.label !== 'Done') return false
    if (q && !`${s.ref} ${s.vendor_name} ${s.brand}`.toLowerCase().includes(q.toLowerCase())) return false
    return true
  }), [subs, filter, q])

  const counts = useMemo(() => {
    const all = subs.map((s) => ({ s, st: currentStage(s, (s.lt_skus || []).filter((k) => !k.excluded)) }))
    const by = (lbl: string) => all.filter((x) => x.st.label === lbl).length
    return {
      newOnes: by('Rebate added') + by('Review & mark ready'), approval: by('Sharif approved'), content: all.filter((x) => ['Shared w/ content', 'Listed 9311', 'ZSKUs received'].includes(x.st.label)).length,
      uploads: by('Uploads'), contentReq: all.filter((x) => x.s.content_request && !x.s.content_request_resolved_at).length,
      done: by('Done'),
    }
  }, [subs])

  return (
    <>
      <div className="kpis">
        <div className="kpi"><span className="muted small">Need rebate / review</span><b>{counts.newOnes}</b></div>
        <div className="kpi"><span className="muted small">Waiting on Sharif</span><b>{counts.approval}</b></div>
        <div className="kpi"><span className="muted small">With content</span><b>{counts.content}</b></div>
        <div className="kpi"><span className="muted small">Content asking for data</span><b style={{ color: counts.contentReq ? '#d93025' : undefined }}>{counts.contentReq}</b></div>
        <div className="kpi"><span className="muted small">Ready for uploads</span><b>{counts.uploads}</b></div>
        <div className="kpi"><span className="muted small">Done</span><b>{counts.done}</b></div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ padding: 14 }}>
          <h2 className="grow">Listings</h2>
          <input className="in" style={{ width: 240 }} placeholder="Search ref, vendor, brand" value={q} onChange={(e) => setQ(e.target.value)} />
          {(['active', 'done', 'all'] as const).map((f) => <button key={f} className={`btn sm ${filter === f ? 'dark' : ''}`} onClick={() => setFilter(f)}>{f}</button>)}
        </div>
        <div className="scroll" style={{ border: 0, borderTop: '1px solid var(--line)', borderRadius: 0, maxHeight: 'none' }}>
          <table className="tbl">
            <thead><tr><th>Ref</th><th>Received</th><th>Vendor</th><th>Brand</th><th className="num">SKUs</th><th>Missing data</th><th>Progress</th><th>Next step</th><th>Owner</th><th>Flags</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={10} className="muted">Loading…</td></tr>}
              {!loading && !rows.length && <tr><td colSpan={10} className="muted">Nothing here yet. Share the vendor link to start collecting listings.</td></tr>}
              {rows.map(({ s, skus, st, d, missing, ups }) => (
                <tr key={s.id} className="click" onClick={() => nav(`/admin/s/${s.id}`)}>
                  <td><b>{s.ref}</b></td>
                  <td className="muted">{new Date(s.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</td>
                  <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.vendor_name}{!s.vendor_id && <span className="pill warn" style={{ marginLeft: 6 }}>new vendor</span>}</td>
                  <td><b>{s.brand}</b>{s.is_new_brand && <span className="pill" style={{ marginLeft: 6 }}>new brand</span>}</td>
                  <td className="num">{skus.length}</td>
                  <td>{missing ? <span className="pill bad">{missing} SKU{missing > 1 ? 's' : ''}</span> : <span className="pill ok">complete</span>}</td>
                  <td>
                    <div className="mini" title={stageKeys.map((k) => `${d[k.key] ? '✓' : '·'} ${k.label}`).join('\n')}>
                      {stageKeys.map((k, i) => <span key={k.key} className={d[k.key] ? 'd' : i === st.idx ? 'c' : ''} />)}
                    </div>
                  </td>
                  <td><b>{st.label}</b>{st.label === 'Uploads' && <span className="muted"> {ups}/{UPLOAD_COUNT}</span>}</td>
                  <td className="muted">{st.who}</td>
                  <td>
                    {s.content_request && !s.content_request_resolved_at && <span className="pill bad" title={s.content_request}>content asking</span>}
                    {s.rejected_at && <span className="pill bad">rejected</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
