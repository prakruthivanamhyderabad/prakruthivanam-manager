import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Modal, FormGroup, FormRow, StatCard, Loading, useConfirm } from '../components/ui'
import { fmt, fmtDate, today } from '../lib/utils'
import * as XLSX from 'xlsx'

export default function StockAudit({ user, toast, setSyncStatus }) {
  const [view, setView] = useState('main')
  const [sessions, setSessions] = useState([])
  const [products, setProducts] = useState([])
  const [currentSession, setCurrentSession] = useState(null)
  const [sessionItems, setSessionItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [newSessModal, setNewSessModal] = useState(false)
  const [sessForm, setSessForm] = useState({ name: '', type: 'full', category_filter: '' })
  const [searchInput, setSearchInput] = useState('')
  const [scanResult, setScanResult] = useState(null)
  const [countEntry, setCountEntry] = useState({ system_qty: '', physical_qty: '', notes: '' })
  const [showAll, setShowAll] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const { confirm, ConfirmDialog } = useConfirm()
  const [productModal, setProductModal] = useState(false)
  const [prodForm, setProdForm] = useState({ name: '', barcode: '', category: '', brand: '', price: '' })
  const [prodEditId, setProdEditId] = useState(null)
  const [prodFilter, setProdFilter] = useState({ search: '', cat: '' })
  // Report
  const [reportModal, setReportModal] = useState(false)
  const [reportRange, setReportRange] = useState({ from: today().slice(0,7) + '-01', to: today() })
  const [generatingReport, setGeneratingReport] = useState(false)

  useEffect(() => { fetchAll() }, [])
  useEffect(() => { if (currentSession) fetchSessionItems() }, [currentSession?.id])

  async function fetchAll() {
    const [{ data: sess }, { data: prods }] = await Promise.all([
      supabase.from('stock_sessions').select('*').order('created_at', { ascending: false }),
      supabase.from('products').select('*').order('name')
    ])
    setSessions(sess || [])
    setProducts(prods || [])
    setLoading(false)
  }

  async function fetchSessionItems() {
    if (!currentSession) return
    const { data } = await supabase.from('stock_items').select('*').eq('session_id', currentSession.id).order('counted_at', { ascending: false })
    setSessionItems(data || [])
  }

  async function startSession() {
    if (!sessForm.name) { toast('Enter session name.', 'error'); return }
    const { data } = await supabase.from('stock_sessions').insert({
      name: sessForm.name, type: sessForm.type,
      category_filter: sessForm.category_filter,
      created_by: user.role === 'manager' ? 'Manager' : 'Staff',
      status: 'open'
    }).select()
    setNewSessModal(false)
    setSessForm({ name: '', type: 'full', category_filter: '' })
    fetchAll()
    openSession(data[0])
    toast('Session started ✓', 'success')
  }

  function openSession(sess) {
    setCurrentSession(sess)
    setView('session')
    setScanResult(null)
    setSearchInput('')
    setCountEntry({ system_qty: '', physical_qty: '', notes: '' })
  }

  async function closeSession() {
    if (!window.confirm('Close this session? Counting data will be saved and you can view the report anytime.')) return
    await supabase.from('stock_sessions').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', currentSession.id)
    setCurrentSession({ ...currentSession, status: 'closed' })
    fetchAll()
    toast('Session closed and saved ✓', 'success')
  }

  async function deleteSession(id) {
    const ok = await confirm('Delete this session and all its data?'); if (!ok) return
    await supabase.from('stock_sessions').delete().eq('id', id)
    fetchAll(); toast('Deleted.')
  }

  function lookup(query) {
    if (!query.trim()) return
    const q = query.trim().toLowerCase()
    const prod = products.find(p => (p.barcode || '').trim().toLowerCase() === q) ||
      products.find(p => p.name.toLowerCase() === q) ||
      products.find(p => p.name.toLowerCase().includes(q))
    if (!prod) { setScanResult({ error: `"${query}" not found in Product Master.` }); return }
    const existing = sessionItems.find(i => i.product_id === prod.id)
    setScanResult({ product: prod, existing })
    setCountEntry({
      system_qty: existing?.system_qty?.toString() || '',
      physical_qty: existing?.physical_qty?.toString() || '',
      notes: existing?.notes || ''
    })
    setSearchInput('')
    setShowSuggestions(false)
  }

  async function saveCount() {
    if (!scanResult?.product) return
    const prod = scanResult.product
    const sysQty = parseFloat(countEntry.system_qty) || 0
    const phyQty = parseFloat(countEntry.physical_qty) || 0
    const variance = phyQty - sysQty
    const varianceValue = variance * (prod.price || 0)
    setSyncStatus({ state: 'syncing', msg: 'Saving count...' })
    const payload = {
      session_id: currentSession.id, product_id: prod.id,
      product_name: prod.name, barcode: prod.barcode || '',
      category: prod.category || '', brand: prod.brand || '',
      price: prod.price || 0, system_qty: sysQty, physical_qty: phyQty,
      variance, variance_value: varianceValue, notes: countEntry.notes,
      counted_by: user.role === 'manager' ? 'Manager' : 'Staff',
      counted_at: new Date().toISOString()
    }
    const existing2 = sessionItems.find(i => i.product_id === prod.id)
    let saveError = null
    if (existing2) {
      const { error } = await supabase.from('stock_items').update(payload).eq('id', existing2.id)
      saveError = error
    } else {
      const { error } = await supabase.from('stock_items').insert(payload)
      saveError = error
    }
    if (saveError) { toast('Save failed: ' + saveError.message, 'error'); setSyncStatus({ state: 'error', msg: 'Failed' }); return }
    setSyncStatus({ state: 'ok', msg: 'Count saved ✓' })
    const varLabel = Math.abs(variance) < 0.001 ? 'Matched' : (variance >= 0 ? '+' : '') + variance.toFixed(2)
    setScanResult({ success: `✓ ${prod.name} — Variance: ${varLabel}` })
    await fetchSessionItems()
  }

  // ── Product Master ──────────────────────────────────
  function openProdNew() { setProdEditId(null); setProdForm({ name: '', barcode: '', category: '', brand: '', price: '' }); setProductModal(true) }
  function openProdEdit(p) { setProdEditId(p.id); setProdForm({ name: p.name, barcode: p.barcode || '', category: p.category || '', brand: p.brand || '', price: p.price || '' }); setProductModal(true) }

  async function saveProd() {
    if (!prodForm.name) { toast('Product name required.', 'error'); return }
    const payload = { name: prodForm.name, barcode: prodForm.barcode, category: prodForm.category, brand: prodForm.brand, price: parseFloat(prodForm.price) || 0, updated_at: new Date().toISOString() }
    if (prodEditId) {
      await supabase.from('products').update(payload).eq('id', prodEditId)
    } else {
      await supabase.from('products').insert(payload)
    }
    setProductModal(false); fetchAll(); toast('Product saved ✓', 'success')
  }

  async function delProd(id) {
    const ok = await confirm('Delete this product?'); if (!ok) return
    await supabase.from('products').delete().eq('id', id)
    fetchAll(); toast('Deleted.')
  }

  // ── CSV Upload with deduplication ──────────────────
  async function handleCSV(e) {
    const file = e.target.files[0]; if (!file) return
    setSyncStatus({ state: 'syncing', msg: 'Parsing file...' })

    try {
      let rows = []

      // Check if xlsx or csv
      if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
        const buffer = await file.arrayBuffer()
        const wb = XLSX.read(buffer, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
        // Vyapar export format:
        // Col 0: Item name, Col 1: Item code/barcode, Col 3: Category, Col 6: Brand, Col 7: MRP
        const headerRow = data[0] || []
        const nameI = headerRow.findIndex(h => String(h||'').toLowerCase().includes('item name'))
        const codeI = headerRow.findIndex(h => String(h||'').toLowerCase().includes('item code'))
        const catI = headerRow.findIndex(h => String(h||'').toLowerCase().includes('category'))
        const brandI = headerRow.findIndex(h => String(h||'').toLowerCase().includes('brand'))
        const priceI = headerRow.findIndex(h => String(h||'').toLowerCase().includes('mrp') || String(h||'').toLowerCase().includes('sale price'))

        const nI = nameI >= 0 ? nameI : 0
        const bI = codeI >= 0 ? codeI : 1
        const cI = catI >= 0 ? catI : 3
        const brI = brandI >= 0 ? brandI : 6
        const pI = priceI >= 0 ? priceI : 7

        for (let i = 1; i < data.length; i++) {
          const row = data[i]
          const name = String(row[nI] || '').trim()
          if (!name) continue
          rows.push({
            name,
            barcode: String(row[bI] || '').trim(),
            category: String(row[cI] || '').trim(),
            brand: String(row[brI] || '').trim(),
            price: parseFloat(String(row[pI] || '').replace(/,/g,'')) || 0,
            system_stock: parseFloat(String(row[13] || '').replace(/,/g,'')) || null
          })
        }
      } else {
        // CSV fallback
        const text = await file.text()
        const lines = text.split('\n').filter(l => l.trim())
        if (lines.length < 2) { toast('File must have header + data rows.', 'error'); return }
        const hdr = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g,''))
        const nameI = hdr.findIndex(h => h.includes('name') || h.includes('item'))
        const bcI = hdr.findIndex(h => h.includes('barcode') || h.includes('code') || h.includes('ean'))
        const catI = hdr.findIndex(h => h.includes('cat'))
        const brandI = hdr.findIndex(h => h.includes('brand'))
        const priceI = hdr.findIndex(h => h.includes('mrp') || h.includes('price'))
        if (nameI < 0) { toast('Cannot find Item Name column.', 'error'); return }
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(',').map(c => c.trim().replace(/^["']|["']$/g,''))
          const name = cols[nameI]; if (!name) continue
          rows.push({
            name, barcode: bcI >= 0 ? cols[bcI] : '',
            category: catI >= 0 ? cols[catI] : '',
            brand: brandI >= 0 ? cols[brandI] : '',
            price: priceI >= 0 ? parseFloat(cols[priceI]) || 0 : 0,
            system_stock: null
          })
        }
      }

      if (!rows.length) { toast('No products found in file.', 'error'); return }

      // ── Deduplication logic ──
      // Build lookup maps from existing products
      const existingByBarcode = {}
      const existingByName = {}
      products.forEach(p => {
        if (p.barcode) existingByBarcode[p.barcode.toLowerCase()] = p
        existingByName[p.name.toLowerCase()] = p
      })

      let toInsert = [], toUpdate = [], skipped = 0
      for (const row of rows) {
        const bcKey = row.barcode?.toLowerCase()
        const nameKey = row.name.toLowerCase()
        // Match by barcode first, then by name
        const existing = (bcKey && existingByBarcode[bcKey]) || existingByName[nameKey]
        if (existing) {
          // Update existing record
          toUpdate.push({ id: existing.id, ...row, updated_at: new Date().toISOString() })
        } else {
          toInsert.push({ ...row, updated_at: new Date().toISOString() })
        }
      }

      // Execute updates in batches
      let updateErrors = 0
      for (const p of toUpdate) {
        const { error } = await supabase.from('products').update({
          name: p.name, barcode: p.barcode, category: p.category,
          brand: p.brand, price: p.price,
          system_stock: p.system_stock, updated_at: p.updated_at
        }).eq('id', p.id)
        if (error) updateErrors++
      }

      // Execute inserts
      let insertErrors = 0
      if (toInsert.length) {
        const { error } = await supabase.from('products').insert(toInsert.map(p => ({
          name: p.name, barcode: p.barcode, category: p.category,
          brand: p.brand, price: p.price,
          system_stock: p.system_stock, updated_at: p.updated_at
        })))
        if (error) insertErrors = toInsert.length
      }

      setSyncStatus({ state: 'ok', msg: 'Upload complete ✓' })
      fetchAll()
      toast(`✓ ${toInsert.length - insertErrors} new · ${toUpdate.length - updateErrors} updated · ${skipped} skipped`, 'success')
    } catch (err) {
      toast('Upload failed: ' + err.message, 'error')
      setSyncStatus({ state: 'error', msg: 'Failed' })
    }
    e.target.value = ''
  }

  // ── Consolidated Excel Report ──────────────────────
  async function generateReport() {
    if (!reportRange.from || !reportRange.to) { toast('Select date range.', 'error'); return }
    setGeneratingReport(true)
    setSyncStatus({ state: 'syncing', msg: 'Generating report...' })

    try {
      // Fetch all sessions in range
      const { data: sessionsInRange } = await supabase.from('stock_sessions')
        .select('*')
        .gte('created_at', reportRange.from + 'T00:00:00')
        .lte('created_at', reportRange.to + 'T23:59:59')
        .order('created_at', { ascending: true })

      if (!sessionsInRange?.length) { toast('No sessions found in this date range.', 'error'); setGeneratingReport(false); return }

      // Fetch all items for these sessions
      const sessionIds = sessionsInRange.map(s => s.id)
      const { data: allItems } = await supabase.from('stock_items')
        .select('*')
        .in('session_id', sessionIds)
        .order('product_name', { ascending: true })

      // ── Sheet 1: Summary ──
      const totalProducts = [...new Set(allItems.map(i => i.product_name))].length
      const varItems = allItems.filter(i => Math.abs(i.variance || 0) > 0.001)
      const totalVarValue = allItems.reduce((s, i) => s + Math.abs(i.variance_value || 0), 0)
      const shortItems = allItems.filter(i => (i.variance || 0) < -0.001)
      const excessItems = allItems.filter(i => (i.variance || 0) > 0.001)

      const summaryData = [
        ['PRAKRUTHIVANAM — STOCK AUDIT REPORT'],
        [''],
        ['Date Range', `${reportRange.from} to ${reportRange.to}`],
        ['Generated On', new Date().toLocaleString('en-IN')],
        [''],
        ['SUMMARY'],
        ['Sessions Included', sessionsInRange.length],
        ['Total Entries', allItems.length],
        ['Unique Products Counted', totalProducts],
        ['Products with Variance', varItems.length],
        ['Short Items', shortItems.length],
        ['Excess Items', excessItems.length],
        ['Total Variance Value (₹)', totalVarValue.toFixed(2)],
      ]

      // ── Sheet 2: By Product with trend ──
      // Group all items by product name, sorted by product then date
      const byProduct = {}
      allItems.forEach(item => {
        const key = item.product_name
        if (!byProduct[key]) byProduct[key] = []
        byProduct[key].push(item)
      })

      const productHeaders = [
        'Product Name', 'Barcode', 'Category', 'Brand',
        'Session Name', 'Session Date', 'Session Type',
        'System Qty', 'Physical Qty', 'Variance',
        'Trend', 'Variance Value (₹)', 'Counted By', 'Notes'
      ]

      const productRows = [productHeaders]
      Object.entries(byProduct).sort(([a],[b]) => a.localeCompare(b)).forEach(([prodName, items]) => {
        // Sort items by date
        items.sort((a, b) => new Date(a.counted_at) - new Date(b.counted_at))
        items.forEach((item, idx) => {
          const sess = sessionsInRange.find(s => s.id === item.session_id)
          const prevItem = idx > 0 ? items[idx - 1] : null
          let trend = '—'
          if (prevItem) {
            const prevVar = prevItem.variance || 0
            const curVar = item.variance || 0
            if (Math.abs(curVar) < 0.001 && Math.abs(prevVar) >= 0.001) trend = '✓ Resolved'
            else if (Math.abs(curVar) > Math.abs(prevVar)) trend = '↑ Worse'
            else if (Math.abs(curVar) < Math.abs(prevVar)) trend = '↓ Better'
            else trend = '= Same'
          }
          productRows.push([
            item.product_name,
            item.barcode || '',
            item.category || '',
            item.brand || '',
            sess?.name || '',
            item.counted_at ? new Date(item.counted_at).toLocaleDateString('en-IN') : '',
            sess?.type || '',
            item.system_qty,
            item.physical_qty,
            item.variance >= 0 ? `+${item.variance}` : `${item.variance}`,
            trend,
            Math.abs(item.variance_value || 0).toFixed(2),
            item.counted_by || '',
            item.notes || ''
          ])
        })
        // Add empty row between products
        productRows.push(Array(14).fill(''))
      })

      // ── Sheet 3: Sessions List ──
      const sessHeaders = ['Session Name', 'Type', 'Category Filter', 'Date', 'Status', 'Items Counted', 'Variance Items', 'Total Variance Value (₹)', 'Created By']
      const sessRows = [sessHeaders]
      sessionsInRange.forEach(s => {
        const sItems = allItems.filter(i => i.session_id === s.id)
        const sVar = sItems.filter(i => Math.abs(i.variance || 0) > 0.001)
        const sVarVal = sItems.reduce((sum, i) => sum + Math.abs(i.variance_value || 0), 0)
        sessRows.push([
          s.name, s.type, s.category_filter || 'All',
          new Date(s.created_at).toLocaleDateString('en-IN'),
          s.status, sItems.length, sVar.length,
          sVarVal.toFixed(2), s.created_by || ''
        ])
      })

      // ── Build Excel workbook ──
      const wb = XLSX.utils.book_new()

      const ws1 = XLSX.utils.aoa_to_sheet(summaryData)
      ws1['!cols'] = [{ wch: 30 }, { wch: 20 }]
      XLSX.utils.book_append_sheet(wb, ws1, 'Summary')

      const ws2 = XLSX.utils.aoa_to_sheet(productRows)
      ws2['!cols'] = [
        { wch: 35 }, { wch: 15 }, { wch: 18 }, { wch: 18 },
        { wch: 20 }, { wch: 14 }, { wch: 14 },
        { wch: 11 }, { wch: 12 }, { wch: 10 },
        { wch: 12 }, { wch: 18 }, { wch: 14 }, { wch: 25 }
      ]
      XLSX.utils.book_append_sheet(wb, ws2, 'By Product')

      const ws3 = XLSX.utils.aoa_to_sheet(sessRows)
      ws3['!cols'] = [{ wch: 25 }, { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 20 }, { wch: 14 }]
      XLSX.utils.book_append_sheet(wb, ws3, 'Sessions')

      const fileName = `StockAudit_${reportRange.from}_to_${reportRange.to}.xlsx`
      XLSX.writeFile(wb, fileName)

      setSyncStatus({ state: 'ok', msg: 'Report downloaded ✓' })
      toast(`Report downloaded: ${fileName}`, 'success')
    } catch (err) {
      toast('Report failed: ' + err.message, 'error')
      setSyncStatus({ state: 'error', msg: 'Failed' })
    }
    setGeneratingReport(false)
    setReportModal(false)
  }

  // ── Derived data ──
  const cats = [...new Set(products.map(p => p.category).filter(Boolean))].sort()
  let filteredProds = products
  if (prodFilter.search) filteredProds = filteredProds.filter(p =>
    p.name.toLowerCase().includes(prodFilter.search.toLowerCase()) || (p.barcode || '').includes(prodFilter.search))
  if (prodFilter.cat) filteredProds = filteredProds.filter(p => p.category === prodFilter.cat)

  const varItems = sessionItems.filter(i => Math.abs(i.variance || 0) > 0.001)
  const shortItems = sessionItems.filter(i => (i.variance || 0) < -0.001)
  const excessItems = sessionItems.filter(i => (i.variance || 0) > 0.001)
  const matchedItems = sessionItems.filter(i => Math.abs(i.variance || 0) <= 0.001)
  const totalVarValue = sessionItems.reduce((s, i) => s + Math.abs(i.variance_value || 0), 0)
  const dispItems = showAll ? sessionItems : varItems

  // ── Session view ──
  if (view === 'session' && currentSession) {
    return (
      <div>
        <ConfirmDialog />
        <div className="card" style={{ padding: '14px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 18, fontWeight: 700, color: 'var(--brown-dark)' }}>{currentSession.name}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{fmtDate(currentSession.created_at)} · {currentSession.type} · <span className={`pill pill-${currentSession.status}`}>{currentSession.status}</span></div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary btn-sm" onClick={() => { setView('main'); setCurrentSession(null); fetchAll() }}>← Back</button>
            {currentSession.status === 'open' && <button className="btn btn-sm" style={{ background: 'var(--green)', color: 'var(--white)' }} onClick={closeSession}>✓ Close Session</button>}
          </div>
        </div>

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px,1fr))', gap: 10, marginBottom: 16 }}>
          <div className="stat-card green"><div className="stat-num">{sessionItems.length}</div><div className="stat-label">Items Counted</div></div>
          <div className="stat-card amber"><div className="stat-num">{Math.max(0, products.length - sessionItems.length)}</div><div className="stat-label">Remaining</div></div>
          <div className="stat-card red"><div className="stat-num">{shortItems.length}</div><div className="stat-label">Short Items</div></div>
          <div className="stat-card blue"><div className="stat-num">{excessItems.length}</div><div className="stat-label">Excess Items</div></div>
          <div className="stat-card green"><div className="stat-num">{matchedItems.length}</div><div className="stat-label">Matched</div></div>
          <div className="stat-card red"><div className="stat-num" style={{ fontSize: 16 }}>{fmt(totalVarValue)}</div><div className="stat-label">Variance Value</div></div>
        </div>

        {/* Scan input */}
        {currentSession.status === 'open' && (
          <div className="card" style={{ padding: '16px 18px', marginBottom: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--sage-dark)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 10 }}>📷 Scan Barcode or Search by Name</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <div style={{ flex: 1, position: 'relative' }}>
                <input className="form-input" value={searchInput}
                  onChange={e => { setSearchInput(e.target.value); setShowSuggestions(true) }}
                  onKeyDown={e => { if (e.key === 'Enter') { setShowSuggestions(false); lookup(searchInput) } if (e.key === 'Escape') setShowSuggestions(false) }}
                  placeholder="Scan barcode or type product name..."
                  style={{ border: '2px solid var(--gold-mid)', width: '100%' }} autoFocus />
                {showSuggestions && searchInput.trim().length > 0 && (() => {
                  const q = searchInput.toLowerCase()
                  const matches = products.filter(p => p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q)).slice(0, 8)
                  if (!matches.length) return null
                  return (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'var(--white)', border: '1.5px solid var(--gold-mid)', borderRadius: 'var(--rs)', boxShadow: 'var(--shadow-lg)', zIndex: 500, maxHeight: 220, overflowY: 'auto' }}>
                      {matches.map(p => (
                        <div key={p.id} onMouseDown={e => { e.preventDefault(); setShowSuggestions(false); lookup(p.name) }}
                          style={{ padding: '9px 13px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid var(--cream)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                          onMouseOver={ev => ev.currentTarget.style.background = 'var(--cream-warm)'}
                          onMouseOut={ev => ev.currentTarget.style.background = 'transparent'}>
                          <span><strong>{p.name}</strong></span>
                          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{p.barcode ? `${p.barcode}` : ''} {p.brand}</span>
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </div>
              <button className="btn btn-primary" onClick={() => { setShowSuggestions(false); lookup(searchInput) }}>Search</button>
            </div>

            {scanResult && (
              <div>
                {scanResult.error && <div style={{ background: 'var(--red-l)', color: 'var(--red)', padding: '10px 14px', borderRadius: 'var(--rs)', fontSize: 13 }}>❌ {scanResult.error}</div>}
                {scanResult.success && <div style={{ background: 'var(--green-l)', color: 'var(--green)', padding: '10px 14px', borderRadius: 'var(--rs)', fontSize: 13, fontWeight: 600 }}>{scanResult.success}</div>}
                {scanResult.product && !scanResult.success && (
                  <div style={{ background: 'var(--cream-warm)', borderRadius: 'var(--r)', padding: '14px 16px' }}>
                    <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>{scanResult.product.name}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 4 }}>
                      {scanResult.product.category} · {scanResult.product.brand} · {scanResult.product.barcode || 'No barcode'}
                    </div>
                    {/* System stock hint */}
                    {scanResult.product.system_stock != null && (
                      <div style={{ fontSize: 12, color: 'var(--blue)', marginBottom: 10, background: 'var(--blue-l)', padding: '5px 10px', borderRadius: 6, display: 'inline-block' }}>
                        💡 Last uploaded stock: <strong>{scanResult.product.system_stock}</strong> units — check Vyapar for current qty
                      </div>
                    )}
                    {scanResult.existing && <div style={{ fontSize: 11.5, color: 'var(--amber)', marginBottom: 10 }}>⚠️ Already counted — updating</div>}
                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <div>
                        <label className="form-label">System Qty (from Vyapar)</label>
                        <input className="form-input no-spinner" type="number" value={countEntry.system_qty}
                          onChange={e => setCountEntry(p => ({ ...p, system_qty: e.target.value }))}
                          onWheel={e => e.target.blur()} style={{ width: 110, textAlign: 'center', fontSize: 16, fontWeight: 700 }} />
                      </div>
                      <div>
                        <label className="form-label">Physical Qty (counted)</label>
                        <input className="form-input no-spinner" type="number" value={countEntry.physical_qty}
                          onChange={e => setCountEntry(p => ({ ...p, physical_qty: e.target.value }))}
                          onWheel={e => e.target.blur()} style={{ width: 110, textAlign: 'center', fontSize: 16, fontWeight: 700 }} autoFocus />
                      </div>
                      {countEntry.system_qty !== '' && countEntry.physical_qty !== '' && (() => {
                        const v = (parseFloat(countEntry.physical_qty) || 0) - (parseFloat(countEntry.system_qty) || 0)
                        const col = Math.abs(v) < 0.001 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--amber)'
                        return (
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: 10, color: col, fontWeight: 700, textTransform: 'uppercase' }}>Variance</div>
                            <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 24, fontWeight: 700, color: col }}>{v >= 0 ? '+' : ''}{v.toFixed(2)}</div>
                          </div>
                        )
                      })()}
                      <div style={{ flex: 1, minWidth: 140 }}>
                        <label className="form-label">Notes (optional)</label>
                        <input className="form-input" value={countEntry.notes} onChange={e => setCountEntry(p => ({ ...p, notes: e.target.value }))} placeholder="e.g. damaged, near expiry" onKeyDown={e => e.key === 'Enter' && saveCount()} />
                      </div>
                      <button className="btn btn-primary" onClick={saveCount}>✓ Save Count</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Count list */}
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--cream-dark)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--brown-dark)' }}>Count List ({sessionItems.length} items)</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} style={{ accentColor: 'var(--gold-mid)' }} />
              Show all (including matched)
            </label>
          </div>
          <div className="table-wrap">
            <table className="data-table" style={{ minWidth: 700 }}>
              <thead><tr><th>Product</th><th>Barcode</th><th>Category</th><th>System Qty</th><th>Physical Qty</th><th>Variance</th><th>Value</th><th>Notes</th><th>By</th></tr></thead>
              <tbody>
                {sessionItems.length === 0 ? (
                  <tr><td colSpan={9} style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>No items counted yet.</td></tr>
                ) : dispItems.length === 0 ? (
                  <tr><td colSpan={9} style={{ textAlign: 'center', padding: 28, color: 'var(--green)' }}>✅ No variances — all {sessionItems.length} items match!</td></tr>
                ) : dispItems.map(i => {
                  const v = i.variance || 0
                  const col = Math.abs(v) < 0.001 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--amber)'
                  return (
                    <tr key={i.id}>
                      <td><strong>{i.product_name}</strong></td>
                      <td><code style={{ fontSize: 11, background: 'var(--cream-dark)', padding: '1px 5px', borderRadius: 3 }}>{i.barcode || '—'}</code></td>
                      <td style={{ fontSize: 12 }}>{i.category || '—'}</td>
                      <td style={{ textAlign: 'center' }}>{i.system_qty}</td>
                      <td style={{ textAlign: 'center' }}>{i.physical_qty}</td>
                      <td><span style={{ fontWeight: 700, color: col }}>{v >= 0 ? '+' : ''}{v.toFixed(2)}</span></td>
                      <td style={{ color: Math.abs(i.variance_value || 0) > 0 ? 'var(--red)' : 'var(--green)', fontWeight: 600, fontSize: 12 }}>{i.variance_value ? `₹${Math.abs(i.variance_value).toFixed(2)}` : '—'}</td>
                      <td><small style={{ color: 'var(--muted)' }}>{i.notes || '—'}</small></td>
                      <td><small style={{ color: 'var(--muted)' }}>{i.counted_by}</small></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    )
  }

  // ── Main view ──
  return (
    <div>
      <ConfirmDialog />

      <div className="stats-grid">
        <StatCard num={products.length} label="Total Products" />
        <StatCard num={sessions.filter(s => s.status === 'open').length} label="Open Sessions" color="amber" />
        <StatCard num={sessions.filter(s => s.status === 'closed').length} label="Completed" color="green" />
        <StatCard num={sessions.length > 0 ? sessions[0].name : '—'} label="Latest Session" color="blue" />
      </div>

      <div className="section-header">
        <h2 className="section-title">🔍 Stock Check Sessions</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setReportModal(true)}>📊 Download Report</button>
          <button className="btn btn-primary" onClick={() => setNewSessModal(true)}>＋ New Stock Check</button>
        </div>
      </div>

      {loading ? <Loading /> : sessions.length === 0 ? (
        <div className="empty-state" style={{ marginBottom: 24 }}><div className="empty-icon">📦</div><p>No sessions yet.</p></div>
      ) : (
        <div className="card table-wrap" style={{ marginBottom: 24 }}>
          <table className="data-table">
            <thead><tr><th>Session Name</th><th>Date</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {sessions.map(s => (
                <tr key={s.id}>
                  <td><strong>{s.name}</strong><br /><small style={{ color: 'var(--muted)' }}>{s.type}{s.category_filter ? ` · ${s.category_filter}` : ''}</small></td>
                  <td>{fmtDate(s.created_at)}</td>
                  <td><span className={`pill pill-${s.status}`}>{s.status}</span></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm" style={{ background: s.status === 'open' ? 'var(--blue-l)' : 'var(--sage-pale)', color: s.status === 'open' ? 'var(--blue)' : 'var(--sage-dark)', marginRight: 4 }} onClick={() => openSession(s)}>
                      {s.status === 'open' ? '▶ Continue' : '📊 Report'}
                    </button>
                    {user.role === 'manager' && <button className="btn btn-sm btn-danger" onClick={() => deleteSession(s.id)}>🗑</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Product Master */}
      <div className="section-header">
        <h2 className="section-title" style={{ fontSize: 18 }}>🗂 Product Master</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="btn btn-primary btn-sm" style={{ cursor: 'pointer' }}>
            ⬆ Upload from Vyapar
            <input type="file" accept=".csv,.xlsx,.xls" onChange={handleCSV} style={{ display: 'none' }} />
          </label>
          <button className="btn btn-secondary btn-sm" onClick={() => {
            const csv = 'Item name*,Item code,Category,Brand,Default Mrp\nCold Pressed Groundnut Oil 1L,8901234567890,Oils,Timbaktu,320'
            const a = document.createElement('a'); a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv); a.download = 'product_sample.csv'; a.click()
          }}>⬇ Sample CSV</button>
          <button className="btn btn-primary btn-sm" onClick={openProdNew}>＋ Add Product</button>
        </div>
      </div>

      {/* Upload hint */}
      <div style={{ background: 'var(--blue-l)', borderRadius: 'var(--rs)', padding: '10px 14px', marginBottom: 14, fontSize: 12.5, color: 'var(--blue)' }}>
        💡 Upload your Vyapar "Export Items" Excel file. Existing products are updated, new ones are added — no duplicates created.
      </div>

      <div className="filter-bar">
        <input placeholder="Search by name or barcode..." value={prodFilter.search} onChange={e => setProdFilter({ ...prodFilter, search: e.target.value })} />
        <select value={prodFilter.cat} onChange={e => setProdFilter({ ...prodFilter, cat: e.target.value })}>
          <option value="">All Categories</option>
          {cats.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>{filteredProds.length} of {products.length} products</span>
      </div>
      <div className="card table-wrap">
        <table className="data-table">
          <thead><tr><th>Product Name</th><th>Barcode / Code</th><th>Category</th><th>Brand</th><th>Price (MRP)</th><th>Last Stock</th><th>Actions</th></tr></thead>
          <tbody>
            {filteredProds.length === 0 ? <tr><td colSpan={7} style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>No products. Upload Vyapar export or add manually.</td></tr> :
              filteredProds.map(p => (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong></td>
                  <td><code style={{ fontSize: 11, background: 'var(--cream-dark)', padding: '1px 5px', borderRadius: 3 }}>{p.barcode || '—'}</code></td>
                  <td style={{ fontSize: 12 }}>{p.category || '—'}</td>
                  <td style={{ fontSize: 12 }}>{p.brand || '—'}</td>
                  <td>{p.price ? `₹${p.price}` : '—'}</td>
                  <td style={{ fontSize: 12, color: 'var(--muted)' }}>{p.system_stock != null ? p.system_stock : '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm" style={{ background: 'var(--sage-pale)', color: 'var(--sage-dark)', marginRight: 4 }} onClick={() => openProdEdit(p)}>✏️</button>
                    <button className="btn btn-sm btn-danger" onClick={() => delProd(p.id)}>🗑</button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* New Session Modal */}
      <Modal open={newSessModal} onClose={() => setNewSessModal(false)} title="📦 Start Stock Check">
        <FormGroup label="Session Name *"><input className="form-input" value={sessForm.name} onChange={e => setSessForm({ ...sessForm, name: e.target.value })} placeholder="e.g. May Full Count, Oils Check" /></FormGroup>
        <FormRow>
          <FormGroup label="Type">
            <select className="form-input form-select" value={sessForm.type} onChange={e => setSessForm({ ...sessForm, type: e.target.value })}>
              <option value="full">Full Store Count</option><option value="category">Category Check</option><option value="spot">Spot Check</option>
            </select>
          </FormGroup>
          <FormGroup label="Category Filter (optional)">
            <select className="form-input form-select" value={sessForm.category_filter} onChange={e => setSessForm({ ...sessForm, category_filter: e.target.value })}>
              <option value="">All Categories</option>
              {cats.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </FormGroup>
        </FormRow>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setNewSessModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={startSession}>▶ Start Session</button>
        </div>
      </Modal>

      {/* Product Modal */}
      <Modal open={productModal} onClose={() => setProductModal(false)} title={prodEditId ? '✏️ Edit Product' : '📦 Add Product'}>
        <FormRow>
          <FormGroup label="Product Name *"><input className="form-input" value={prodForm.name} onChange={e => setProdForm({ ...prodForm, name: e.target.value })} /></FormGroup>
          <FormGroup label="Barcode / Item Code"><input className="form-input" value={prodForm.barcode} onChange={e => setProdForm({ ...prodForm, barcode: e.target.value })} /></FormGroup>
        </FormRow>
        <FormRow>
          <FormGroup label="Category"><input className="form-input" value={prodForm.category} onChange={e => setProdForm({ ...prodForm, category: e.target.value })} placeholder="e.g. Oils, Millets" /></FormGroup>
          <FormGroup label="Brand"><input className="form-input" value={prodForm.brand} onChange={e => setProdForm({ ...prodForm, brand: e.target.value })} /></FormGroup>
        </FormRow>
        <FormGroup label="MRP (₹)"><input className="form-input" type="number" value={prodForm.price} onChange={e => setProdForm({ ...prodForm, price: e.target.value })} /></FormGroup>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setProductModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={saveProd}>Save Product</button>
        </div>
      </Modal>

      {/* Report Modal */}
      <Modal open={reportModal} onClose={() => setReportModal(false)} title="📊 Download Stock Audit Report">
        <div style={{ background: 'var(--cream)', borderRadius: 'var(--rs)', padding: '12px 14px', marginBottom: 16, fontSize: 13, color: 'var(--muted)' }}>
          Select a date range to include all stock audit sessions within that period. The report will be downloaded as an Excel file with 3 sheets: Summary, By Product (with trend), and Sessions List.
        </div>
        <FormRow>
          <FormGroup label="From Date">
            <input className="form-input" type="date" value={reportRange.from} onChange={e => setReportRange(r => ({ ...r, from: e.target.value }))} />
          </FormGroup>
          <FormGroup label="To Date">
            <input className="form-input" type="date" value={reportRange.to} onChange={e => setReportRange(r => ({ ...r, to: e.target.value }))} />
          </FormGroup>
        </FormRow>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setReportModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={generateReport} disabled={generatingReport}>
            {generatingReport ? '⏳ Generating...' : '⬇ Download Excel Report'}
          </button>
        </div>
      </Modal>
    </div>
  )
}
