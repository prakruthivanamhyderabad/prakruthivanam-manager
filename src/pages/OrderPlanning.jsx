import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { Modal, FormGroup, FormRow, StatCard, Loading } from '../components/ui'
import { fmt, fmtDate, today, thisMonth } from '../lib/utils'
import * as XLSX from 'xlsx'

const STATUS_CONFIG = {
  'Out of Stock':        { color: 'var(--red)',    bg: 'var(--red-l)',    icon: '🔴', priority: 1 },
  'Order Now':           { color: 'var(--red)',    bg: 'var(--red-l)',    icon: '🟠', priority: 2 },
  'Low Stock Soon':      { color: 'var(--amber)',  bg: 'var(--amber-l)',  icon: '🟡', priority: 3 },
  'Expiry Risk':         { color: 'var(--amber)',  bg: 'var(--amber-l)',  icon: '⚠️', priority: 4 },
  'Enough Stock':        { color: 'var(--green)',  bg: 'var(--green-l)',  icon: '✅', priority: 5 },
  'Overstock':           { color: 'var(--blue)',   bg: 'var(--blue-l)',   icon: '📦', priority: 6 },
  'Dead / No Sales':     { color: 'var(--muted)',  bg: 'var(--cream)',    icon: '💀', priority: 7 },
  'Expiry Stop Order':   { color: 'var(--muted)',  bg: 'var(--cream)',    icon: '🛑', priority: 8 },
}

const TREND_ICON = { growing: '📈', declining: '📉', stable: '➡️', unknown: '❓' }
const MOVEMENT_COLOR = { fast: 'var(--green)', medium: 'var(--amber)', slow: 'var(--muted)', dead: 'var(--red)' }

// ── Fuzzy match helper ──────────────────────────────────
function normalise(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

function matchScore(a, b) {
  const na = normalise(a), nb = normalise(b)
  if (na === nb) return { score: 1, type: 'Exact' }
  if (na.includes(nb) || nb.includes(na)) return { score: 0.9, type: 'Contains' }
  const wa = na.split(' '), wb = nb.split(' ')
  const common = wa.filter(w => w.length > 2 && wb.includes(w))
  const score = common.length / Math.max(wa.length, wb.length)
  return { score, type: score > 0.5 ? 'Fuzzy' : 'None' }
}

export default function OrderPlanning({ user, toast, setSyncStatus }) {
  const [products, setProducts] = useState([])
  const [salesHistory, setSalesHistory] = useState([]) // all monthly_sales rows
  const [pricelists, setPricelists] = useState([]) // latest pricelist per supplier
  const [params, setParams] = useState({})
  const [orderItems, setOrderItems] = useState([]) // computed order plan
  const [currentPlan, setCurrentPlan] = useState(null)
  const [savedPlans, setSavedPlans] = useState([])
  const [loading, setLoading] = useState(true)
  const [computing, setComputing] = useState(false)
  const [activeView, setActiveView] = useState('plan') // 'plan' | 'history' | 'params' | 'sales'
  const [filters, setFilters] = useState({ status: '', brand: '', category: '', search: '' })
  const [deliveryMode, setDeliveryMode] = useState('vehicle')
  const [paramsModal, setParamsModal] = useState(false)
  const [editParams, setEditParams] = useState({})
  const [uploadingWhat, setUploadingWhat] = useState('')
  const [salesMonths, setSalesMonths] = useState([])
  const [supplierNames, setSupplierNames] = useState([])
  const [salesView, setSalesView] = useState('monthly') // 'monthly' | 'items' | 'brands' | 'categories'
  const [salesMetric, setSalesMetric] = useState('revenue') // 'revenue' | 'qty'
  const [salesSearch, setSalesSearch] = useState('')

  useEffect(() => { fetchAll() }, [])

  // Supabase/PostgREST caps a single request at ~1000 rows by default —
  // page through with .range() so multi-month uploads don't get silently truncated.
  async function fetchAllRows(table, select, orderCol) {
    const PAGE = 1000
    let all = [], from = 0
    while (true) {
      const { data, error } = await supabase.from(table).select(select).order(orderCol).range(from, from + PAGE - 1)
      if (error || !data) break
      all = all.concat(data)
      if (data.length < PAGE) break
      from += PAGE
    }
    return all
  }

  async function fetchAll() {
    const [
      prods, sales, { data: pl },
      { data: par }, { data: plans }
    ] = await Promise.all([
      fetchAllRows('products', '*', 'name'),
      fetchAllRows('monthly_sales', '*', 'month'),
      supabase.from('supplier_pricelists').select('*').order('upload_date', { ascending: false }),
      supabase.from('planning_params').select('*'),
      supabase.from('order_plans').select('*, order_items(*)').order('created_at', { ascending: false }).limit(20)
    ])
    setProducts(prods || [])
    setSalesHistory(sales || [])
    setPricelists(pl || [])
    setSavedPlans(plans || [])

    const paramMap = {}
    par?.forEach(p => { paramMap[p.key] = p.value })
    setParams(paramMap)

    // Derive months and suppliers
    const months = [...new Set((sales || []).map(s => s.month))].sort()
    setSalesMonths(months)
    const suppliers = [...new Set((pl || []).map(p => p.supplier_name))].sort()
    setSupplierNames(suppliers)

    setLoading(false)
  }

  // ── Compute order plan ──────────────────────────────────
  function computeOrderPlan() {
    if (!products.length) { toast('Upload Vyapar Export Items first.', 'error'); return }
    setComputing(true)

    // Deduplicate products — keep the one with highest system_stock (most recent upload)
    const prodMap = {}
    products.forEach(prod => {
      const key = prod.name.toLowerCase()
      if (!prodMap[key] || (prod.system_stock || 0) > (prodMap[key].system_stock || 0)) {
        prodMap[key] = prod
      }
    })
    const dedupedProducts = Object.values(prodMap)

    const p = params
    const leadTime = p.lead_time_days || 7
    const fastSafety = p.fast_safety_days || 10
    const slowSafety = p.slow_safety_days || 3
    const expiryHighMax = p.expiry_high_max_days || 14
    const expiryMedMax = p.expiry_medium_max_days || 25
    const expiryLowMax = p.expiry_low_max_days || 45
    const deadThreshold = p.dead_stock_threshold || 3
    const expiryHighMonths = p.expiry_high_months || 2
    const expiryMedMonths = p.expiry_medium_months || 4

    // Build sales map with multiple keys for fuzzy matching
    const salesMap = {} // exact name -> { month -> qty_out }
    const salesNormMap = {} // normalised name -> item_name
    salesHistory.forEach(s => {
      if (!salesMap[s.item_name]) salesMap[s.item_name] = {}
      salesMap[s.item_name][s.month] = (salesMap[s.item_name][s.month] || 0) + (s.qty_out || 0)
      salesNormMap[normalise(s.item_name)] = s.item_name
      // Also index by item_code
      if (s.item_code) salesNormMap[s.item_code.toLowerCase()] = s.item_name
    })

    function getSalesForProduct(prod) {
      // Try exact match first
      if (salesMap[prod.name]) return salesMap[prod.name]
      // Try barcode match
      if (prod.barcode && salesNormMap[prod.barcode.toLowerCase()]) {
        const matched = salesNormMap[prod.barcode.toLowerCase()]
        return salesMap[matched] || {}
      }
      // Try normalised name match
      const normName = normalise(prod.name)
      if (salesNormMap[normName]) return salesMap[salesNormMap[normName]] || {}
      // Try partial match
      for (const [normKey, origName] of Object.entries(salesNormMap)) {
        const score = matchScore(prod.name, origName).score
        if (score > 0.7) return salesMap[origName] || {}
      }
      return {}
    }

    // Build pricelist map: match each product to supplier items
    const latestPricelist = {}
    pricelists.forEach(pl => {
      const key = pl.supplier_name + '_' + pl.product_name
      if (!latestPricelist[key]) latestPricelist[key] = pl
    })
    const pricelistItems = Object.values(latestPricelist)

    const activeSalesMonths = [...new Set(salesHistory.map(s => s.month))].sort()
    const activeCount = activeSalesMonths.length || 1

    // Last 3 months
    const last3 = activeSalesMonths.slice(-3)

    const items = dedupedProducts.map(prod => {
      const monthlySales = getSalesForProduct(prod)
      const allQtys = Object.values(monthlySales)
      const totalQty = allQtys.reduce((s, v) => s + v, 0)
      const avgMonthly = totalQty / activeCount

      // Last 3 month avg
      const last3Qtys = last3.map(m => monthlySales[m] || 0)
      const last3Avg = last3.length ? last3Qtys.reduce((s, v) => s + v, 0) / last3.length : avgMonthly

      // Trend
      let trend = 'unknown'
      if (avgMonthly > 0) {
        const ratio = last3Avg / avgMonthly
        if (ratio >= 1.15) trend = 'growing'
        else if (ratio <= 0.85) trend = 'declining'
        else trend = 'stable'
      }

      // Forecast = last3avg weighted with trend
      const forecast = trend === 'growing' ? last3Avg * 1.1 : trend === 'declining' ? last3Avg * 0.9 : last3Avg || avgMonthly

      // Current stock from product master (uploaded from Vyapar export)
      const currentStock = prod.system_stock != null ? prod.system_stock : (prod.current_stock || 0)

      // Expiry
      const expiryMonths = prod.expiry_months || null
      let expiryRisk = 'Unknown'
      let maxStockDays = expiryLowMax
      if (expiryMonths != null) {
        if (expiryMonths <= expiryHighMonths) { expiryRisk = 'High'; maxStockDays = expiryHighMax }
        else if (expiryMonths <= expiryMedMonths) { expiryRisk = 'Medium'; maxStockDays = expiryMedMax }
        else { expiryRisk = 'Low'; maxStockDays = expiryLowMax }
      }

      // Movement classification
      let movement = 'dead'
      if (avgMonthly > 30) movement = 'fast'
      else if (avgMonthly > 10) movement = 'medium'
      else if (avgMonthly > deadThreshold / activeCount) movement = 'slow'

      // Daily rate
      const dailyRate = forecast / 30
      const daysoCover = dailyRate > 0 ? currentStock / dailyRate : 999

      // Safety days based on movement
      const safetyDays = movement === 'fast' || movement === 'medium' ? fastSafety : slowSafety

      // Suggested min/max stock (in units)
      const minStockDays = leadTime + safetyDays
      const suggestedMin = dailyRate * minStockDays
      const suggestedMax = dailyRate * Math.min(maxStockDays, minStockDays + 30)

      // Bus qty = just enough to cover lead time + minimal buffer
      const busQty = Math.max(0, Math.ceil(suggestedMin - currentStock))
      // Vehicle qty = full replenishment to suggested max
      const vehicleQty = Math.max(0, Math.ceil(suggestedMax - currentStock))

      // Reorder status
      let reorderStatus = 'Enough Stock'
      if (totalQty <= deadThreshold) reorderStatus = 'Dead / No Sales'
      else if (currentStock <= 0) reorderStatus = 'Out of Stock'
      else if (expiryRisk === 'High' && daysoCover >= maxStockDays) reorderStatus = 'Expiry Stop Order'
      else if (expiryRisk === 'High') reorderStatus = 'Expiry Risk'
      else if (daysoCover < leadTime) reorderStatus = 'Order Now'
      else if (daysoCover < minStockDays) reorderStatus = 'Low Stock Soon'
      else if (daysoCover > maxStockDays * 2) reorderStatus = 'Overstock'

      // Match to supplier pricelist
      let bestMatch = null, bestScore = 0, matchType = 'No Match'
      pricelistItems.forEach(pl => {
        const { score, type } = matchScore(prod.name, pl.product_name)
        if (score > bestScore) { bestScore = score; bestMatch = pl; matchType = type }
      })
      const matched = bestScore > 0.5 ? bestMatch : null

      return {
        id: prod.id,
        item_name: prod.name,
        item_code: prod.barcode || '',
        brand: prod.brand || '',
        category: prod.category || '',
        expiry_months: expiryMonths,
        expiry_risk: expiryRisk,
        current_stock: currentStock,
        avg_monthly_sales: Math.round(avgMonthly * 10) / 10,
        last3m_avg: Math.round(last3Avg * 10) / 10,
        trend, forecast: Math.round(forecast * 10) / 10,
        days_cover: Math.round(daysoCover),
        reorder_status: reorderStatus,
        movement,
        bus_qty: busQty,
        vehicle_qty: vehicleQty,
        final_qty: deliveryMode === 'bus' ? busQty : vehicleQty,
        dealer_price: matched?.dealer_price || null,
        mrp: matched?.mrp || prod.price || null,
        supplier_product_name: matched?.product_name || '',
        supplier_in_stock: matched?.in_stock != null ? matched.in_stock : null,
        supplier_name: matched?.supplier_name || '',
        match_type: matchType,
        _totalQty: totalQty
      }
    })

    setOrderItems(items)
    setComputing(false)
    toast(`Order plan computed — ${items.length} products`, 'success')
  }

  function updateFinalQty(itemName, qty) {
    setOrderItems(prev => prev.map(i => i.item_name === itemName ? { ...i, final_qty: parseFloat(qty) || 0 } : i))
  }

  function applyDeliveryMode(mode) {
    setDeliveryMode(mode)
    setOrderItems(prev => prev.map(i => ({ ...i, final_qty: mode === 'bus' ? i.bus_qty : i.vehicle_qty })))
  }

  async function savePlan() {
    if (!orderItems.length) { toast('Compute order plan first.', 'error'); return }
    setSyncStatus({ state: 'syncing', msg: 'Saving plan...' })
    const { data: plan } = await supabase.from('order_plans').insert({
      plan_date: today(), for_month: thisMonth(),
      delivery_mode: deliveryMode, status: 'draft'
    }).select()
    const planId = plan[0].id
    const rows = orderItems.filter(i => i.final_qty > 0).map(i => ({
      plan_id: planId, item_name: i.item_name, item_code: i.item_code,
      brand: i.brand, category: i.category,
      expiry_months: i.expiry_months, expiry_risk: i.expiry_risk,
      current_stock: i.current_stock, avg_monthly_sales: i.avg_monthly_sales,
      last3m_avg: i.last3m_avg, trend: i.trend, forecast_qty: i.forecast,
      days_cover: i.days_cover, reorder_status: i.reorder_status,
      movement: i.movement, bus_qty: i.bus_qty, vehicle_qty: i.vehicle_qty,
      final_qty: i.final_qty, dealer_price: i.dealer_price,
      mrp: i.mrp, supplier_product_name: i.supplier_product_name,
      supplier_in_stock: i.supplier_in_stock, match_type: i.match_type
    }))
    await supabase.from('order_items').insert(rows)
    setCurrentPlan(planId)
    setSyncStatus({ state: 'ok', msg: 'Plan saved ✓' })
    fetchAll()
    toast('Order plan saved ✓', 'success')
  }

  function downloadOrderExcel() {
    if (!orderItems.length) { toast('No order plan to download.', 'error'); return }
    const toOrder = filtered.filter(i => i.final_qty > 0)
    if (!toOrder.length) { toast('No items with order qty > 0 in current filter.', 'error'); return }

    const wb = XLSX.utils.book_new()

    // Group by brand/supplier
    const brands = [...new Set(toOrder.map(i => i.brand || 'Unbranded'))].sort()
    brands.forEach(brand => {
      const brandItems = toOrder.filter(i => (i.brand || 'Unbranded') === brand)
      const rows = [
        ['Order Sheet — ' + brand],
        ['Date:', today(), 'Mode:', deliveryMode === 'bus' ? '🚌 Bus' : '🚛 Vehicle', 'Month:', thisMonth()],
        [],
        ['#', 'Product Name', 'Supplier Product', 'Match', 'Current Stock', 'Avg Sales/Month', 'Days Cover',
         'Status', 'Bus Qty', 'Vehicle Qty', 'FINAL ORDER QTY', 'Dealer Price', 'MRP', 'Est. Value', 'Available?', 'Notes']
      ]
      let totalValue = 0
      brandItems.forEach((item, idx) => {
        const estVal = (item.final_qty || 0) * (item.dealer_price || 0)
        totalValue += estVal
        rows.push([
          idx + 1, item.item_name, item.supplier_product_name || '—',
          item.match_type || '—', item.current_stock,
          item.avg_monthly_sales, item.days_cover,
          item.reorder_status, item.bus_qty, item.vehicle_qty,
          item.final_qty, item.dealer_price || '—',
          item.mrp || '—', estVal > 0 ? estVal.toFixed(2) : '—',
          item.supplier_in_stock == null ? 'Unknown' : item.supplier_in_stock ? 'In Stock' : '❌ Out of Stock',
          item.notes || ''
        ])
      })
      rows.push([], ['', '', '', '', '', '', '', 'TOTAL ESTIMATED VALUE:', '', '', '', '', '', totalValue.toFixed(2)])
      const ws = XLSX.utils.aoa_to_sheet(rows)
      ws['!cols'] = [
        {wch:4},{wch:30},{wch:28},{wch:10},{wch:14},{wch:16},{wch:12},
        {wch:18},{wch:10},{wch:12},{wch:16},{wch:13},{wch:10},{wch:12},{wch:14},{wch:25}
      ]
      XLSX.utils.book_append_sheet(wb, ws, brand.slice(0, 31))
    })

    // Summary sheet
    const summaryRows = [
      ['FULL ORDER SUMMARY — ' + today()],
      ['Delivery Mode:', deliveryMode === 'bus' ? '🚌 Bus (lean)' : '🚛 Vehicle (full)'],
      [],
      ['Brand/Supplier', 'Items to Order', 'Est. Order Value (₹)']
    ]
    brands.forEach(brand => {
      const brandItems = toOrder.filter(i => (i.brand || 'Unbranded') === brand)
      const val = brandItems.reduce((s, i) => s + (i.final_qty || 0) * (i.dealer_price || 0), 0)
      summaryRows.push([brand, brandItems.length, val.toFixed(2)])
    })
    summaryRows.push([], ['TOTAL', toOrder.length, toOrder.reduce((s, i) => s + (i.final_qty||0)*(i.dealer_price||0), 0).toFixed(2)])
    const ws0 = XLSX.utils.aoa_to_sheet(summaryRows)
    ws0['!cols'] = [{wch:25},{wch:15},{wch:20}]
    XLSX.utils.book_append_sheet(wb, ws0, 'Summary')

    XLSX.writeFile(wb, `OrderPlan_${today()}_${deliveryMode}.xlsx`)
    toast('Order sheet downloaded ✓', 'success')
  }

  // ── File uploads ──────────────────────────────────
  async function handleExportItemsUpload(e) {
    const file = e.target.files[0]; if (!file) return
    setUploadingWhat('items')
    setSyncStatus({ state: 'syncing', msg: 'Parsing Export Items...' })
    try {
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
      const hdr = (data[0] || []).map(h => String(h || '').toLowerCase())
      const nameI = hdr.findIndex(h => h.includes('item name'))
      const codeI = hdr.findIndex(h => h.includes('item code'))
      const catI = hdr.findIndex(h => h.includes('category'))
      const brandI = hdr.findIndex(h => h.includes('brand'))
      const mrpI = hdr.findIndex(h => h.includes('mrp') || h.includes('default mrp'))
      const stockI = hdr.findIndex(h => h.includes('current stock'))
      const expiryI = hdr.findIndex(h => h.includes('expiry'))

      let updated = 0, inserted = 0
      const existingByName = {}
      const existingByCode = {}
      products.forEach(p => {
        existingByName[p.name.toLowerCase()] = p
        if (p.barcode) existingByCode[p.barcode.toLowerCase()] = p
      })

      for (let i = 1; i < data.length; i++) {
        const row = data[i]
        const name = String(row[nameI] || '').trim()
        if (!name) continue
        const code = String(row[codeI] || '').trim()
        const stock = parseFloat(String(row[stockI] || '').replace(/,/g,'')) || 0
        const expiry = String(row[expiryI] || '').trim()
        // Parse expiry: "6 Months" -> 6, "1 Year" -> 12
        let expiryMonths = null
        const em = expiry.match(/(\d+)\s*month/i)
        const ey = expiry.match(/(\d+)\s*year/i)
        if (em) expiryMonths = parseInt(em[1])
        else if (ey) expiryMonths = parseInt(ey[1]) * 12
        const payload = {
          name, barcode: code,
          category: String(row[catI] || '').trim(),
          brand: String(row[brandI] || '').trim(),
          price: parseFloat(String(row[mrpI] || '').replace(/,/g,'')) || 0,
          system_stock: stock, expiry_months: expiryMonths,
          updated_at: new Date().toISOString()
        }
        const existing = (code && existingByCode[code.toLowerCase()]) || existingByName[name.toLowerCase()]
        if (existing) {
          await supabase.from('products').update(payload).eq('id', existing.id)
          updated++
        } else {
          await supabase.from('products').insert(payload)
          inserted++
        }
      }
      setSyncStatus({ state: 'ok', msg: `${inserted} new · ${updated} updated ✓` })
      toast(`✓ ${inserted} new products · ${updated} updated with latest stock`, 'success')
      fetchAll()
    } catch (err) {
      toast('Upload failed: ' + err.message, 'error')
      setSyncStatus({ state: 'error', msg: 'Failed' })
    }
    setUploadingWhat('')
    e.target.value = ''
  }

  async function handleSalesUpload(e) {
    const file = e.target.files[0]; if (!file) return
    setUploadingWhat('sales')
    setSyncStatus({ state: 'syncing', msg: 'Parsing sales report...' })
    try {
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })

      // Auto-detect month from filename: StockDetailReport_01_08_26_to_31_08_26
      // Use the TO date part to get the end month
      let month = thisMonth()
      const toMatch = file.name.match(/_to_(\d{2})_(\d{2})_(\d{2,4})/i)
      const fromMatch = file.name.match(/(\d{2})_(\d{2})_(\d{2,4})/)
      if (toMatch) {
        const mo = toMatch[2], yr = toMatch[3]
        const fullYr = yr.length === 2 ? '20' + yr : yr
        month = `${fullYr}-${mo.padStart(2,'0')}`
      } else if (fromMatch) {
        const mo = fromMatch[2], yr = fromMatch[3]
        const fullYr = yr.length === 2 ? '20' + yr : yr
        month = `${fullYr}-${mo.padStart(2,'0')}`
      }

      // Parse headers - Vyapar Stock Detail format:
      // Col 0: Item Code, Col 1: Item Name, Col 2: Unit, Col 3: Category
      // Col 4: Beginning Qty, Col 5: Qty In, Col 6: Purchase Amount
      // Col 7: Qty Out, Col 8: Sale Amount, Col 9: Closing Qty
      const hdr = (data[0] || []).map(h => String(h || '').toLowerCase())
      const nameI = hdr.findIndex(h => h.includes('item name'))
      const codeI = hdr.findIndex(h => h.includes('item code'))
      const catI = hdr.findIndex(h => h.includes('category'))
      const begI = hdr.findIndex(h => h.includes('beginn') || h.includes('begin'))
      const qinI = hdr.findIndex(h => h.includes('quantity in'))
      const pamtI = hdr.findIndex(h => h.includes('purchase amount'))
      const qoutI = hdr.findIndex(h => h.includes('quantity out'))
      const samtI = hdr.findIndex(h => h.includes('sale amount'))
      const clsI = hdr.findIndex(h => h.includes('closing'))

      // Fallback to fixed indices if header detection fails
      const ni = nameI >= 0 ? nameI : 1
      const ci = codeI >= 0 ? codeI : 0
      const cati = catI >= 0 ? catI : 3
      const bi = begI >= 0 ? begI : 4
      const qii = qinI >= 0 ? qinI : 5
      const pai = pamtI >= 0 ? pamtI : 6
      const qoi = qoutI >= 0 ? qoutI : 7
      const sai = samtI >= 0 ? samtI : 8
      const cli = clsI >= 0 ? clsI : 9

      const rows = []
      for (let i = 1; i < data.length; i++) {
        const row = data[i]
        if (!row || row.every(v => !v)) continue
        const name = String(row[ni] || '').trim()
        if (!name || name === 'Total' || name === 'Item Name') continue
        const qtyOut = parseFloat(String(row[qoi] || '').replace(/,/g,'')) || 0
        rows.push({
          month,
          item_code: String(row[ci] || '').trim(),
          item_name: name,
          category: String(row[cati] || '').trim(),
          beginning_qty: parseFloat(String(row[bi] || '').replace(/,/g,'')) || 0,
          qty_in: parseFloat(String(row[qii] || '').replace(/,/g,'')) || 0,
          purchase_amount: parseFloat(String(row[pai] || '').replace(/,/g,'')) || 0,
          qty_out: qtyOut,
          sale_amount: parseFloat(String(row[sai] || '').replace(/,/g,'')) || 0,
          closing_qty: parseFloat(String(row[cli] || '').replace(/,/g,'')) || 0,
        })
      }

      if (!rows.length) { toast('No data found in file. Check format.', 'error'); setUploadingWhat(''); return }

      setSyncStatus({ state: 'syncing', msg: `Saving ${rows.length} items for ${month}...` })

      // Delete existing for this month and re-insert
      await supabase.from('monthly_sales').delete().eq('month', month)
      const batchSize = 50
      for (let i = 0; i < rows.length; i += batchSize) {
        const { error } = await supabase.from('monthly_sales').insert(rows.slice(i, i + batchSize))
        if (error) { toast('Save failed: ' + error.message, 'error'); setSyncStatus({ state: 'error', msg: 'Failed' }); setUploadingWhat(''); return }
        setSyncStatus({ state: 'syncing', msg: `Saving... ${Math.min(i + batchSize, rows.length)}/${rows.length}` })
      }

      setSyncStatus({ state: 'ok', msg: `${month} uploaded ✓` })
      toast(`✓ ${rows.length} items saved for ${month}`, 'success')
      fetchAll()
    } catch (err) {
      toast('Upload failed: ' + err.message, 'error')
      setSyncStatus({ state: 'error', msg: 'Failed' })
    }
    setUploadingWhat('')
    e.target.value = ''
  }

  async function handlePricelistUpload(e) {
    const file = e.target.files[0]; if (!file) return
    const supplierName = window.prompt('Enter supplier name for this price list:', 'Prakruthivanam')
    if (!supplierName) { e.target.value = ''; return }
    setUploadingWhat('pricelist')
    setSyncStatus({ state: 'syncing', msg: 'Parsing price list...' })
    try {
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]] || wb.Sheets[wb.SheetNames[1]]
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })

      const rows = []
      let headerRow = -1
      for (let i = 0; i < data.length; i++) {
        const line = (data[i] || []).map(v => String(v||'').toLowerCase()).join(' ')
        if (line.includes('product') && (line.includes('price') || line.includes('dealer'))) {
          headerRow = i; break
        }
      }
      if (headerRow < 0) headerRow = 2 // fallback

      const hdr = (data[headerRow] || []).map(h => String(h||'').toLowerCase())
      const nameI = hdr.findIndex(h => h.includes('product') || h.includes('name'))
      const priceI = hdr.findIndex(h => h.includes('dealer price') || h.includes('dealer'))
      const mrpI = hdr.findIndex(h => h.includes('mrp'))
      const expiryI = hdr.findIndex(h => h.includes('expiry'))
      const stockI = hdr.findIndex(h => h.includes('stock'))
      const sizeI = hdr.findIndex(h => h.includes('size') || h.includes('weight') || h.includes('package'))

      const uploadDate = today()
      const month = thisMonth()

      for (let i = headerRow + 1; i < data.length; i++) {
        const row = data[i]
        const name = String(row[nameI] || '').trim()
        if (!name || name.length < 2) continue
        const stockVal = String(row[stockI] || '').toLowerCase()
        const inStock = !stockVal.includes('out')
        rows.push({
          supplier_name: supplierName, upload_date: uploadDate, month,
          product_name: name,
          package_size: sizeI >= 0 ? String(row[sizeI] || '').trim() : '',
          dealer_price: parseFloat(String(row[priceI] || '').replace(/,/g,'')) || 0,
          mrp: parseFloat(String(row[mrpI] || '').replace(/,/g,'')) || 0,
          expiry: expiryI >= 0 ? String(row[expiryI] || '').trim() : '',
          in_stock: inStock
        })
      }

      // Delete old pricelist for this supplier and re-insert
      await supabase.from('supplier_pricelists').delete().eq('supplier_name', supplierName)
      const batchSize = 100
      for (let i = 0; i < rows.length; i += batchSize) {
        await supabase.from('supplier_pricelists').insert(rows.slice(i, i + batchSize))
      }
      setSyncStatus({ state: 'ok', msg: 'Price list uploaded ✓' })
      toast(`${rows.length} products from ${supplierName} uploaded ✓`, 'success')
      fetchAll()
    } catch (err) {
      toast('Upload failed: ' + err.message, 'error')
      setSyncStatus({ state: 'error', msg: 'Failed' })
    }
    setUploadingWhat('')
    e.target.value = ''
  }

  async function saveParams() {
    for (const [key, value] of Object.entries(editParams)) {
      await supabase.from('planning_params').upsert({ key, value: parseFloat(value) || 0 }, { onConflict: 'key' })
    }
    setParamsModal(false)
    fetchAll()
    toast('Parameters saved ✓', 'success')
  }

  // ── Filtering ──────────────────────────────────
  const brands = [...new Set(orderItems.map(i => i.brand).filter(Boolean))].sort()
  const categories = [...new Set(orderItems.map(i => i.category).filter(Boolean))].sort()

  const filtered = useMemo(() => {
    let items = orderItems
    if (filters.status) items = items.filter(i => i.reorder_status === filters.status)
    if (filters.brand) items = items.filter(i => i.brand === filters.brand)
    if (filters.category) items = items.filter(i => i.category === filters.category)
    if (filters.search) items = items.filter(i => i.item_name.toLowerCase().includes(filters.search.toLowerCase()))
    return items.sort((a, b) => {
      const pa = STATUS_CONFIG[a.reorder_status]?.priority || 9
      const pb = STATUS_CONFIG[b.reorder_status]?.priority || 9
      return pa - pb || a.item_name.localeCompare(b.item_name)
    })
  }, [orderItems, filters])

  const toOrderCount = filtered.filter(i => i.final_qty > 0).length
  const estValue = filtered.filter(i => i.final_qty > 0).reduce((s, i) => s + (i.final_qty * (i.dealer_price || 0)), 0)
  const statusCounts = {}
  orderItems.forEach(i => { statusCounts[i.reorder_status] = (statusCounts[i.reorder_status] || 0) + 1 })

  // ── Sales Analytics ──────────────────────────────────
  const brandByName = useMemo(() => {
    const map = {}
    products.forEach(p => { map[normalise(p.name)] = p.brand || 'Unknown' })
    return map
  }, [products])

  const monthlyTrend = useMemo(() => {
    const map = {}
    salesHistory.forEach(s => {
      if (!map[s.month]) map[s.month] = { month: s.month, qty: 0, revenue: 0, items: new Set() }
      map[s.month].qty += s.qty_out || 0
      map[s.month].revenue += s.sale_amount || 0
      map[s.month].items.add(s.item_name)
    })
    return Object.values(map).sort((a, b) => a.month.localeCompare(b.month)).map(m => ({ ...m, itemCount: m.items.size }))
  }, [salesHistory])

  const itemAnalytics = useMemo(() => {
    const map = {}
    salesHistory.forEach(s => {
      const key = s.item_name
      if (!map[key]) map[key] = { item_name: key, category: s.category || '', qty: 0, revenue: 0, monthly: {} }
      map[key].qty += s.qty_out || 0
      map[key].revenue += s.sale_amount || 0
      map[key].monthly[s.month] = (map[key].monthly[s.month] || 0) + (s.qty_out || 0)
      if (s.category && !map[key].category) map[key].category = s.category
    })
    const monthsAll = salesMonths.length || 1
    const last3Months = salesMonths.slice(-3)
    return Object.values(map).map(item => {
      const avgMonthly = item.qty / monthsAll
      const last3Qtys = last3Months.map(m => item.monthly[m] || 0)
      const last3Avg = last3Months.length ? last3Qtys.reduce((s, v) => s + v, 0) / last3Months.length : avgMonthly
      let trend = 'unknown'
      if (avgMonthly > 0) {
        const ratio = last3Avg / avgMonthly
        trend = ratio >= 1.15 ? 'growing' : ratio <= 0.85 ? 'declining' : 'stable'
      }
      return {
        ...item,
        brand: brandByName[normalise(item.item_name)] || 'Unknown',
        avgMonthly: Math.round(avgMonthly * 10) / 10,
        last3Avg: Math.round(last3Avg * 10) / 10,
        trend,
        monthsActive: Object.keys(item.monthly).length
      }
    })
  }, [salesHistory, salesMonths, brandByName])

  const brandAnalytics = useMemo(() => {
    const map = {}
    itemAnalytics.forEach(item => {
      const b = item.brand || 'Unknown'
      if (!map[b]) map[b] = { brand: b, qty: 0, revenue: 0, itemCount: 0 }
      map[b].qty += item.qty
      map[b].revenue += item.revenue
      map[b].itemCount += 1
    })
    return Object.values(map)
  }, [itemAnalytics])

  const categoryAnalytics = useMemo(() => {
    const map = {}
    salesHistory.forEach(s => {
      const c = s.category || 'Uncategorized'
      if (!map[c]) map[c] = { category: c, qty: 0, revenue: 0 }
      map[c].qty += s.qty_out || 0
      map[c].revenue += s.sale_amount || 0
    })
    return Object.values(map)
  }, [salesHistory])

  const filteredItems = useMemo(() => {
    let list = itemAnalytics
    if (salesSearch) list = list.filter(i => i.item_name.toLowerCase().includes(salesSearch.toLowerCase()))
    return [...list].sort((a, b) => b[salesMetric] - a[salesMetric])
  }, [itemAnalytics, salesSearch, salesMetric])

  const sortedBrands = useMemo(() => [...brandAnalytics].sort((a, b) => b[salesMetric] - a[salesMetric]), [brandAnalytics, salesMetric])
  const sortedCategories = useMemo(() => [...categoryAnalytics].sort((a, b) => b[salesMetric] - a[salesMetric]), [categoryAnalytics, salesMetric])

  const totalQtyAllTime = salesHistory.reduce((s, r) => s + (r.qty_out || 0), 0)
  const totalRevenueAllTime = salesHistory.reduce((s, r) => s + (r.sale_amount || 0), 0)
  const avgMonthlyRevenue = totalRevenueAllTime / (salesMonths.length || 1)

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h2 className="section-title">📦 Order Planning</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => { setEditParams(Object.fromEntries(Object.entries(params).map(([k,v]) => [k, v]))); setParamsModal(true) }}>⚙️ Parameters</button>
          <button className="btn btn-secondary btn-sm" onClick={() => setActiveView(activeView === 'sales' ? 'plan' : 'sales')}>📊 {activeView === 'sales' ? '← Order Plan' : 'Sales History'}</button>
        </div>
      </div>

      {/* Upload bar */}
      <div className="card" style={{ padding: '14px 18px', marginBottom: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 12 }}>Data Uploads</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
          <UploadCard
            title="1. Export Items"
            subtitle="Vyapar → Items → Export"
            desc="Updates current stock, expiry, prices"
            loading={uploadingWhat === 'items'}
            accept=".xlsx,.xls"
            onChange={handleExportItemsUpload}
            badge={products.length ? `${products.length} products` : null}
          />
          <UploadCard
            title="2. Stock Detail Report"
            subtitle="Vyapar → Reports → Stock Detail"
            desc="Adds monthly sales history"
            loading={uploadingWhat === 'sales'}
            accept=".xlsx,.xls"
            onChange={handleSalesUpload}
            badge={salesMonths.length ? `${salesMonths.length} months: ${salesMonths.join(', ')}` : null}
          />
          <UploadCard
            title="3. Supplier Price List"
            subtitle="From supplier (optional)"
            desc="Adds dealer prices and availability"
            loading={uploadingWhat === 'pricelist'}
            accept=".xlsx,.xls"
            onChange={handlePricelistUpload}
            badge={supplierNames.length ? supplierNames.join(', ') : null}
          />
        </div>
      </div>

      {activeView === 'sales' ? (
        <div>
          {/* Overview stats */}
          <div className="stats-grid">
            <StatCard num={salesMonths.length} label="Months Uploaded" />
            <StatCard num={totalQtyAllTime.toLocaleString()} label="Total Units Sold" color="blue" />
            <StatCard num={fmt(totalRevenueAllTime)} label="Total Revenue" color="green" />
            <StatCard num={fmt(avgMonthlyRevenue)} label="Avg Monthly Revenue" color="amber" />
          </div>

          {salesMonths.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📊</div>
              <p>No sales data uploaded yet.<br />Upload Stock Detail Reports above to see trends.</p>
            </div>
          ) : (
            <>
              {/* Sub-nav + metric toggle */}
              <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {[['monthly', '📅 Monthly Trend'], ['items', '🏷️ Item-wise'], ['brands', '🏭 Brand-wise'], ['categories', '📂 Category-wise']].map(([id, label]) => (
                    <button key={id} className="btn btn-sm" onClick={() => setSalesView(id)}
                      style={{ background: salesView === id ? 'var(--brown-dark)' : 'var(--cream-dark)', color: salesView === id ? 'var(--gold)' : 'var(--brown-light)' }}>
                      {label}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', border: '1.5px solid var(--cream-dark)', borderRadius: 8, overflow: 'hidden' }}>
                  {[['revenue', '₹ Revenue'], ['qty', '📦 Qty']].map(([m, label]) => (
                    <button key={m} onClick={() => setSalesMetric(m)} style={{
                      padding: '7px 16px', border: 'none', fontFamily: 'inherit', fontSize: 12.5,
                      fontWeight: salesMetric === m ? 700 : 400, cursor: 'pointer',
                      background: salesMetric === m ? 'var(--brown-dark)' : 'var(--white)',
                      color: salesMetric === m ? 'var(--gold)' : 'var(--muted)'
                    }}>{label}</button>
                  ))}
                </div>
              </div>

              {salesView === 'monthly' && <MonthlyTrendChart data={monthlyTrend} metric={salesMetric} />}
              {salesView === 'items' && <ItemsTable items={filteredItems} metric={salesMetric} search={salesSearch} setSearch={setSalesSearch} />}
              {salesView === 'brands' && <RankTable rows={sortedBrands} nameKey="brand" metric={salesMetric} icon="🏭" />}
              {salesView === 'categories' && <RankTable rows={sortedCategories} nameKey="category" metric={salesMetric} icon="📂" />}
            </>
          )}
        </div>
      ) : (
        <>
          {/* Compute / action bar */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-primary" onClick={computeOrderPlan} disabled={computing}>
              {computing ? '⏳ Computing...' : '🔄 Compute Order Plan'}
            </button>
            {orderItems.length > 0 && <>
              {/* Delivery mode toggle */}
              <div style={{ display: 'flex', border: '1.5px solid var(--cream-dark)', borderRadius: 8, overflow: 'hidden' }}>
                {[['bus','🚌 Bus (lean)'],['vehicle','🚛 Vehicle (full)']].map(([mode, label]) => (
                  <button key={mode} onClick={() => applyDeliveryMode(mode)} style={{
                    padding: '8px 16px', border: 'none', fontFamily: 'inherit', fontSize: 13,
                    fontWeight: deliveryMode === mode ? 700 : 400, cursor: 'pointer',
                    background: deliveryMode === mode ? 'var(--brown-dark)' : 'var(--white)',
                    color: deliveryMode === mode ? 'var(--gold)' : 'var(--muted)'
                  }}>{label}</button>
                ))}
              </div>
              <button className="btn btn-secondary btn-sm" onClick={savePlan}>💾 Save Plan</button>
              <button className="btn btn-primary btn-sm" onClick={downloadOrderExcel}>⬇ Download Excel</button>
              {toOrderCount > 0 && (
                <div style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--brown-dark)' }}>
                  <strong>{toOrderCount}</strong> items to order · Est: <strong style={{ color: 'var(--green)' }}>{fmt(estValue)}</strong>
                </div>
              )}
            </>}
          </div>

          {/* Status summary pills */}
          {orderItems.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
              <button onClick={() => setFilters(f => ({ ...f, status: '' }))}
                style={{ padding: '4px 12px', borderRadius: 20, border: '1.5px solid var(--cream-dark)', background: !filters.status ? 'var(--brown-dark)' : 'var(--white)', color: !filters.status ? 'var(--gold)' : 'var(--muted)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer', fontWeight: !filters.status ? 700 : 400 }}>
                All ({orderItems.length})
              </button>
              {Object.entries(statusCounts).sort((a,b) => (STATUS_CONFIG[a[0]]?.priority||9) - (STATUS_CONFIG[b[0]]?.priority||9)).map(([status, count]) => {
                const cfg = STATUS_CONFIG[status] || {}
                return (
                  <button key={status} onClick={() => setFilters(f => ({ ...f, status: f.status === status ? '' : status }))}
                    style={{ padding: '4px 12px', borderRadius: 20, border: `1.5px solid ${cfg.color || 'var(--cream-dark)'}`, background: filters.status === status ? cfg.color : cfg.bg || 'var(--white)', color: filters.status === status ? 'white' : cfg.color, fontFamily: 'inherit', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>
                    {cfg.icon} {status} ({count})
                  </button>
                )
              })}
            </div>
          )}

          {/* Filters */}
          {orderItems.length > 0 && (
            <div className="filter-bar" style={{ marginBottom: 14 }}>
              <input placeholder="Search product..." value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} style={{ maxWidth: 220 }} />
              <select value={filters.brand} onChange={e => setFilters(f => ({ ...f, brand: e.target.value }))}>
                <option value="">All Brands</option>
                {brands.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
              <select value={filters.category} onChange={e => setFilters(f => ({ ...f, category: e.target.value }))}>
                <option value="">All Categories</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <button className="btn btn-secondary btn-sm" onClick={() => setFilters({ status: '', brand: '', category: '', search: '' })}>✕ Clear</button>
            </div>
          )}

          {/* Order plan table */}
          {loading ? <Loading /> : orderItems.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📦</div>
              <p>Upload your Vyapar exports above, then click<br /><strong>Compute Order Plan</strong> to see what to order.</p>
            </div>
          ) : (
            <div className="card table-wrap">
              <table className="data-table" style={{ minWidth: 1100, fontSize: 12.5 }}>
                <thead>
                  <tr>
                    <th style={{ minWidth: 200 }}>Product</th>
                    <th>Status</th>
                    <th>Stock</th>
                    <th>Avg/Month</th>
                    <th>Trend</th>
                    <th>Days Cover</th>
                    <th>Expiry</th>
                    <th>🚌 Bus</th>
                    <th>🚛 Vehicle</th>
                    <th style={{ background: 'var(--cream-warm)', minWidth: 110 }}>Final Qty</th>
                    <th>Dealer Price</th>
                    <th>Supplier Match</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(item => {
                    const cfg = STATUS_CONFIG[item.reorder_status] || {}
                    const trendIcon = TREND_ICON[item.trend] || '❓'
                    const mvColor = MOVEMENT_COLOR[item.movement] || 'var(--muted)'
                    return (
                      <tr key={item.item_name} style={{ opacity: ['Dead / No Sales','Expiry Stop Order'].includes(item.reorder_status) ? 0.5 : 1 }}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{item.item_name}</div>
                          <div style={{ fontSize: 11, color: 'var(--muted)' }}>{item.brand} · {item.category}</div>
                        </td>
                        <td>
                          <span style={{ background: cfg.bg, color: cfg.color, padding: '3px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
                            {cfg.icon} {item.reorder_status}
                          </span>
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: 600, color: (item.current_stock || 0) <= 0 ? 'var(--red)' : 'var(--text)' }}>
                          {item.current_stock}
                        </td>
                        <td style={{ textAlign: 'center', color: mvColor, fontWeight: 600 }}>
                          {item.avg_monthly_sales}
                          <div style={{ fontSize: 10, color: mvColor }}>{item.movement}</div>
                        </td>
                        <td style={{ textAlign: 'center' }}>{trendIcon} <small style={{ color: 'var(--muted)' }}>{item.last3m_avg}</small></td>
                        <td style={{ textAlign: 'center', color: (item.days_cover || 0) < 7 ? 'var(--red)' : (item.days_cover || 0) < 14 ? 'var(--amber)' : 'var(--green)', fontWeight: 600 }}>
                          {item.days_cover === 999 ? '∞' : item.days_cover + 'd'}
                        </td>
                        <td style={{ textAlign: 'center', fontSize: 11 }}>
                          {item.expiry_months ? (
                            <span style={{ color: item.expiry_risk === 'High' ? 'var(--red)' : item.expiry_risk === 'Medium' ? 'var(--amber)' : 'var(--green)' }}>
                              {item.expiry_months}mo<br />{item.expiry_risk}
                            </span>
                          ) : <span style={{ color: 'var(--muted)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'center', color: 'var(--muted)' }}>{item.bus_qty}</td>
                        <td style={{ textAlign: 'center', color: 'var(--muted)' }}>{item.vehicle_qty}</td>
                        <td style={{ background: 'var(--cream-warm)' }}>
                          <input type="number" value={item.final_qty} onChange={e => updateFinalQty(item.item_name, e.target.value)}
                            className="no-spinner"
                            onWheel={ev => ev.target.blur()}
                            style={{ width: 80, padding: '5px 8px', border: '1.5px solid var(--gold-mid)', borderRadius: 6, fontFamily: 'inherit', fontSize: 14, fontWeight: 700, textAlign: 'center', outline: 'none', background: item.final_qty > 0 ? 'var(--cream-warm)' : 'var(--white)', color: item.final_qty > 0 ? 'var(--brown-dark)' : 'var(--muted)' }} />
                        </td>
                        <td style={{ textAlign: 'right', fontSize: 12 }}>
                          {item.dealer_price ? `₹${item.dealer_price}` : <span style={{ color: 'var(--muted)' }}>—</span>}
                          {item.final_qty > 0 && item.dealer_price ? (
                            <div style={{ fontSize: 10, color: 'var(--muted)' }}>={fmt(item.final_qty * item.dealer_price)}</div>
                          ) : null}
                        </td>
                        <td style={{ fontSize: 11 }}>
                          {item.supplier_product_name ? (
                            <div>
                              <div style={{ color: 'var(--text)' }}>{item.supplier_product_name.slice(0, 30)}</div>
                              <div style={{ color: item.match_type === 'Exact' ? 'var(--green)' : item.match_type === 'Contains' ? 'var(--blue)' : 'var(--amber)' }}>
                                {item.match_type} · {item.supplier_in_stock == null ? '?' : item.supplier_in_stock ? '✅' : '❌ Out'}
                              </div>
                            </div>
                          ) : <span style={{ color: 'var(--muted)' }}>No match</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Parameters Modal */}
      <Modal open={paramsModal} onClose={() => setParamsModal(false)} title="⚙️ Planning Parameters" wide>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {Object.entries(editParams).map(([key, value]) => {
            const param = { lead_time_days: 'Lead Time (days)', fast_safety_days: 'Fast/Medium Safety Buffer (days)', slow_safety_days: 'Slow Item Safety Buffer (days)', expiry_high_max_days: 'High Expiry Max Stock (days)', expiry_medium_max_days: 'Medium Expiry Max Stock (days)', expiry_low_max_days: 'Low Expiry Max Stock (days)', dead_stock_threshold: 'Dead Stock Threshold (total units)', expiry_high_months: 'High Expiry Risk (≤ months)', expiry_medium_months: 'Medium Expiry Risk (≤ months)' }
            return (
              <FormGroup key={key} label={param[key] || key}>
                <input className="form-input no-spinner" type="number" value={value}
                  onChange={e => setEditParams(p => ({ ...p, [key]: e.target.value }))}
                  onWheel={ev => ev.target.blur()} />
              </FormGroup>
            )
          })}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setParamsModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={saveParams}>Save Parameters</button>
        </div>
      </Modal>
    </div>
  )
}

function UploadCard({ title, subtitle, desc, loading, accept, onChange, badge }) {
  return (
    <div style={{ background: 'var(--cream)', borderRadius: 'var(--r)', padding: '14px 16px', border: loading ? '2px solid var(--gold)' : '2px solid transparent', transition: 'border .3s' }}>
      <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--brown-dark)', marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>{subtitle}</div>
      <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: 10 }}>{desc}</div>
      {badge && <div style={{ fontSize: 11, background: 'var(--green-l)', color: 'var(--green)', padding: '3px 8px', borderRadius: 6, marginBottom: 8, fontWeight: 600, wordBreak: 'break-word' }}>✓ {badge}</div>}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--amber)', fontSize: 12, fontWeight: 600 }}>
          <div style={{ width: 16, height: 16, border: '2px solid var(--amber)', borderTop: '2px solid transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
          Uploading... please wait
        </div>
      ) : (
        <label className="btn btn-primary btn-sm" style={{ cursor: 'pointer', display: 'inline-flex' }}>
          ⬆ Upload
          <input type="file" accept={accept} onChange={onChange} style={{ display: 'none' }} />
        </label>
      )}
    </div>
  )
}

// ── Sales Analytics components ──────────────────────────
function BarCell({ value, max, color, display }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: 'var(--cream)', borderRadius: 3, overflow: 'hidden', minWidth: 50 }}>
        <div style={{ width: `${Math.min(100, (value / max) * 100)}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 70, textAlign: 'right', whiteSpace: 'nowrap' }}>{display}</span>
    </div>
  )
}

function MonthlyTrendChart({ data, metric }) {
  const max = Math.max(...data.map(d => d[metric] || 0), 1)
  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 230, overflowX: 'auto', paddingTop: 8 }}>
        {data.map(d => {
          const h = Math.max(4, (d[metric] / max) * 180)
          return (
            <div key={d.month} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 64, flex: '1 0 64px' }}>
              <div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 4, fontWeight: 600, whiteSpace: 'nowrap' }}>
                {metric === 'revenue' ? fmt(d.revenue) : d.qty.toLocaleString()}
              </div>
              <div title={`${d.month}: ${metric === 'revenue' ? fmt(d.revenue) : d.qty + ' units'}`} style={{
                width: '100%', maxWidth: 46, height: h,
                background: 'linear-gradient(180deg, var(--gold) 0%, var(--gold-mid) 100%)',
                borderRadius: '6px 6px 0 0'
              }} />
              <div style={{ fontSize: 11.5, color: 'var(--brown-dark)', fontWeight: 700, marginTop: 8 }}>{d.month}</div>
              <div style={{ fontSize: 10, color: 'var(--muted)' }}>{d.itemCount} items</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ItemsTable({ items, metric, search, setSearch }) {
  const max = Math.max(...items.map(i => i[metric] || 0), 1)
  return (
    <div>
      <div className="filter-bar">
        <input placeholder="Search item..." value={search} onChange={e => setSearch(e.target.value)} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{items.length} products</span>
      </div>
      <div className="card table-wrap">
        <table className="data-table" style={{ minWidth: 900 }}>
          <thead>
            <tr>
              <th>#</th><th style={{ minWidth: 200 }}>Product</th><th>Brand</th><th>Category</th>
              <th>Qty Sold</th><th>Revenue</th><th>Avg/Month</th><th>Trend</th>
            </tr>
          </thead>
          <tbody>
            {items.slice(0, 200).map((item, idx) => (
              <tr key={item.item_name}>
                <td>{idx + 1}</td>
                <td style={{ fontWeight: 600 }}>{item.item_name}</td>
                <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{item.brand}</td>
                <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{item.category || '—'}</td>
                <td>
                  {metric === 'qty'
                    ? <BarCell value={item.qty} max={max} color="var(--blue)" display={item.qty.toLocaleString()} />
                    : item.qty.toLocaleString()}
                </td>
                <td style={{ fontWeight: 600, color: 'var(--green)' }}>
                  {metric === 'revenue'
                    ? <BarCell value={item.revenue} max={max} color="var(--green)" display={fmt(item.revenue)} />
                    : fmt(item.revenue)}
                </td>
                <td style={{ textAlign: 'center' }}>{item.avgMonthly}</td>
                <td style={{ textAlign: 'center' }}>{TREND_ICON[item.trend] || '❓'} <small style={{ color: 'var(--muted)' }}>{item.last3Avg}</small></td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length > 200 && (
          <div style={{ padding: 12, textAlign: 'center', fontSize: 12, color: 'var(--muted)' }}>
            Showing top 200 of {items.length} — refine search to see more.
          </div>
        )}
      </div>
    </div>
  )
}

function RankTable({ rows, nameKey, metric, icon }) {
  const max = Math.max(...rows.map(r => r[metric] || 0), 1)
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0)
  return (
    <div className="card table-wrap">
      <table className="data-table" style={{ minWidth: 600 }}>
        <thead>
          <tr>
            <th>#</th><th>{nameKey === 'brand' ? 'Brand' : 'Category'}</th>
            {nameKey === 'brand' && <th>Items</th>}
            <th>Qty Sold</th><th>Revenue</th><th>% of Revenue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={r[nameKey]}>
              <td>{idx + 1}</td>
              <td style={{ fontWeight: 600 }}>{icon} {r[nameKey] || 'Unknown'}</td>
              {nameKey === 'brand' && <td style={{ textAlign: 'center', color: 'var(--muted)' }}>{r.itemCount}</td>}
              <td>
                {metric === 'qty'
                  ? <BarCell value={r.qty} max={max} color="var(--blue)" display={r.qty.toLocaleString()} />
                  : r.qty.toLocaleString()}
              </td>
              <td style={{ fontWeight: 600, color: 'var(--green)' }}>
                {metric === 'revenue'
                  ? <BarCell value={r.revenue} max={max} color="var(--green)" display={fmt(r.revenue)} />
                  : fmt(r.revenue)}
              </td>
              <td style={{ color: 'var(--muted)', fontSize: 12 }}>{totalRevenue ? ((r.revenue / totalRevenue) * 100).toFixed(1) : '0.0'}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
