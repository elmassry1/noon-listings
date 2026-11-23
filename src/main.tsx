import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './styles.css'
import Vendor from './pages/Vendor'
import AdminShell from './pages/admin/Shell'
import Tracker from './pages/admin/Tracker'
import Submission from './pages/admin/Submission'
import Vendors from './pages/admin/Vendors'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Vendor />} />
        <Route path="/admin" element={<AdminShell />}>
          <Route index element={<Tracker />} />
          <Route path="s/:id" element={<Submission />} />
          <Route path="vendors" element={<Vendors />} />
        </Route>
        <Route path="*" element={<Vendor />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
