import { createClient } from '@supabase/supabase-js'

export const SUPABASE_URL = 'https://wznzxmxkecefvfaamhyt.supabase.co'
export const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind6bnp4bXhrZWNlZnZmYWFtaHl0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1MzEwMzEsImV4cCI6MjEwMTEwNzAzMX0.0V19Q7mETpgMXR7WdjRMOM4Fr9jBGMZZ6CpB3ae_3yI'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, storageKey: 'lt-auth' },
})

export type Vendor = { id: string; name: string; mpa_code: string | null; le_code: string | null; brands: string[] }

export type Submission = {
  id: string; ref: string; vendor_id: string | null; vendor_name: string; brand: string
  is_new_brand: boolean; brand_website: string | null; brand_name_ar: string | null; vendor_notes: string | null
  source_filename: string | null; lang: string | null; created_at: string
  rebate_pct: number | null; approval_reason: string | null; admin_notes: string | null
  ready_for_approval_at: string | null; tracker_tab: string | null; tracker_synced_at: string | null
  approval_drafted_at: string | null; sharif_approved_at: string | null
  nis_filled_at: string | null; nis_path: string | null; nis_category: string | null; nis_b64?: string | null; nis_filename?: string | null
  ready_for_creation_at: string | null; creation_drafted_at: string | null; creation_subject: string | null
  shared_with_content_at: string | null; content_request: string | null; content_request_at: string | null
  content_request_resolved_at: string | null; listed_9311_at: string | null; zskus_received_at: string | null
  uploads: Record<string, string>; instock_added_at: string | null; rejected_at: string | null; archived: boolean
  lt_vendors?: Vendor | null
  lt_skus?: Sku[]
}

export type Sku = {
  id: string; submission_id: string; position: number; brand: string | null; title_vendor: string | null; title: string | null
  category: string | null; weight_g: number | null; cost: number | null; barcode: string | null; moq: number | null
  img_front: string | null; img_back: string | null; img_ingredients: string | null; img_nutrition: string | null
  notes: string | null; rebate_pct: number | null; rec_pc: number | null; noon_price: number | null
  final_cost: number | null; pc1: number | null; nis_subtype: string | null; description: string | null
  taxonomy_code: string | null; l1: string | null; l2: string | null; l3: string | null
  partner_sku: string | null; zsku: string | null; excluded: boolean
}

export async function logEvent(submission_id: string, kind: string, detail = '') {
  const { data } = await supabase.auth.getUser()
  await supabase.from('lt_events').insert({ submission_id, kind, detail, actor: data.user?.email ?? 'admin' })
}
