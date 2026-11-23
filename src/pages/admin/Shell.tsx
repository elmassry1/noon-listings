import { useEffect, useState, createContext, useContext } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'

const ToastCtx = createContext<(m: string) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export default function AdminShell() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null)
  const [toast, setToast] = useState('')

  useEffect(() => {
    document.documentElement.dir = 'ltr'
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])
  useEffect(() => {
    if (!session) { setIsAdmin(null); return }
    supabase.from('lt_admins').select('email').then(({ data }) => setIsAdmin(!!data?.length))
  }, [session])

  const show = (m: string) => { setToast(m); setTimeout(() => setToast(''), 2600) }

  if (session === undefined) return null
  if (!session) return <Login />
  if (isAdmin === null) return null
  if (!isAdmin)
    return (
      <div className="center"><div className="card" style={{ maxWidth: 420 }}>
        <h2>No access</h2><p className="muted">{session.user.email} is not an admin of this tool.</p>
        <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div></div>
    )

  return (
    <ToastCtx.Provider value={show}>
      <div className="nav">
        <div className="logo">noon <i>Minutes</i> <span style={{ fontWeight: 500, fontSize: 14, color: '#cfd2dc' }}>Listings</span></div>
        <NavLink to="/admin" end>Tracker</NavLink>
        <NavLink to="/admin/vendors">Vendors</NavLink>
        <div className="sp" />
        <a href="#" onClick={(e) => { e.preventDefault(); navigator.clipboard.writeText(location.origin + '/'); show('Vendor link copied') }}>Copy vendor link</a>
        <span style={{ color: '#7e859b' }}>{session.user.email}</span>
        <a href="#" onClick={(e) => { e.preventDefault(); supabase.auth.signOut() }}>Sign out</a>
      </div>
      <div className="wrap"><Outlet /></div>
      {toast && <div className="toast">{toast}</div>}
    </ToastCtx.Provider>
  )
}

function Login() {
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg('')
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password: pw })
    setBusy(false)
    if (error) setMsg(error.message)
  }
  async function magic() {
    if (!email) return setMsg('Enter your email first')
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { shouldCreateUser: false, emailRedirectTo: location.origin + '/admin' } })
    setMsg(error ? error.message : 'Check your inbox for the sign-in link.')
  }
  return (
    <>
      <div className="nav"><div className="logo">noon <i>Minutes</i> <span style={{ fontWeight: 500, fontSize: 14, color: '#cfd2dc' }}>Listings</span></div></div>
      <div className="center">
        <form className="card" style={{ width: 380 }} onSubmit={go}>
          <h2>Sign in</h2>
          <p className="muted small">Same email and password as the commercial task portal.</p>
          <div className="field" style={{ marginBottom: 10 }}><label>Email</label><input className="in" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></div>
          <div className="field" style={{ marginBottom: 14 }}><label>Password</label><input className="in" type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
          <div className="row"><button className="btn pri" disabled={busy}>Sign in</button><button type="button" className="btn ghost" onClick={magic}>Email me a link</button></div>
          {msg && <div className="alert">{msg}</div>}
        </form>
      </div>
    </>
  )
}
