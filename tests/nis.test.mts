import { readFileSync, writeFileSync } from 'fs'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { loadNisTemplate, fillNis, subtypeForIndex } from '../src/lib/nis.ts'
const dom = { parser: new DOMParser() as any, serializer: new XMLSerializer() as any }
const t = await loadNisTemplate(readFileSync(process.argv[2]), dom)
console.log('headers', Object.keys(t.headers).length, 'leads', t.leads.length, 'main', t.mainSubtype, subtypeForIndex(t,0))
const out = await fillNis(t, [
  { brand: 'TestBrand', title: 'TestBrand Hot Chocolate 250g', barcode: '0062870185813', weight_g: 250, images: ['https://a/1.png','https://a/2.png','https://a/1.png'], description: 'Desc & <stuff> "q"' },
  { brand: 'TestBrand', title: 'TestBrand Cocoa 1kg', barcode: '6287018581354', weight_g: 1000, images: [], description: 'Second' },
])
writeFileSync(process.argv[3], out)
