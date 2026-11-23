import { supabase } from './supabase'

export async function aiMapColumns(headers: string[], sample: string[][]): Promise<Record<string, number> | null> {
  try {
    const { data, error } = await supabase.functions.invoke('lt-ai', { body: { action: 'map', headers, sample } })
    if (error || !data?.mapping) return null
    return data.mapping
  } catch {
    return null
  }
}

export type EnrichIn = { id: string; brand: string; title: string; weight_g: number | null; notes?: string | null }
export type EnrichOut = {
  id: string; title: string; category: 'T&C' | 'Breakfast'; description: string
  taxonomy_code: string; l1: string; l2: string; l3: string
}

export async function aiEnrich(items: EnrichIn[]): Promise<{ items?: EnrichOut[]; error?: string }> {
  const { data, error } = await supabase.functions.invoke('lt-ai', { body: { action: 'enrich', items } })
  if (error) {
    let msg = error.message
    try { msg = (await (error as any).context.json()).error || msg } catch { /* ignore */ }
    return { error: msg }
  }
  return data
}

/** PDF or image (photo/screenshot of a price list) -> product rows via Claude */
export async function aiExtractFile(file: File): Promise<{ rows?: Record<string, string>[]; error?: string }> {
  if (file.size > 8 * 1024 * 1024) return { error: 'too_large' }
  const buf = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  const mime = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : '')
  const { data, error } = await supabase.functions.invoke('lt-ai', { body: { action: 'extract', data: btoa(bin), mime } })
  if (error || !data?.rows) return { error: data?.error || error?.message || 'failed' }
  return { rows: data.rows }
}
