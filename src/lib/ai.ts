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
