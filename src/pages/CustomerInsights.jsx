import { useState, useEffect, useMemo } from 'react'
import { supabase, fetchAllRows } from '../lib/supabase'
import { StatCard, Loading, UploadCard, TrendChart, RankTable } from '../components/ui'
import { fmt, fmtDate, today } from '../lib/utils'
import * as XLSX from 'xlsx'

const STATUS_COLOR = { Active: 'var(--green)', Cooling: 'var(--amber)', 'At Risk': 'var(--red)', Dormant: 'var(--muted)' }
const STATUS_BG = { Active: 'var(--green-l)', Cooling: 'var(--amber-l)', 'At Risk': 'var(--red-l)', Dormant: 'var(--cream)' }
const STATUS_ORDER = ['Active', 'Cooling', 'At Risk', 'Dormant']

function signedQty(t) {
  const isReturn = (t.transaction_type || '').toLowerCase().includes('return')
  const q = t.qty || 0
  return isReturn ? -Math.abs(q) : q
}
function signedAmount(t) {
  const isReturn = (t.transaction_type || '').toLowerCase().includes('return')
  const a = t.amount || 0
  return isReturn ? -Math.abs(a) : a
}
function parseExcelDate(v) {
  if (v == null || v === '') return null
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  const s = String(v).trim()
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/)
  if (m) {
    let [, d, mo, y] = m
    if (y.length === 2) y = '20' + y
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  return null
}
function num(v) { return parseFloat(String(v ?? '').replace(/,/g, '')) || 0 }

export default function CustomerInsights({ user, toast, setSyncStatus }) {
  const [transactions, setTransactions] = useState([])
  const [partyMap, setPartyMap] = useState({})
  const [loading, setLoading] = useState(true)
  const [uploadingWhat, setUploadingWhat] = useState('')
  const [view, setView] = useState('customers') // 'monthly' | 'customers' | 'items' | 'brands' | 'categories'
  const [metric, setMetric] = useState('revenue')
  const [customerSearch, setCustomerSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [customerSort, setCustomerSort] = useState('overdue') // 'overdue' | 'value'
  const [expanded, setExpanded] = useState(null)

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    const [txns, parties] = await Promise.all([
      fetchAllRows('sales_transactions', '*', 'date'),
      fetchAllRows('parties', '*', 'party_name')
    ])
    setTransactions(txns || [])
    const pmap = {}
    ;(parties || []).forEach(p => { pmap[p.party_name] = p })
    setPartyMap(pmap)
    setLoading(false)
  }

  // ── Upload: Sale Report (item-details sheet) ──────────────────
  async function handleSaleReportUpload(e) {
    const file = e.target.files[0]; if (!file) return
    setUploadingWhat('sales')
    setSyncStatus({ state: 'syncing', msg: 'Parsing Sale Report...' })
    try {
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array', cellDates: true })

      // Find the item-details sheet by header; fall back to the 2nd sheet.
      let itemSheetName = wb.SheetNames.find(name => {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null })
        const hdr = (rows[0] || []).map(h => String(h || '').toLowerCase())
        return hdr.some(h => h.includes('item name'))
      }) || wb.SheetNames[1] || wb.SheetNames[0]

      const itemData = XLSX.utils.sheet_to_json(wb.Sheets[itemSheetName], { header: 1, defval: null })
      const hdr = (itemData[0] || []).map(h => String(h || '').toLowerCase())

      const dateI = hdr.findIndex(h => h === 'date' || h.includes('date'))
      const invoiceI = hdr.findIndex(h => h.includes('invoice') || h.includes('txn no'))
      const partyI = hdr.findIndex(h => h.includes('party name'))
      const nameI = hdr.findIndex(h => h.includes('item name'))
      const codeI = hdr.findIndex(h => h.includes('item code'))
      const brandIdxs = hdr.map((h, i) => h.includes('brand') ? i : -1).filter(i => i >= 0)
      const catI = hdr.findIndex(h => h.includes('category'))
      const mrpI = hdr.findIndex(h => h.includes('mrp'))
      const qtyI = hdr.findIndex(h => h.includes('quantity'))
      const priceI = hdr.findIndex(h => h.includes('unitprice') || h.includes('unit price'))
      const discI = hdr.findIndex(h => h.includes('discount') && !h.includes('percent'))
      const taxPctI = hdr.findIndex(h => h.includes('tax percent'))
      const taxI = hdr.findIndex(h => h.includes('tax') && !h.includes('percent'))
      const typeI = hdr.findIndex(h => h.includes('transaction type'))
      const amtI = hdr.findIndex(h => h.includes('amount'))

      if (nameI < 0 || dateI < 0) { toast('Could not find Item Name / Date columns — is this the right sheet?', 'error'); setUploadingWhat(''); return }

      const rows = []
      let minDate = null, maxDate = null
      for (let i = 1; i < itemData.length; i++) {
        const row = itemData[i]
        if (!row || row.every(v => !v)) continue
        const name = String(row[nameI] || '').trim()
        if (!name) continue
        const date = parseExcelDate(row[dateI])
        if (!date) continue
        if (!minDate || date < minDate) minDate = date
        if (!maxDate || date > maxDate) maxDate = date
        const brand = brandIdxs.map(idx => String(row[idx] || '').trim()).find(v => v) || ''
        rows.push({
          date,
          invoice_no: String(row[invoiceI] || '').trim(),
          party_name: String(row[partyI] || '').trim() || '(Unknown)',
          item_name: name,
          item_code: String(row[codeI] || '').trim(),
          brand,
          category: String(row[catI] || '').trim(),
          mrp: mrpI >= 0 ? num(row[mrpI]) : null,
          qty: num(row[qtyI]),
          unit_price: num(row[priceI]),
          discount: num(row[discI]),
          tax_percent: num(row[taxPctI]),
          tax: num(row[taxI]),
          transaction_type: String(row[typeI] || '').trim() || 'Sale',
          amount: num(row[amtI]),
        })
      }

      if (!rows.length) { toast('No data found in file. Check format.', 'error'); setUploadingWhat(''); return }

      // Opportunistically pick up party phone numbers from any sheet that has them (e.g. the invoice summary sheet).
      const partyPhones = {}
      wb.SheetNames.forEach(name => {
        const sheetRows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null })
        const h2 = (sheetRows[0] || []).map(h => String(h || '').toLowerCase())
        const pNameI = h2.findIndex(h => h.includes('party name'))
        const pPhoneI = h2.findIndex(h => h.includes('phone'))
        if (pNameI < 0 || pPhoneI < 0) return
        for (let i = 1; i < sheetRows.length; i++) {
          const r = sheetRows[i]
          const pn = String(r[pNameI] || '').trim()
          const ph = String(r[pPhoneI] || '').trim()
          if (pn && ph) partyPhones[pn] = ph
        }
      })

      setSyncStatus({ state: 'syncing', msg: `Replacing ${minDate} → ${maxDate}...` })
      const { error: delErr } = await supabase.from('sales_transactions').delete().gte('date', minDate).lte('date', maxDate)
      if (delErr) { toast('Replace failed: ' + delErr.message, 'error'); setSyncStatus({ state: 'error', msg: 'Failed' }); setUploadingWhat(''); return }

      const BATCH = 300
      for (let i = 0; i < rows.length; i += BATCH) {
        const { error } = await supabase.from('sales_transactions').insert(rows.slice(i, i + BATCH))
        if (error) { toast('Save failed: ' + error.message, 'error'); setSyncStatus({ state: 'error', msg: 'Failed' }); setUploadingWhat(''); return }
        setSyncStatus({ state: 'syncing', msg: `Saving... ${Math.min(i + BATCH, rows.length)}/${rows.length}` })
      }

      const partyRows = Object.entries(partyPhones).map(([party_name, phone]) => ({ party_name, phone, updated_at: new Date().toISOString() }))
      for (let i = 0; i < partyRows.length; i += BATCH) {
        await supabase.from('parties').upsert(partyRows.slice(i, i + BATCH))
      }

      setSyncStatus({ state: 'ok', msg: `${rows.length} lines saved ✓` })
      toast(`✓ ${rows.length} line items saved, covering ${minDate} → ${maxDate}`, 'success')
      fetchAll()
    } catch (err) {
      toast('Upload failed: ' + err.message, 'error')
      setSyncStatus({ state: 'error', msg: 'Failed' })
    }
    setUploadingWhat('')
    e.target.value = ''
  }

  // ── Upload: All Parties Report ────────────────────────────────
  async function handlePartiesUpload(e) {
    const file = e.target.files[0]; if (!file) return
    setUploadingWhat('parties')
    setSyncStatus({ state: 'syncing', msg: 'Parsing Parties...' })
    try {
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
      const hdr = (data[0] || []).map(h => String(h || '').toLowerCase())
      const partyNameI = hdr.findIndex(h => h.includes('party name'))
      const nameI = partyNameI >= 0 ? partyNameI : hdr.findIndex(h => h.includes('name'))
      const phoneI = hdr.findIndex(h => h.includes('phone'))
      const gstinI = hdr.findIndex(h => h.includes('gstin'))

      const rows = []
      for (let i = 1; i < data.length; i++) {
        const row = data[i]
        const name = String(row[nameI] || '').trim()
        if (!name) continue
        rows.push({
          party_name: name,
          phone: String(row[phoneI] || '').trim(),
          gstin: gstinI >= 0 ? String(row[gstinI] || '').trim() : '',
          updated_at: new Date().toISOString()
        })
      }
      if (!rows.length) { toast('No parties found in file.', 'error'); setUploadingWhat(''); return }

      const BATCH = 300
      for (let i = 0; i < rows.length; i += BATCH) {
        const { error } = await supabase.from('parties').upsert(rows.slice(i, i + BATCH))
        if (error) { toast('Save failed: ' + error.message, 'error'); setSyncStatus({ state: 'error', msg: 'Failed' }); setUploadingWhat(''); return }
      }
      setSyncStatus({ state: 'ok', msg: `${rows.length} parties saved ✓` })
      toast(`✓ ${rows.length} parties saved`, 'success')
      fetchAll()
    } catch (err) {
      toast('Upload failed: ' + err.message, 'error')
      setSyncStatus({ state: 'error', msg: 'Failed' })
    }
    setUploadingWhat('')
    e.target.value = ''
  }

  // ── Analytics ──────────────────────────────────────────────────
  const monthlyTrend = useMemo(() => {
    const map = {}
    transactions.forEach(t => {
      const month = (t.date || '').slice(0, 7)
      if (!month) return
      if (!map[month]) map[month] = { month, qty: 0, revenue: 0, items: new Set(), orders: new Set() }
      map[month].qty += signedQty(t)
      map[month].revenue += signedAmount(t)
      map[month].items.add(t.item_name)
      if (t.invoice_no) map[month].orders.add(t.invoice_no)
    })
    return Object.values(map).sort((a, b) => a.month.localeCompare(b.month)).map(m => ({ ...m, itemCount: m.items.size, orderCount: m.orders.size }))
  }, [transactions])

  const itemAnalytics = useMemo(() => {
    const map = {}
    transactions.forEach(t => {
      const key = t.item_name
      if (!map[key]) map[key] = { item_name: key, brand: '', category: '', qty: 0, revenue: 0, buyers: new Set() }
      map[key].qty += signedQty(t)
      map[key].revenue += signedAmount(t)
      if (t.party_name) map[key].buyers.add(t.party_name)
      if (t.brand && !map[key].brand) map[key].brand = t.brand
      if (t.category && !map[key].category) map[key].category = t.category
    })
    return Object.values(map).map(i => ({ ...i, buyerCount: i.buyers.size }))
  }, [transactions])

  const brandAnalytics = useMemo(() => {
    const map = {}
    transactions.forEach(t => {
      const b = t.brand || 'Unknown'
      if (!map[b]) map[b] = { brand: b, qty: 0, revenue: 0, items: new Set() }
      map[b].qty += signedQty(t)
      map[b].revenue += signedAmount(t)
      map[b].items.add(t.item_name)
    })
    return Object.values(map).map(r => ({ ...r, itemCount: r.items.size }))
  }, [transactions])

  const categoryAnalytics = useMemo(() => {
    const map = {}
    transactions.forEach(t => {
      const c = t.category || 'Uncategorized'
      if (!map[c]) map[c] = { category: c, qty: 0, revenue: 0, items: new Set() }
      map[c].qty += signedQty(t)
      map[c].revenue += signedAmount(t)
      map[c].items.add(t.item_name)
    })
    return Object.values(map).map(r => ({ ...r, itemCount: r.items.size }))
  }, [transactions])

  const customerAnalytics = useMemo(() => {
    const map = {}
    transactions.forEach(t => {
      const key = t.party_name || '(Unknown)'
      if (!map[key]) map[key] = { party_name: key, revenue: 0, qty: 0, orders: new Set(), firstDate: t.date, lastDate: t.date, items: {} }
      const c = map[key]
      c.revenue += signedAmount(t)
      c.qty += signedQty(t)
      if (t.invoice_no) c.orders.add(t.invoice_no)
      if (t.date < c.firstDate) c.firstDate = t.date
      if (t.date > c.lastDate) c.lastDate = t.date
      if (!c.items[t.item_name]) c.items[t.item_name] = { item_name: t.item_name, qty: 0, revenue: 0, lastDate: t.date }
      c.items[t.item_name].qty += signedQty(t)
      c.items[t.item_name].revenue += signedAmount(t)
      if (t.date > c.items[t.item_name].lastDate) c.items[t.item_name].lastDate = t.date
    })
    const todayMs = new Date(today()).getTime()
    return Object.values(map).map(c => {
      const orderCount = c.orders.size
      const daysSince = Math.floor((todayMs - new Date(c.lastDate).getTime()) / 86400000)
      const spanDays = (new Date(c.lastDate).getTime() - new Date(c.firstDate).getTime()) / 86400000
      const avgDaysBetween = orderCount > 1 ? Math.round(spanDays / (orderCount - 1)) : null
      let status = 'Active'
      if (daysSince > 90) status = 'Dormant'
      else if (daysSince > 60) status = 'At Risk'
      else if (daysSince > 30) status = 'Cooling'
      return {
        party_name: c.party_name,
        phone: partyMap[c.party_name]?.phone || '',
        revenue: c.revenue, qty: c.qty, orderCount,
        firstDate: c.firstDate, lastDate: c.lastDate, daysSince, avgDaysBetween, status,
        items: Object.values(c.items).sort((a, b) => b.revenue - a.revenue)
      }
    })
  }, [transactions, partyMap])

  const filteredCustomers = useMemo(() => {
    let list = customerAnalytics
    if (statusFilter) list = list.filter(c => c.status === statusFilter)
    if (customerSearch) list = list.filter(c => c.party_name.toLowerCase().includes(customerSearch.toLowerCase()))
    return [...list].sort((a, b) => customerSort === 'value' ? b.revenue - a.revenue : b.daysSince - a.daysSince)
  }, [customerAnalytics, statusFilter, customerSearch, customerSort])

  const statusCounts = {}
  customerAnalytics.forEach(c => { statusCounts[c.status] = (statusCounts[c.status] || 0) + 1 })

  const totalRevenue = transactions.reduce((s, t) => s + signedAmount(t), 0)
  const totalQty = transactions.reduce((s, t) => s + signedQty(t), 0)
  const totalOrders = new Set(transactions.map(t => t.invoice_no).filter(Boolean)).size
  const dateRange = transactions.length ? [transactions.reduce((m, t) => t.date < m ? t.date : m, transactions[0].date), transactions.reduce((m, t) => t.date > m ? t.date : m, transactions[0].date)] : null

  return (
    <div>
      <div className="section-header">
        <h2 className="section-title">👥 Customer Insights</h2>
      </div>

      <div className="card" style={{ padding: '14px 18px', marginBottom: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 12 }}>Data Uploads</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12 }}>
          <UploadCard
            title="1. Sale Report"
            subtitle="Vyapar → Reports → Sale Report (item-details sheet)"
            desc="Party + item + date level sales, drives everything below"
            loading={uploadingWhat === 'sales'}
            accept=".xlsx,.xls"
            onChange={handleSaleReportUpload}
            badge={transactions.length ? `${transactions.length.toLocaleString()} lines${dateRange ? ` · ${dateRange[0]} → ${dateRange[1]}` : ''}` : null}
          />
          <UploadCard
            title="2. All Parties Report"
            subtitle="Vyapar → Reports → Party Reports"
            desc="Customer names & phone numbers"
            loading={uploadingWhat === 'parties'}
            accept=".xlsx,.xls"
            onChange={handlePartiesUpload}
            badge={Object.keys(partyMap).length ? `${Object.keys(partyMap).length} parties` : null}
          />
        </div>
      </div>

      {loading ? <Loading /> : transactions.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">👥</div>
          <p>Upload a Sale Report above to see customer & sales trends.</p>
        </div>
      ) : (
        <>
          <div className="stats-grid">
            <StatCard num={customerAnalytics.length} label="Customers" />
            <StatCard num={totalOrders.toLocaleString()} label="Orders" color="blue" />
            <StatCard num={fmt(totalRevenue)} label="Total Revenue" color="green" />
            <StatCard num={statusCounts['Dormant'] || 0} label="Dormant (90+ days)" color="red" />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[['customers', '👥 Customers'], ['monthly', '📅 Monthly Trend'], ['items', '🏷️ Item-wise'], ['brands', '🏭 Brand-wise'], ['categories', '📂 Category-wise']].map(([id, label]) => (
                <button key={id} className="btn btn-sm" onClick={() => setView(id)}
                  style={{ background: view === id ? 'var(--brown-dark)' : 'var(--cream-dark)', color: view === id ? 'var(--gold)' : 'var(--brown-light)' }}>
                  {label}
                </button>
              ))}
            </div>
            {view !== 'customers' && (
              <div style={{ display: 'flex', border: '1.5px solid var(--cream-dark)', borderRadius: 8, overflow: 'hidden' }}>
                {[['revenue', '₹ Revenue'], ['qty', '📦 Qty']].map(([m, label]) => (
                  <button key={m} onClick={() => setMetric(m)} style={{
                    padding: '7px 16px', border: 'none', fontFamily: 'inherit', fontSize: 12.5,
                    fontWeight: metric === m ? 700 : 400, cursor: 'pointer',
                    background: metric === m ? 'var(--brown-dark)' : 'var(--white)',
                    color: metric === m ? 'var(--gold)' : 'var(--muted)'
                  }}>{label}</button>
                ))}
              </div>
            )}
          </div>

          {view === 'customers' && (
            <div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
                <button onClick={() => setStatusFilter('')}
                  style={{ padding: '4px 12px', borderRadius: 20, border: '1.5px solid var(--cream-dark)', background: !statusFilter ? 'var(--brown-dark)' : 'var(--white)', color: !statusFilter ? 'var(--gold)' : 'var(--muted)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer', fontWeight: !statusFilter ? 700 : 400 }}>
                  All ({customerAnalytics.length})
                </button>
                {STATUS_ORDER.map(status => (
                  <button key={status} onClick={() => setStatusFilter(f => f === status ? '' : status)}
                    style={{ padding: '4px 12px', borderRadius: 20, border: `1.5px solid ${STATUS_COLOR[status]}`, background: statusFilter === status ? STATUS_COLOR[status] : STATUS_BG[status], color: statusFilter === status ? 'white' : STATUS_COLOR[status], fontFamily: 'inherit', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>
                    {status} ({statusCounts[status] || 0})
                  </button>
                ))}
              </div>
              <div className="filter-bar">
                <input placeholder="Search customer..." value={customerSearch} onChange={e => setCustomerSearch(e.target.value)} />
                <div style={{ display: 'flex', border: '1.5px solid var(--cream-dark)', borderRadius: 8, overflow: 'hidden' }}>
                  {[['overdue', 'Most Overdue'], ['value', 'Highest Spend']].map(([s, label]) => (
                    <button key={s} onClick={() => setCustomerSort(s)} style={{
                      padding: '7px 14px', border: 'none', fontFamily: 'inherit', fontSize: 12.5,
                      fontWeight: customerSort === s ? 700 : 400, cursor: 'pointer',
                      background: customerSort === s ? 'var(--brown-dark)' : 'var(--white)',
                      color: customerSort === s ? 'var(--gold)' : 'var(--muted)'
                    }}>{label}</button>
                  ))}
                </div>
              </div>
              <CustomerList customers={filteredCustomers} expanded={expanded} setExpanded={setExpanded} />
            </div>
          )}

          {view === 'monthly' && <TrendChart data={monthlyTrend} xKey="month" metric={metric}
            formatValue={d => metric === 'revenue' ? fmt(d.revenue) : d.qty.toLocaleString()}
            subLabel={d => `${d.orderCount} orders`} />}

          {view === 'items' && <RankTable rows={[...itemAnalytics].sort((a, b) => b[metric] - a[metric]).slice(0, 200)} nameKey="item_name" metric={metric} icon="🏷️" extraCol={{ label: 'Buyers', value: r => r.buyerCount }} />}
          {view === 'brands' && <RankTable rows={[...brandAnalytics].sort((a, b) => b[metric] - a[metric])} nameKey="brand" metric={metric} icon="🏭" extraCol={{ label: 'Items', value: r => r.itemCount }} />}
          {view === 'categories' && <RankTable rows={[...categoryAnalytics].sort((a, b) => b[metric] - a[metric])} nameKey="category" metric={metric} icon="📂" extraCol={{ label: 'Items', value: r => r.itemCount }} />}
        </>
      )}
    </div>
  )
}

function CustomerList({ customers, expanded, setExpanded }) {
  if (!customers.length) return <div className="empty-state"><p>No customers match this filter.</p></div>
  return (
    <div>
      {customers.map(c => {
        const isOpen = expanded === c.party_name
        return (
          <div key={c.party_name} className="group-card">
            <div className="group-card-header" onClick={() => setExpanded(isOpen ? null : c.party_name)}>
              <div style={{ minWidth: 180 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{c.party_name}</div>
                {c.phone && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{c.phone}</div>}
              </div>
              <span style={{ background: STATUS_BG[c.status], color: STATUS_COLOR[c.status], padding: '3px 10px', borderRadius: 10, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{c.status}</span>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', minWidth: 100, textAlign: 'right' }}>{c.daysSince}d since last</div>
              <div style={{ fontSize: 12.5, minWidth: 70, textAlign: 'right' }}>{c.orderCount} orders</div>
              <div style={{ fontWeight: 700, color: 'var(--green)', minWidth: 100, textAlign: 'right' }}>{fmt(c.revenue)}</div>
            </div>
            <div className={`group-card-body ${isOpen ? 'open' : ''}`}>
              <div style={{ padding: 14 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
                  First seen {fmtDate(c.firstDate)} · Last purchase {fmtDate(c.lastDate)}
                  {c.avgDaysBetween ? ` · buys roughly every ${c.avgDaysBetween} days` : ''}
                </div>
                <div className="table-wrap">
                  <table className="data-table" style={{ minWidth: 400 }}>
                    <thead><tr><th>Item</th><th>Qty</th><th>Revenue</th><th>Last bought</th></tr></thead>
                    <tbody>
                      {c.items.map(it => (
                        <tr key={it.item_name}>
                          <td style={{ fontWeight: 600 }}>{it.item_name}</td>
                          <td style={{ textAlign: 'center' }}>{it.qty}</td>
                          <td style={{ color: 'var(--green)', fontWeight: 600 }}>{fmt(it.revenue)}</td>
                          <td>{fmtDate(it.lastDate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
