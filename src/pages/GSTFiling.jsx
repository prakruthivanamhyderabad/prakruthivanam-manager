import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { Loading, Modal, FormGroup, FormRow } from '../components/ui'
import { fmt, fmtDate, thisMonth } from '../lib/utils'
import * as XLSX from 'xlsx'

const GSTIN = '36AOVPM0045C1Z1'
const KNOWN_SUPPLIERS = ['Adavi Sampada', 'Arogya Rahasya', 'Cast Iron', 'Dathu Naturals', 'IM Corporation', 'GCC', 'GoDesi', 'Herbal Strategi', 'Prakruthivanam', 'Pure & Sure', 'Surabhi', 'Timbaktu']

function parseGSTR1(wb) {
  // Parse Vyapar GSTR-1 xlsx export
  // Strategy: try GST Workings sheet first (most reliable), then b2cs + exemp sheets
  let sales0 = 0, sales5 = 0, sales12 = 0, sales18 = 0
  let outIgst = 0, outCgst = 0, outSgst = 0, outTotal = 0

  // Try GST Workings sheet - has clean summary rows
  const workSheet = wb.SheetNames.find(s => s.toLowerCase().includes('working'))
  if (workSheet) {
    const ws = wb.Sheets[workSheet]
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
    // Row structure in GST Workings:
    // [InvoiceValue, Rate, TaxableValue, IGST, CGST, SGST]
    // Rate is 0, 0.05, 0.12, 0.18
    for (const row of data) {
      if (!row || row.length < 4) continue
      const rate = parseFloat(String(row[1] || ''))
      const taxable = parseFloat(String(row[2] || '').replace(/,/g, ''))
      const igst = parseFloat(String(row[3] || '').replace(/,/g, '')) || 0
      const cgst = parseFloat(String(row[4] || '').replace(/,/g, '')) || 0
      const sgst = parseFloat(String(row[5] || '').replace(/,/g, '')) || 0
      if (isNaN(rate) || isNaN(taxable) || taxable <= 0) continue
      if (rate === 0) { sales0 += taxable }
      else if (rate === 0.05 || rate === 5) { sales5 += taxable; outIgst += igst; outCgst += cgst; outSgst += sgst }
      else if (rate === 0.12 || rate === 12) { sales12 += taxable; outIgst += igst; outCgst += cgst; outSgst += sgst }
      else if (rate === 0.18 || rate === 18) { sales18 += taxable; outIgst += igst; outCgst += cgst; outSgst += sgst }
      // Get GST Payable line
      const line = String(row[0] || '').toLowerCase()
      if (line.includes('gst payable')) {
        const v = parseFloat(String(row[1] || '').replace(/,/g, ''))
        if (!isNaN(v) && v > 0) outTotal = v
      }
    }
  }

  // Fallback: use b2cs sheet for taxable values
  if (sales5 === 0 && sales18 === 0) {
    const b2csSheet = wb.Sheets['b2cs']
    if (b2csSheet) {
      const data = XLSX.utils.sheet_to_json(b2csSheet, { header: 1, defval: null })
      for (const row of data) {
        if (!row || row.length < 5) continue
        const rate = parseFloat(String(row[3] || ''))
        const taxable = parseFloat(String(row[4] || '').replace(/,/g, ''))
        if (isNaN(rate) || isNaN(taxable) || taxable <= 0) continue
        if (rate === 5) sales5 += taxable
        else if (rate === 12) sales12 += taxable
        else if (rate === 18) sales18 += taxable
      }
    }
    // Nil rated from exemp sheet
    const exSheet = wb.Sheets['exemp']
    if (exSheet) {
      const data = XLSX.utils.sheet_to_json(exSheet, { header: 1, defval: null })
      for (const row of data) {
        const v = parseFloat(String(row[1] || '').replace(/,/g, ''))
        if (!isNaN(v) && v > 0 && !String(row[0]||'').toLowerCase().includes('desc')) sales0 += v
      }
    }
  }

  // Calculate outTotal from rates if not found in workings
  if (outTotal === 0) {
    outTotal = outIgst + outCgst + outSgst
  }
  if (outTotal === 0) {
    outTotal = sales5 * 0.05 + sales12 * 0.12 + sales18 * 0.18
  }

  return { sales0, sales5, sales12, sales18, outIgst, outCgst, outSgst, outTotal }
}

function parseGSTR2B(data) {
  // Parse portal GSTR-2B xlsx
  let totalIgst = 0, totalCgst = 0, totalSgst = 0
  const supplierMap = {}

  for (const row of data) {
    if (!row || row.length < 8) continue
    const gstin = String(row[0] || '').trim()
    const name = String(row[1] || '').trim()
    if (gstin.length !== 15) continue
    const igst = parseFloat(String(row[9] || '').replace(/,/g, '')) || 0
    const cgst = parseFloat(String(row[10] || '').replace(/,/g, '')) || 0
    const sgst = parseFloat(String(row[11] || '').replace(/,/g, '')) || 0
    if (igst + cgst + sgst === 0) continue
    if (!supplierMap[gstin]) supplierMap[gstin] = { name, gstin, igst: 0, cgst: 0, sgst: 0 }
    supplierMap[gstin].igst += igst
    supplierMap[gstin].cgst += cgst
    supplierMap[gstin].sgst += sgst
    totalIgst += igst; totalCgst += cgst; totalSgst += sgst
  }

  return { totalIgst, totalCgst, totalSgst, totalItc: totalIgst + totalCgst + totalSgst, suppliers: Object.values(supplierMap) }
}

export default function GSTFiling({ user, toast, setSyncStatus }) {
  const [month, setMonth] = useState(thisMonth())
  const [gstMonth, setGstMonth] = useState(null)
  const [supplierItc, setSupplierItc] = useState([])
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState('')
  const [editModal, setEditModal] = useState(false)
  const [editForm, setEditForm] = useState({})
  const gstr1Ref = useRef()
  const gstr2bRef = useRef()

  useEffect(() => { fetchData() }, [month])

  async function fetchData() {
    setLoading(true)
    const [{ data: gm }, { data: sitc }, { data: hist }] = await Promise.all([
      supabase.from('gst_months').select('*').eq('month', month).maybeSingle(),
      supabase.from('supplier_itc').select('*').eq('month', month).order('expected_itc', { ascending: false }),
      supabase.from('gst_months').select('*').order('month', { ascending: false }).limit(12)
    ])
    setGstMonth(gm)
    setSupplierItc(sitc || [])
    setHistory(hist || [])

    // If no gst_month record yet, create a draft from Payments tab data
    if (!gm) {
      await autoPopulateFromPayments()
    }
    setLoading(false)
  }

  async function autoPopulateFromPayments() {
    // Get ITC from payments this month
    const { data: pays } = await supabase.from('payments').select('supplier, total_itc, igst_amount, cgst_amount, sgst_amount, taxable_value').gte('date', month + '-01').lte('date', month + '-31')
    if (!pays || !pays.length) return

    // Build supplier ITC expectations
    const supMap = {}
    pays.forEach(p => {
      if (!supMap[p.supplier]) supMap[p.supplier] = { expected: 0 }
      supMap[p.supplier].expected += (p.total_itc || 0)
    })

    // Upsert supplier_itc records
    const rows = Object.entries(supMap).map(([name, d]) => ({
      month, supplier_name: name, expected_itc: d.expected,
      actual_total: 0, gap: d.expected, filed: false
    }))

    for (const row of rows) {
      await supabase.from('supplier_itc').upsert(row, { onConflict: 'month,supplier_name' })
    }

    // Get carried forward from previous month
    const prevMonth = month.slice(0, 4) + '-' + String(parseInt(month.slice(5)) - 1).padStart(2, '0')
    const { data: prev } = await supabase.from('gst_months').select('carried_forward').eq('month', prevMonth).maybeSingle()
    const cf = prev?.carried_forward || 0

    await supabase.from('gst_months').upsert({ month, gstin: GSTIN, itc_opening: cf, updated_at: new Date().toISOString() }, { onConflict: 'month' })
    fetchData()
  }

  async function handleGSTR1Upload(e) {
    const file = e.target.files[0]; if (!file) return
    setUploading('gstr1')
    setSyncStatus({ state: 'syncing', msg: 'Parsing GSTR-1...' })
    try {
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array' })
      const parsed = parseGSTR1(wb)

      await supabase.from('gst_months').upsert({
        month, gstin: GSTIN,
        sales_0: parsed.sales0, sales_5: parsed.sales5,
        sales_12: parsed.sales12, sales_18: parsed.sales18,
        output_igst: parsed.outIgst, output_cgst: parsed.outCgst,
        output_sgst: parsed.outSgst, output_total: parsed.outTotal,
        gstr1_data: { parsed },
        updated_at: new Date().toISOString()
      }, { onConflict: 'month' })

      setSyncStatus({ state: 'ok', msg: 'GSTR-1 parsed ✓' })
      toast('GSTR-1 uploaded and parsed ✓', 'success')
      fetchData()
    } catch (err) {
      toast('Parse error: ' + err.message, 'error')
      setSyncStatus({ state: 'error', msg: 'Parse failed' })
    }
    setUploading('')
    e.target.value = ''
  }

  async function handleGSTR2BUpload(e) {
    const file = e.target.files[0]; if (!file) return
    setUploading('gstr2b')
    setSyncStatus({ state: 'syncing', msg: 'Parsing GSTR-2B...' })
    try {
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
      const ws = wb.Sheets['B2B'] || wb.Sheets[wb.SheetNames[0]]
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
      const parsed = parseGSTR2B(data)

      // Update gst_months
      const cur = gstMonth || {}
      const opening = cur.itc_opening || 0
      const itcTotal = parsed.totalItc
      const outputTotal = cur.output_total || 0
      const netPayable = Math.max(0, outputTotal - opening - itcTotal)
      const carriedFwd = Math.max(0, opening + itcTotal - outputTotal)

      await supabase.from('gst_months').upsert({
        month, gstin: GSTIN,
        itc_igst: parsed.totalIgst, itc_cgst: parsed.totalCgst,
        itc_sgst: parsed.totalSgst, itc_total: itcTotal,
        net_payable: netPayable, carried_forward: carriedFwd,
        gstr2b_data: { suppliers: parsed.suppliers },
        updated_at: new Date().toISOString()
      }, { onConflict: 'month' })

      // Update supplier_itc with actuals
      for (const sup of parsed.suppliers) {
        const actualTotal = sup.igst + sup.cgst + sup.sgst
        const existing = supplierItc.find(s => s.supplier_gstin === sup.gstin || s.supplier_name.toLowerCase().includes(sup.name.toLowerCase().slice(0, 8)))
        const expected = existing?.expected_itc || 0
        await supabase.from('supplier_itc').upsert({
          month, supplier_name: sup.name, supplier_gstin: sup.gstin,
          actual_igst: sup.igst, actual_cgst: sup.cgst, actual_sgst: sup.sgst,
          actual_total: actualTotal, gap: Math.max(0, expected - actualTotal), filed: true,
          expected_itc: expected
        }, { onConflict: 'month,supplier_name' })
      }

      // Mark suppliers not in GSTR-2B as not filed
      const filedGstins = parsed.suppliers.map(s => s.gstin)
      for (const sit of supplierItc) {
        if (!sit.supplier_gstin || !filedGstins.includes(sit.supplier_gstin)) {
          await supabase.from('supplier_itc').update({ filed: false, actual_total: 0, gap: sit.expected_itc }).eq('id', sit.id)
        }
      }

      setSyncStatus({ state: 'ok', msg: 'GSTR-2B parsed ✓' })
      toast(`GSTR-2B uploaded — ${parsed.suppliers.length} suppliers, ITC: ${fmt(itcTotal)}`, 'success')
      fetchData()
    } catch (err) {
      toast('Parse error: ' + err.message, 'error')
      setSyncStatus({ state: 'error', msg: 'Parse failed' })
    }
    setUploading('')
    e.target.value = ''
  }

  async function updateChecklist(field, value) {
    await supabase.from('gst_months').upsert({ month, gstin: GSTIN, [field]: value, updated_at: new Date().toISOString() }, { onConflict: 'month' })
    fetchData()
  }

  async function saveEdit() {
    await supabase.from('gst_months').upsert({
      month, gstin: GSTIN,
      itc_opening: parseFloat(editForm.itc_opening) || 0,
      amount_paid: parseFloat(editForm.amount_paid) || 0,
      payment_date: editForm.payment_date || null,
      payment_ref: editForm.payment_ref || '',
      gstr1_late_fee: parseFloat(editForm.gstr1_late_fee) || 0,
      notes: editForm.notes || '',
      updated_at: new Date().toISOString()
    }, { onConflict: 'month' })
    setEditModal(false)
    fetchData()
    toast('Saved ✓', 'success')
  }

  function generatePDF() {
    if (!gstMonth) { toast('No data for this month yet.', 'error'); return }
    const gm = gstMonth
    const pendingItc = supplierItc.filter(s => !s.filed).reduce((sum, s) => sum + (s.expected_itc || 0), 0)
    const notFiled = supplierItc.filter(s => !s.filed).length

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>GST Summary ${month}</title>
    <style>
      body { font-family: Arial, sans-serif; font-size: 13px; color: #2c1810; padding: 30px; max-width: 800px; margin: 0 auto; }
      h1 { font-size: 20px; color: #2c1810; border-bottom: 2px solid #f5c842; padding-bottom: 8px; }
      h2 { font-size: 14px; color: #6b4d28; text-transform: uppercase; letter-spacing: .5px; margin-top: 20px; margin-bottom: 8px; border-bottom: 1px solid #e8d5b8; padding-bottom: 4px; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
      td, th { padding: 7px 10px; text-align: left; border-bottom: 1px solid #f0ebe0; }
      th { background: #fff8e8; font-weight: 600; font-size: 11px; text-transform: uppercase; }
      .right { text-align: right; }
      .total { font-weight: 700; background: #fff8e8; }
      .green { color: #2d7a4f; font-weight: 700; }
      .red { color: #c0392b; font-weight: 700; }
      .amber { color: #d4860a; font-weight: 700; }
      .header { display: flex; justify-content: space-between; margin-bottom: 20px; }
      .filed { color: #2d7a4f; } .notfiled { color: #c0392b; }
      @media print { body { padding: 10px; } }
    </style></head><body>
    <div class="header">
      <div><h1>🌿 Prakruthivanam — GST Summary</h1>
      <div style="font-size:12px;color:#9a7a5a">GSTIN: ${GSTIN} &nbsp;|&nbsp; Period: ${month} &nbsp;|&nbsp; Generated: ${new Date().toLocaleDateString('en-IN')}</div></div>
    </div>

    <h2>Sales Summary (Output Tax)</h2>
    <table><tr><th>GST Rate</th><th class="right">Taxable Value</th><th class="right">GST Amount</th></tr>
    <tr><td>0% (Nil Rated)</td><td class="right">${fmt(gm.sales_0||0)}</td><td class="right">—</td></tr>
    <tr><td>5%</td><td class="right">${fmt(gm.sales_5||0)}</td><td class="right">${fmt((gm.sales_5||0)*0.05)}</td></tr>
    <tr><td>12%</td><td class="right">${fmt(gm.sales_12||0)}</td><td class="right">${fmt((gm.sales_12||0)*0.12)}</td></tr>
    <tr><td>18%</td><td class="right">${fmt(gm.sales_18||0)}</td><td class="right">${fmt((gm.sales_18||0)*0.18)}</td></tr>
    <tr class="total"><td>Total Output GST</td><td class="right">${fmt((gm.sales_0||0)+(gm.sales_5||0)+(gm.sales_12||0)+(gm.sales_18||0))}</td><td class="right green">${fmt(gm.output_total||0)}</td></tr>
    </table>

    <h2>Input Tax Credit</h2>
    <table><tr><th>Item</th><th class="right">IGST</th><th class="right">CGST</th><th class="right">SGST</th><th class="right">Total</th></tr>
    <tr><td>Opening Credit (carried fwd)</td><td class="right">—</td><td class="right">—</td><td class="right">—</td><td class="right">${fmt(gm.itc_opening||0)}</td></tr>
    <tr><td>${month} ITC (GSTR-2B)</td><td class="right">${fmt(gm.itc_igst||0)}</td><td class="right">${fmt(gm.itc_cgst||0)}</td><td class="right">${fmt(gm.itc_sgst||0)}</td><td class="right">${fmt(gm.itc_total||0)}</td></tr>
    <tr class="total"><td>Total ITC Available</td><td class="right">—</td><td class="right">—</td><td class="right">—</td><td class="right green">${fmt((gm.itc_opening||0)+(gm.itc_total||0))}</td></tr>
    </table>

    <h2>Net GST Position</h2>
    <table>
    <tr><td>Output Tax</td><td class="right">${fmt(gm.output_total||0)}</td></tr>
    <tr><td>Less: Total ITC</td><td class="right">−${fmt((gm.itc_opening||0)+(gm.itc_total||0))}</td></tr>
    <tr class="total"><td>Net Payable</td><td class="right ${(gm.net_payable||0)>0?'red':'green'}">${fmt(gm.net_payable||0)}</td></tr>
    <tr><td>Amount Paid</td><td class="right">${fmt(gm.amount_paid||0)}</td></tr>
    <tr><td>Carried Forward to Next Month</td><td class="right green">${fmt(gm.carried_forward||0)}</td></tr>
    </table>

    <h2>Supplier ITC Status</h2>
    <table><tr><th>Supplier</th><th class="right">Expected ITC</th><th class="right">Actual ITC</th><th class="right">Gap</th><th>Status</th></tr>
    ${supplierItc.map(s => `<tr><td>${s.supplier_name}</td><td class="right">${fmt(s.expected_itc||0)}</td><td class="right">${fmt(s.actual_total||0)}</td><td class="right ${(s.gap||0)>0?'red':''}">${fmt(s.gap||0)}</td><td class="${s.filed?'filed':'notfiled'}">${s.filed?'✓ Filed':'⚠ Not filed'}</td></tr>`).join('')}
    <tr class="total"><td colspan="2">Pending ITC (${notFiled} suppliers not filed)</td><td colspan="3" class="right amber">~${fmt(pendingItc)}</td></tr>
    </table>

    <h2>Filing Status</h2>
    <table>
    <tr><td>GSTR-1</td><td>${gm.gstr1_filed?`✓ Filed on ${fmtDate(gm.gstr1_filed_date)}`:'⚠️ Not filed'}${gm.gstr1_late_fee>0?` (Late fee: ${fmt(gm.gstr1_late_fee)})`  :''}</td></tr>
    <tr><td>GSTR-3B</td><td>${gm.gstr3b_filed?`✓ Filed on ${fmtDate(gm.gstr3b_filed_date)}`:'⏳ Pending'}</td></tr>
    <tr><td>Payment</td><td>${gm.amount_paid>0?`${fmt(gm.amount_paid)} paid on ${fmtDate(gm.payment_date)} (Ref: ${gm.payment_ref||'—'})`:'⏳ Pending'}</td></tr>
    </table>
    ${gm.notes?`<p style="margin-top:16px;padding:10px;background:#fff8e8;border-radius:6px;font-size:12px"><strong>Notes:</strong> ${gm.notes}</p>`:''}
    <p style="margin-top:24px;font-size:10px;color:#9a7a5a;text-align:center">Generated by Prakruthivanam DailyOps · ${new Date().toLocaleString('en-IN')}</p>
    </body></html>`

    const w = window.open('', '_blank')
    w.document.write(html)
    w.document.close()
    setTimeout(() => w.print(), 500)
  }

  const gm = gstMonth
  const totalItcAvailable = (gm?.itc_opening || 0) + (gm?.itc_total || 0)
  const notFiledSuppliers = supplierItc.filter(s => !s.filed)
  const pendingITC = notFiledSuppliers.reduce((s, sup) => s + (sup.expected_itc || 0), 0)
  const lateFee = gm?.gstr1_late_fee || 0

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h2 className="section-title">🧾 GST Filing</h2>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="month" value={month} onChange={e => setMonth(e.target.value)}
            style={{ padding: '7px 10px', border: '1.5px solid var(--cream-dark)', borderRadius: 8, fontFamily: 'inherit', fontSize: 13, background: 'var(--white)', outline: 'none' }} />
          <button className="btn btn-secondary btn-sm" onClick={() => { setEditForm({ itc_opening: gm?.itc_opening || '', amount_paid: gm?.amount_paid || '', payment_date: gm?.payment_date || '', payment_ref: gm?.payment_ref || '', gstr1_late_fee: gm?.gstr1_late_fee || '', notes: gm?.notes || '' }); setEditModal(true) }}>✏️ Edit Details</button>
          <button className="btn btn-primary btn-sm" onClick={generatePDF}>🖨 Print Report</button>
        </div>
      </div>

      {/* GSTIN badge */}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'var(--cream-warm)', border: '1px solid var(--gold)', borderRadius: 'var(--rs)', padding: '6px 14px', marginBottom: 18, fontSize: 12 }}>
        <span style={{ color: 'var(--muted)' }}>GSTIN:</span>
        <code style={{ fontWeight: 700, color: 'var(--brown-dark)', fontSize: 13 }}>{GSTIN}</code>
        <span style={{ color: 'var(--muted)' }}>· Prakruthivanam Hyderabad</span>
      </div>

      {loading ? <Loading /> : (
        <>
          {/* Upload section */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
            <div className="card" style={{ padding: '16px 18px' }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--brown-dark)', marginBottom: 4 }}>📊 GSTR-1 (Sales Data)</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>Export from Vyapar → Reports → GST Reports → GSTR-1 → Export Excel</div>
              {gm?.output_total > 0 && (
                <div style={{ background: 'var(--green-l)', borderRadius: 6, padding: '6px 10px', marginBottom: 10, fontSize: 12, color: 'var(--green)', fontWeight: 600 }}>
                  ✓ Parsed — Output GST: {fmt(gm.output_total)}
                </div>
              )}
              <label className="btn btn-primary btn-sm" style={{ cursor: 'pointer', display: 'inline-flex' }}>
                {uploading === 'gstr1' ? '⏳ Parsing...' : '⬆ Upload GSTR-1 Excel'}
                <input ref={gstr1Ref} type="file" accept=".xlsx,.xls" onChange={handleGSTR1Upload} style={{ display: 'none' }} disabled={uploading === 'gstr1'} />
              </label>
            </div>
            <div className="card" style={{ padding: '16px 18px' }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--brown-dark)', marginBottom: 4 }}>🏦 GSTR-2B (ITC from Suppliers)</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>Download from GST Portal → Returns → GSTR-2B → Download Excel</div>
              {gm?.itc_total > 0 && (
                <div style={{ background: 'var(--green-l)', borderRadius: 6, padding: '6px 10px', marginBottom: 10, fontSize: 12, color: 'var(--green)', fontWeight: 600 }}>
                  ✓ Parsed — ITC this month: {fmt(gm.itc_total)}
                </div>
              )}
              <label className="btn btn-primary btn-sm" style={{ cursor: 'pointer', display: 'inline-flex' }}>
                {uploading === 'gstr2b' ? '⏳ Parsing...' : '⬆ Upload GSTR-2B Excel'}
                <input ref={gstr2bRef} type="file" accept=".xlsx,.xls" onChange={handleGSTR2BUpload} style={{ display: 'none' }} disabled={uploading === 'gstr2b'} />
              </label>
            </div>
          </div>

          {/* Summary cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px,1fr))', gap: 12, marginBottom: 20 }}>
            <SumCard label="Output GST" value={fmt(gm?.output_total || 0)} color="var(--red)" />
            <SumCard label="ITC Opening" value={fmt(gm?.itc_opening || 0)} color="var(--green)" />
            <SumCard label="ITC This Month" value={fmt(gm?.itc_total || 0)} color="var(--green)" />
            <SumCard label="Total ITC" value={fmt(totalItcAvailable)} color="var(--green)" bold />
            <SumCard label="Net Payable" value={fmt(gm?.net_payable || 0)} color={(gm?.net_payable || 0) > 0 ? 'var(--red)' : 'var(--green)'} bold />
            <SumCard label="Carried Forward" value={fmt(gm?.carried_forward || 0)} color="var(--blue)" />
          </div>

          {/* Sales breakdown */}
          {gm?.output_total > 0 && (
            <div className="card" style={{ marginBottom: 20, overflow: 'hidden' }}>
              <div style={{ padding: '10px 16px', background: 'var(--brown-dark)', color: 'var(--gold)', fontWeight: 700, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.5px' }}>Sales Breakdown — {month}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 0 }}>
                {[['0% Nil', gm.sales_0, 0], ['5%', gm.sales_5, 0.05], ['12%', gm.sales_12, 0.12], ['18%', gm.sales_18, 0.18]].map(([label, taxable, rate]) => (
                  <div key={label} style={{ padding: '12px 16px', borderRight: '1px solid var(--cream)', textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
                    <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 18, fontWeight: 700, color: 'var(--brown-dark)' }}>{fmt(taxable || 0)}</div>
                    <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 2 }}>GST: {fmt((taxable || 0) * rate)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Supplier ITC tracker */}
          <div className="card" style={{ marginBottom: 20, overflow: 'hidden' }}>
            <div style={{ padding: '10px 16px', background: 'var(--brown-dark)', color: 'var(--gold)', fontWeight: 700, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.5px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Supplier ITC Tracker</span>
              {notFiledSuppliers.length > 0 && <span style={{ background: 'var(--red)', color: 'white', padding: '2px 10px', borderRadius: 10, fontSize: 11 }}>⚠️ {notFiledSuppliers.length} not filed — ~{fmt(pendingITC)} pending</span>}
            </div>
            {supplierItc.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                Add supplier invoices in the Payments tab to see expected ITC, then upload GSTR-2B to see actuals.
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Supplier</th><th>GSTIN</th><th>Expected ITC</th><th>Actual ITC</th><th>Gap</th><th>Status</th></tr></thead>
                  <tbody>
                    {supplierItc.map(s => (
                      <tr key={s.id}>
                        <td><strong>{s.supplier_name}</strong></td>
                        <td><code style={{ fontSize: 11, color: 'var(--muted)' }}>{s.supplier_gstin || '—'}</code></td>
                        <td style={{ fontWeight: 600 }}>{fmt(s.expected_itc || 0)}</td>
                        <td style={{ color: s.filed ? 'var(--green)' : 'var(--muted)', fontWeight: s.filed ? 600 : 400 }}>{fmt(s.actual_total || 0)}</td>
                        <td style={{ color: (s.gap || 0) > 0 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>{(s.gap || 0) > 0 ? fmt(s.gap) : '—'}</td>
                        <td>{s.filed ? <span className="pill pill-approved">✓ Filed</span> : <span className="pill pill-pending">⚠ Not filed</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Filing checklist */}
          <div className="card" style={{ padding: '16px 18px', marginBottom: 20 }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--brown-dark)', marginBottom: 14 }}>📋 Filing Checklist — {month}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { key: null, label: 'Download GSTR-1 from Vyapar and upload above', done: (gm?.output_total || 0) > 0 },
                { key: 'gstr1_filed', label: 'File GSTR-1 on GST Portal (due 11th)', done: gm?.gstr1_filed, date: gm?.gstr1_filed_date },
                { key: null, label: 'Download GSTR-2B from portal and upload above', done: (gm?.itc_total || 0) > 0 },
                { key: null, label: 'Review supplier ITC gaps and follow up', done: notFiledSuppliers.length === 0 },
                { key: 'gstr3b_filed', label: 'File GSTR-3B on GST Portal (due 20th)', done: gm?.gstr3b_filed, date: gm?.gstr3b_filed_date },
                { key: null, label: `Pay GST ${gm?.net_payable > 0 ? fmt(gm.net_payable) : '(calculating...)'}`, done: (gm?.amount_paid || 0) >= (gm?.net_payable || 1) },
              ].map((item, idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px', background: item.done ? 'var(--green-l)' : 'var(--cream)', borderRadius: 8 }}>
                  {item.key ? (
                    <input type="checkbox" checked={item.done || false} onChange={e => updateChecklist(item.key, e.target.checked)}
                      style={{ width: 16, height: 16, accentColor: 'var(--green)', cursor: 'pointer' }} />
                  ) : (
                    <div style={{ width: 16, height: 16, borderRadius: '50%', background: item.done ? 'var(--green)' : 'var(--cream-dark)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {item.done && <span style={{ color: 'white', fontSize: 10 }}>✓</span>}
                    </div>
                  )}
                  <span style={{ fontSize: 13, color: item.done ? 'var(--green)' : 'var(--text)', fontWeight: item.done ? 500 : 400, textDecoration: item.done ? 'line-through' : 'none', flex: 1 }}>{item.label}</span>
                  {item.date && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{fmtDate(item.date)}</span>}
                  {idx === 1 && lateFee > 0 && <span style={{ fontSize: 11, background: 'var(--red-l)', color: 'var(--red)', padding: '2px 8px', borderRadius: 10, fontWeight: 700 }}>Late fee: {fmt(lateFee)}</span>}
                </div>
              ))}
            </div>
          </div>

          {/* Payment history */}
          <div className="card" style={{ overflow: 'hidden' }}>
            <div style={{ padding: '10px 16px', background: 'var(--brown-dark)', color: 'var(--gold)', fontWeight: 700, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.5px' }}>📅 Monthly History</div>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Month</th><th>Output GST</th><th>ITC</th><th>Net Payable</th><th>Paid</th><th>Carried Fwd</th><th>GSTR-1</th><th>GSTR-3B</th></tr></thead>
                <tbody>
                  {history.length === 0 ? <tr><td colSpan={8} style={{ textAlign: 'center', padding: 28, color: 'var(--muted)' }}>No history yet.</td></tr>
                    : history.map(h => (
                      <tr key={h.id} style={{ background: h.month === month ? 'var(--cream-warm)' : 'inherit' }}>
                        <td><strong>{h.month}</strong></td>
                        <td>{fmt(h.output_total || 0)}</td>
                        <td style={{ color: 'var(--green)' }}>{fmt((h.itc_opening || 0) + (h.itc_total || 0))}</td>
                        <td style={{ fontWeight: 700, color: (h.net_payable || 0) > 0 ? 'var(--red)' : 'var(--green)' }}>{fmt(h.net_payable || 0)}</td>
                        <td>{fmt(h.amount_paid || 0)}</td>
                        <td style={{ color: 'var(--blue)' }}>{fmt(h.carried_forward || 0)}</td>
                        <td>{h.gstr1_filed ? <span className="pill pill-approved">✓ Filed</span> : <span className="pill pill-pending">Pending</span>}</td>
                        <td>{h.gstr3b_filed ? <span className="pill pill-approved">✓ Filed</span> : <span className="pill pill-open">Pending</span>}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Edit modal */}
      <Modal open={editModal} onClose={() => setEditModal(false)} title="✏️ Edit GST Details">
        <FormGroup label="Opening ITC / Carried Forward (₹)">
          <input className="form-input no-spinner" type="number" value={editForm.itc_opening} onChange={e => setEditForm(p => ({ ...p, itc_opening: e.target.value }))} onWheel={e => e.target.blur()} />
        </FormGroup>
        <FormRow>
          <FormGroup label="Amount Paid (₹)">
            <input className="form-input no-spinner" type="number" value={editForm.amount_paid} onChange={e => setEditForm(p => ({ ...p, amount_paid: e.target.value }))} onWheel={e => e.target.blur()} />
          </FormGroup>
          <FormGroup label="Payment Date">
            <input className="form-input" type="date" value={editForm.payment_date} onChange={e => setEditForm(p => ({ ...p, payment_date: e.target.value }))} />
          </FormGroup>
        </FormRow>
        <FormRow>
          <FormGroup label="Payment Reference">
            <input className="form-input" value={editForm.payment_ref} onChange={e => setEditForm(p => ({ ...p, payment_ref: e.target.value }))} placeholder="Challan / UTR number" />
          </FormGroup>
          <FormGroup label="GSTR-1 Late Fee (₹)">
            <input className="form-input no-spinner" type="number" value={editForm.gstr1_late_fee} onChange={e => setEditForm(p => ({ ...p, gstr1_late_fee: e.target.value }))} onWheel={e => e.target.blur()} />
          </FormGroup>
        </FormRow>
        <FormGroup label="Notes">
          <textarea className="form-input form-textarea" value={editForm.notes} onChange={e => setEditForm(p => ({ ...p, notes: e.target.value }))} />
        </FormGroup>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setEditModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={saveEdit}>Save</button>
        </div>
      </Modal>
    </div>
  )
}

function SumCard({ label, value, color, bold }) {
  return (
    <div style={{ background: 'var(--white)', borderRadius: 'var(--r)', padding: '14px 16px', boxShadow: 'var(--shadow)', borderLeft: `3px solid ${color}` }}>
      <div style={{ fontFamily: bold ? "'Playfair Display',serif" : 'inherit', fontSize: bold ? 20 : 17, fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</div>
    </div>
  )
}
