import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "npm:@supabase/supabase-js@2"

const TAX = {"codes":["sa_black_tea","sa_flavored_tea","sa_green_herbal_tea","sa_matcha","sa_instant_coffee","sa_capsules_pods","sa_coffee_creamers","sa_ground_beans","sa_turkish_coffee","sa_turkish_arabic_coffee","sa_iced_tea_coffee","sa_coffee_accessories","sa_chocolate_malt_drinks","sa_nutrition","sa_jams_honey","sa_honey","sa_oats","sa_breakfast_spreads","sa_granola_muesli","sa_breakfast_cereals","sa_healthy_cereal_granola_bar","sa_halawa_tahini","sa_imported_beverages","sa_imported_breakfast","sa_imported","sa_nuts_seeds","sa_nuts","sa_chocolate_candy","sa_chocolate_sharing","sa_single_chocolates"],"combos":["tea_and_coffee > tea_and_coffee_accessories > tea_and_coffee_accessories","tea_and_coffee > tea > tea_matcha","tea_and_coffee > tea > tea_herbal","tea_and_coffee > tea > tea_green","tea_and_coffee > tea > tea_black","tea_and_coffee > powdered_drinks_creamers > malt_based_nutrition_drinks","tea_and_coffee > powdered_drinks_creamers > hot_chocolate","tea_and_coffee > powdered_drinks_creamers > coffee_foams","tea_and_coffee > powdered_drinks_creamers > coffee_creamers","tea_and_coffee > coffee > whole_coffee_beans","tea_and_coffee > coffee > instant_coffee","tea_and_coffee > coffee > ground_coffee","tea_and_coffee > coffee > capsules_pods","breakfast > oats > oats_rolled","breakfast > oats > oats_other","breakfast > oats > oats_instant","breakfast > nut_butter > nut_butter_pistachio","breakfast > nut_butter > nut_butter_peanut","breakfast > nut_butter > nut_butter_other","breakfast > nut_butter > nut_butter_hazlenut","breakfast > nut_butter > nut_butter_almond","breakfast > muesli_granola > muesli","breakfast > muesli_granola > granola","breakfast > jam_marmelades > marmelades","breakfast > jam_marmelades > jam","breakfast > honey > honey_other","breakfast > honey > honey_organic","breakfast > honey > honey_manuka","breakfast > honey > honey_floral","breakfast > honey > honey_black_forest","breakfast > halawa > halawa","breakfast > confectionery_infused_spreads > spreads_chocolate","breakfast > confectionery_infused_spreads > spreads_branded_other","breakfast > confectionery_infused_spreads > spreads_biscoff","breakfast > cereal > cereal_kids","breakfast > cereal > cereal_healthy","breakfast > cereal > cereal_corn_flakes","breakfast > breakfast_indian > breakfast_indian_upma","breakfast > breakfast_indian > breakfast_indian_poha","breakfast > breakfast_indian > breakfast_indian_mamra","breakfast > breakfast_bars > breakfast_bars_oat","breakfast > breakfast_bars > breakfast_bars_granola","breakfast > breakfast_bars > breakfast_bars_cereal"]}
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } })

async function claude(model: string, system: string, user: string | unknown[], max_tokens = 4000) {
  const key = Deno.env.get("ANTHROPIC_API_KEY")
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set in Supabase secrets")
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens, system, messages: [{ role: "user", content: user }] }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error(d?.error?.message || `Anthropic ${r.status}`)
  const text = (d.content || []).map((c: { text?: string }) => c.text || "").join("")
  const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
  if (!m) throw new Error("No JSON in model output")
  return JSON.parse(m[0])
}

const FIELDS = ["title","weight_g","barcode","cost","moq","img_front","img_back","img_ingredients","img_nutrition","notes"]

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  try {
    const body = await req.json()
    if (body.action === "map") {
      const headers = (body.headers || []).slice(0, 60).map((h: unknown) => String(h ?? "").slice(0, 80))
      const sample = (body.sample || []).slice(0, 5).map((r: unknown[]) => (r || []).slice(0, 60).map((c) => String(c ?? "").slice(0, 80)))
      const out = await claude("claude-haiku-5-5",
        "You map columns of a supplier's product listing spreadsheet to target fields. Reply with JSON only.",
        `Target fields:\n- title: product name in English\n- weight_g: net weight/size\n- barcode: EAN/UPC barcode\n- cost: supplier cost/price per piece excluding VAT (NOT retail/RSP/selling price, NOT price incl. VAT)\n- moq: pieces per case/carton\n- img_front, img_back, img_ingredients, img_nutrition: image links\n- notes\n\nColumns (index: header): ${headers.map((h: string, i: number) => `${i}: ${h}`).join(" | ")}\nSample rows: ${JSON.stringify(sample)}\n\nReturn {"mapping": {"field": columnIndex, ...}} including only fields you are confident about. Use -1 if absent.`, 600)
      const mapping: Record<string, number> = {}
      for (const f of FIELDS) { const v = out?.mapping?.[f]; if (typeof v === "number" && v >= 0 && v < headers.length) mapping[f] = v }
      return json({ mapping })
    }
    if (body.action === "extract") {
      const data = String(body.data || "")
      const mime = String(body.mime || "")
      if (!data || data.length > 11_000_000) return json({ error: "File too large (max 8 MB)" }, 400)
      const isPdf = mime === "application/pdf"
      if (!isPdf && !/^image\/(png|jpeg|webp|gif)$/.test(mime)) return json({ error: "Unsupported file type" }, 400)
      const block = isPdf
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
        : { type: "image", source: { type: "base64", media_type: mime, data } }
      const out = await claude("claude-sonnet-5-5",
        "You extract product rows from a supplier's new-listing offer (price list, quotation or product sheet) for noon Minutes, a Saudi quick-commerce retailer. Reply with JSON only.",
        [block, { type: "text", text: `Extract every product in this document. For each return:
- title: product name in English as written (Brand + product + variant + size). If only Arabic is given, translate it to English.
- weight_g: net weight in grams as a number (kg x 1000; for liquids use ml as grams). For multipacks use the total. Empty if not stated.
- barcode: EAN/UPC digits only, keep leading zeros. Empty if not stated.
- cost: supplier cost per single piece EXCLUDING VAT, as a number. If only a case/carton price is given, divide by pieces per case. If the price clearly includes VAT, divide by 1.15. Never use RSP, retail, shelf or selling price. Empty if not stated.
- moq: pieces per case/carton as a number, empty if not stated.
- notes: anything important for that product (promo, exclusivity), else empty.
Never invent values. Return {"rows":[{"title","weight_g","barcode","cost","moq","notes"}]}` }], 16000)
      const rows = (out.rows || []).slice(0, 300).map((r: Record<string, unknown>) => Object.fromEntries(
        ["title", "weight_g", "barcode", "cost", "moq", "notes"].map((k) => [k, r[k] == null ? "" : String(r[k])])))
      return json({ rows })
    }
    if (body.action === "enrich") {
      const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } })
      const { data: adm } = await sb.from("lt_admins").select("email").limit(1)
      if (!adm?.length) return json({ error: "Admins only" }, 403)
      const items = (body.items || []).slice(0, 150)
      const results: unknown[] = []
      for (let i = 0; i < items.length; i += 25) {
        const chunk = items.slice(i, i + 25)
        const out = await claude("claude-sonnet-5-5",
          `You prepare product listings for noon Minutes (Saudi quick-commerce), Tea & Coffee and Breakfast categories. Reply with JSON only.
Rules:
- title: English noon style "Brand Product Variant Size", Title Case, size like 250g / 1kg / 20 Tea Bags / 10 Capsules. Start with the brand. Keep facts from the input; translate Arabic to English; no marketing words.
- category: "T&C" (tea, coffee, capsules, creamers, hot chocolate, malt drinks, matcha) or "Breakfast" (cereal, oats, granola, muesli, honey, jam, spreads, nut butter, halawa, breakfast bars).
- description: 3 sentences, 60-80 words, warm marketing tone. Open with "<Brand> brings you..." (or similar), state product type and origin/process/variant from the title, then sensory benefit, then usage occasion. Only facts from the input; generic sensory words are fine; never invent tasting notes, certifications, machine compatibility, health claims or origins.
- taxonomy_code: pick exactly one from CODES.
- l1/l2/l3: pick exactly one line from COMBOS ("l1 > l2 > l3").
CODES: ${JSON.stringify(TAX.codes)}
COMBOS: ${JSON.stringify(TAX.combos)}`,
          `Products: ${JSON.stringify(chunk)}\nReturn {"items":[{"id","title","category","description","taxonomy_code","l1","l2","l3"}]} — one per input id.`, 8000)
        const valid = new Set(TAX.combos)
        for (const it of out.items || []) {
          if (!TAX.codes.includes(it.taxonomy_code)) it.taxonomy_code = ""
          if (!valid.has(`${it.l1} > ${it.l2} > ${it.l3}`)) { it.l1 = ""; it.l2 = ""; it.l3 = "" }
          if (!["T&C", "Breakfast"].includes(it.category)) it.category = ""
          results.push(it)
        }
      }
      return json({ items: results })
    }
    return json({ error: "unknown action" }, 400)
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500)
  }
})
