import { useEffect, useState } from 'react'
import { supabase, type Vendor } from '../../lib/supabase'
import { useToast } from './Shell'

export default function Vendors() {
  const [list, setList] = useState<Vendor[]>([])
  const [q, setQ] = useState('')
  const [nv, setNv] = useState({ name: '', mpa_code: '', le_code: '' })
  const toast = useToast()
  const load = () => supabase.from('lt_vendors').select('*').order('name').then(({ data }) => setList((data || []) as Vendor[]))
  useEffect(() => { load() }, [])

  async function save(v: Vendor, patch: Partial<Vendor>) {
    const { error } = await supabase.from('lt_vendors').update(patch).eq('id', v.id)
    if (error) return toast(error.message)
    setList((l) => l.map((x) => (x.id === v.id ? { ...x, ...patch } : x)))
    toast('Saved')
  }
  async function add() {
    if (!nv.name.trim()) return
    const { error } = await supabase.from('lt_vendors').insert({ name: nv.name.trim(), mpa_code: nv.mpa_code.trim() || null, le_code: nv.le_code.trim() || null })
    if (error) return toast(error.message)
    setNv({ name: '', mpa_code: '', le_code: '' }); load(); toast('Vendor added')
  }

  const shown = list.filter((v) => !q || `${v.name} ${v.mpa_code} ${v.brands?.join(' ')}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="grow"><h2>Vendors</h2><span className="muted small">MPA and LE codes come from Master Assortment. Vendors see names only.</span></div>
        <input className="in" style={{ width: 260 }} placeholder="Search vendor, MPA, brand" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="row" style={{ marginBottom: 12, background: '#fafbfd', padding: 10, borderRadius: 8 }}>
        <input className="in grow" placeholder="New vendor legal name" value={nv.name} onChange={(e) => setNv({ ...nv, name: e.target.value })} />
        <input className="in" style={{ width: 170 }} placeholder="MPA code" value={nv.mpa_code} onChange={(e) => setNv({ ...nv, mpa_code: e.target.value })} />
        <input className="in" style={{ width: 150 }} placeholder="LE code" value={nv.le_code} onChange={(e) => setNv({ ...nv, le_code: e.target.value })} />
        <button className="btn pri" onClick={add}>Add vendor</button>
      </div>
      <div className="scroll">
        <table className="tbl">
          <thead><tr><th>Vendor</th><th>MPA code</th><th>LE (entity) code</th><th>Brands in assortment</th></tr></thead>
          <tbody>
            {shown.map((v) => (
              <tr key={v.id}>
                <td><input className="in" defaultValue={v.name} onBlur={(e) => e.target.value !== v.name && save(v, { name: e.target.value })} style={{ minWidth: 320 }} /></td>
                <td><input className={`in ${!v.mpa_code ? 'bad' : ''}`} defaultValue={v.mpa_code ?? ''} onBlur={(e) => e.target.value !== (v.mpa_code ?? '') && save(v, { mpa_code: e.target.value || null })} /></td>
                <td><input className={`in ${!v.le_code ? 'bad' : ''}`} defaultValue={v.le_code ?? ''} onBlur={(e) => e.target.value !== (v.le_code ?? '') && save(v, { le_code: e.target.value || null })} /></td>
                <td className="muted small">{(v.brands || []).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
