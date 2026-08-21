import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Loading } from '../components/ui'
import { fmt, thisMonth } from '../lib/utils'

const EXP_CATEGORIES = [
  { id: 'staff', label: 'Staff & HR', icon: '👥' },
  { id: 'premises', label: 'Premises', icon: '🏠' },
  { id: 'utilities', label: 'Utilities', icon: '⚡' },
  { id: 'logistics', label: 'Logistics', icon: '🚚' },
  { id: 'marketing', label: 'Marketing', icon: '📢' },
  { id: 'admin', label: 'Admin & Bank', icon: '🏦' },
  { id: 'other', label: 'Other', icon: '📦' },
]

export default function ProfitLoss({ user, toast, setSyncStatus }) {
  const [month, setMonth] = useState(thisMonth())
  const [loading, setLoading] = useState(true)
  const [plData, setPlData] = useState(null)
  const [overrides, setOverrides] = useState({})
  const [editingLine, setEditingLine] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [stockInputs, setStockInputs] = useState({ opening: '', closing: '' })

  useEffect(() => { loadPL() }, [month])

  async function loadPL() {
    setLoading(true)

    // Load all data in parallel
    const [
      { data: closings },
      { data: payments },
      { data: expenses },
      { data: bankTxns },
      { data: plRecord }
    ] = await Promise.all([
      supabase.from('counter_closing').select('total_sale, date').gte('date', month + '-01').lte('date', month + '-31'),
      supabase.from('payments').select('bill_amount, date, grn_status').gte('date', month + '-01').lte('date', month + '-31'),
      supabase.from('expenses').select('amount, category').gte('date', month + '-01').lte('date', month + '-31'),
      supabase.from('bank_transactions').select('category, deposit, withdrawal').eq('month', month).eq('is_business', true),
      supabase.from('pl_months').select('*').eq('month', month).maybeSingle()
    ])

    // Compute auto values
    const grossSales = (closings || []).reduce((s, c) => s + (c.total_sale || 0), 0)
    const purchases = (payments || []).reduce((s, p) => s + (p.bill_amount || 0), 0)

    // Gateway charges from bank reconciliation
    // Expected = sum of paytm/card/shiprocket from counter closing
    // Actual = sum from bank statement
    // Difference = gateway charges
    const actualPaytm = (bankTxns || []).filter(t => t.category === 'paytm').reduce((s, t) => s + (t.deposit || 0), 0)
    const actualCard = (bankTxns || []).filter(t => t.category === 'card').reduce((s, t) => s + (t.deposit || 0), 0)
    const actualShiprocket = (bankTxns || []).filter(t => t.category === 'shiprocket').reduce((s, t) => s + (t.deposit || 0), 0)
    const actualShipmozo = (bankTxns || []).filter(t => t.category === 'shipmozo').reduce((s, t) => s + (t.deposit || 0), 0)
    const bankCharges = (bankTxns || []).filter(t => t.category === 'bank_charges').reduce((s, t) => s + (t.withdrawal || 0), 0)

    // Expenses by category
    const expByCategory = {}
    EXP_CATEGORIES.forEach(c => {
      expByCategory[c.id] = (expenses || []).filter(e => e.category === c.id).reduce((s, e) => s + (e.amount || 0), 0)
    })

    // Saved overrides and stock values
    const savedOverrides = plRecord?.overrides || {}
    const openingStock = parseFloat(plRecord?.opening_stock) || 0
    const closingStock = parseFloat(plRecord?.closing_stock) || 0

    setOverrides(savedOverrides)
    setStockInputs({ opening: openingStock || '', closing: closingStock || '' })

    // Build P&L with override support
    function val(key, computed) {
      return savedOverrides[key] !== undefined ? savedOverrides[key] : computed
    }

    const gs = val('gross_sales', grossSales)
    const gc = val('gateway_charges', actualPaytm > 0 || actualCard > 0 ? (grossSales - actualPaytm - actualCard - actualShiprocket - actualShipmozo) : 0)
    const nr = gs - gc
    const os = openingStock
    const pur = val('purchases', purchases)
    const cs = closingStock
    const cogs = os + pur - cs
    const gp = nr - cogs

    const totalExpenses = EXP_CATEGORIES.reduce((s, c) => s + val('exp_' + c.id, expByCategory[c.id] || 0), 0)
      + val('bank_charges', bankCharges)
    const netProfit = gp - totalExpenses

    setPlData({
      grossSales: gs, gatewayCc: gc, netRevenue: nr,
      openingStock: os, purchases: pur, closingStock: cs, cogs, grossProfit: gp,
      expByCategory, bankCharges,
      totalExpenses, netProfit,
      // raw for reference
      raw: { grossSales, purchases, expByCategory, bankCharges, actualPaytm, actualCard }
    })
    setLoading(false)
  }

  async function saveOverride(key, value) {
    const newOverrides = { ...overrides, [key]: parseFloat(value) || 0 }
    setOverrides(newOverrides)
    setSaving(true)
    await supabase.from('pl_months').upsert({
      month,
      overrides: newOverrides,
      opening_stock: parseFloat(stockInputs.opening) || 0,
      closing_stock: parseFloat(stockInputs.closing) || 0,
      updated_at: new Date().toISOString()
    }, { onConflict: 'month' })
    setSaving(false)
    setEditingLine(null)
    toast('Override saved ✓', 'success')
    loadPL()
  }

  async function saveStocks() {
    setSaving(true)
    const cur = overrides
    await supabase.from('pl_months').upsert({
      month,
      overrides: cur,
      opening_stock: parseFloat(stockInputs.opening) || 0,
      closing_stock: parseFloat(stockInputs.closing) || 0,
      updated_at: new Date().toISOString()
    }, { onConflict: 'month' })
    setSaving(false)
    toast('Stock values saved ✓', 'success')
    loadPL()
  }

  function resetOverride(key) {
    const newOverrides = { ...overrides }
    delete newOverrides[key]
    setOverrides(newOverrides)
    supabase.from('pl_months').upsert({ month, overrides: newOverrides, updated_at: new Date().toISOString() }, { onConflict: 'month' })
    loadPL()
  }

  if (loading) return <Loading />
  if (!plData) return null

  const isOverridden = key => overrides[key] !== undefined

  function PLRow({ label, value, keyName, indent, bold, highlight, positive, negative, borderTop, muted }) {
    const editing = editingLine === keyName
    const overridden = keyName && isOverridden(keyName)
    return (
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr auto auto', alignItems: 'center',
        padding: `${indent ? 7 : 10}px ${indent ? 32 : 20}px`,
        background: highlight === 'profit' ? 'var(--green-l)' : highlight === 'loss' ? 'var(--red-l)' : highlight === 'section' ? 'var(--cream-warm)' : 'var(--white)',
        borderTop: borderTop ? '2px solid var(--gold)' : '1px solid var(--cream)',
        gap: 12
      }}>
        <span style={{ fontSize: indent ? 13 : 14, fontWeight: bold ? 700 : 400, color: muted ? 'var(--muted)' : 'var(--text)' }}>
          {indent && <span style={{ color: 'var(--muted)' }}>└ </span>}{label}
          {overridden && <span style={{ fontSize: 10, background: 'var(--amber-l)', color: 'var(--amber)', padding: '1px 6px', borderRadius: 8, marginLeft: 6, fontWeight: 700 }}>EDITED</span>}
        </span>
        {editing ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="number" value={editValue} onChange={e => setEditValue(e.target.value)}
              style={{ width: 120, padding: '5px 8px', border: '1.5px solid var(--gold-mid)', borderRadius: 6, fontFamily: 'inherit', fontSize: 14, fontWeight: 700, textAlign: 'right', outline: 'none' }}
              autoFocus onKeyDown={e => { if (e.key === 'Enter') saveOverride(keyName, editValue); if (e.key === 'Escape') setEditingLine(null) }} />
            <button onClick={() => saveOverride(keyName, editValue)} style={{ background: 'var(--green)', color: 'white', border: 'none', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 12 }}>✓</button>
            <button onClick={() => setEditingLine(null)} style={{ background: 'var(--cream-dark)', color: 'var(--muted)', border: 'none', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 12 }}>✕</button>
          </div>
        ) : (
          <span style={{
            fontSize: bold ? 18 : indent ? 13.5 : 15, fontWeight: bold ? 700 : 500,
            color: positive ? 'var(--green)' : negative ? 'var(--red)' : bold ? 'var(--brown-dark)' : 'var(--text)',
            fontFamily: bold ? "'Playfair Display', serif" : 'inherit'
          }}>{fmt(value)}</span>
        )}
        {keyName && !editing ? (
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={() => { setEditingLine(keyName); setEditValue(value) }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 13, padding: '2px 5px', borderRadius: 4 }} title="Override">✏️</button>
            {overridden && <button onClick={() => resetOverride(keyName)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red-l)', fontSize: 12, padding: '2px 5px' }} title="Reset to auto">↩️</button>}
          </div>
        ) : <div />}
      </div>
    )
  }

  function SectionHeader({ label, color }) {
    return (
      <div style={{ background: 'var(--brown-dark)', padding: '9px 20px', color: 'var(--gold)', fontWeight: 700, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.6px' }}>
        {label}
      </div>
    )
  }

  const np = plData.netProfit
  const npPositive = np > 0

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h2 className="section-title">📊 Profit & Loss</h2>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {saving && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Saving...</span>}
          <input type="month" value={month} onChange={e => setMonth(e.target.value)}
            style={{ padding: '7px 10px', border: '1.5px solid var(--cream-dark)', borderRadius: 8, fontFamily: 'inherit', fontSize: 13, background: 'var(--white)', outline: 'none' }} />
        </div>
      </div>

      {/* Net profit summary */}
      <div style={{ background: npPositive ? 'var(--green-l)' : 'var(--red-l)', border: `2px solid ${npPositive ? 'var(--green)' : 'var(--red)'}`, borderRadius: 'var(--r)', padding: '16px 24px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: npPositive ? 'var(--green)' : 'var(--red)' }}>
            {npPositive ? '✅ Net Profit' : '⚠️ Net Loss'} — {month}
          </div>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 36, fontWeight: 700, color: npPositive ? 'var(--green)' : 'var(--red)', lineHeight: 1.2 }}>
            {fmt(Math.abs(np))}
          </div>
        </div>
        <div style={{ fontSize: 12, color: npPositive ? 'var(--green)' : 'var(--red)', textAlign: 'right' }}>
          <div>Gross Profit: {fmt(plData.grossProfit)}</div>
          <div>Total Expenses: {fmt(plData.totalExpenses)}</div>
          <div style={{ marginTop: 4, fontSize: 10, color: 'var(--muted)' }}>✏️ Click any row to override</div>
        </div>
      </div>

      {/* Stock inputs */}
      <div className="card" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--brown-dark)', marginBottom: 12 }}>📦 Stock Values — Enter Manually</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 12, alignItems: 'flex-end' }}>
          <div>
            <label className="form-label">Opening Stock (₹)</label>
            <input className="form-input" type="number" value={stockInputs.opening} onChange={e => setStockInputs(s => ({ ...s, opening: e.target.value }))} placeholder="0.00" />
          </div>
          <div>
            <label className="form-label">Closing Stock (₹)</label>
            <input className="form-input" type="number" value={stockInputs.closing} onChange={e => setStockInputs(s => ({ ...s, closing: e.target.value }))} placeholder="0.00" />
          </div>
          <button className="btn btn-primary" onClick={saveStocks}>Save</button>
        </div>
      </div>

      {/* P&L Statement */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <SectionHeader label="Revenue" />
        <PLRow label="Gross Sales" value={plData.grossSales} keyName="gross_sales" bold />
        <PLRow label="Less: Gateway & Settlement Charges" value={plData.gatewayCc} keyName="gateway_charges" indent negative />
        <PLRow label="Net Revenue" value={plData.netRevenue} bold borderTop />

        <SectionHeader label="Cost of Goods Sold" />
        <PLRow label="Opening Stock" value={plData.openingStock} muted indent />
        <PLRow label="Add: Purchases (from Payments tab)" value={plData.purchases} keyName="purchases" indent />
        <PLRow label="Less: Closing Stock" value={plData.closingStock} muted indent />
        <PLRow label="Cost of Goods Sold" value={plData.cogs} bold />
        <PLRow label="Gross Profit" value={plData.grossProfit} bold borderTop highlight={plData.grossProfit > 0 ? 'profit' : 'loss'} positive={plData.grossProfit > 0} negative={plData.grossProfit < 0} />

        <SectionHeader label="Operating Expenses" />
        {EXP_CATEGORIES.map(c => (
          <PLRow key={c.id} label={`${c.icon} ${c.label}`} value={overrides['exp_' + c.id] !== undefined ? overrides['exp_' + c.id] : (plData.expByCategory[c.id] || 0)} keyName={'exp_' + c.id} indent negative />
        ))}
        <PLRow label="🏦 Bank Charges" value={overrides.bank_charges !== undefined ? overrides.bank_charges : plData.bankCharges} keyName="bank_charges" indent negative />
        <PLRow label="Total Expenses" value={plData.totalExpenses} bold borderTop negative />

        <SectionHeader label="Bottom Line" />
        <PLRow label={npPositive ? '✅ Net Profit' : '⚠️ Net Loss'} value={Math.abs(np)} bold borderTop highlight={npPositive ? 'profit' : 'loss'} positive={npPositive} negative={!npPositive} />
      </div>

      <div style={{ marginTop: 12, padding: '10px 14px', background: 'var(--cream)', borderRadius: 'var(--rs)', fontSize: 12, color: 'var(--muted)' }}>
        💡 Values are auto-pulled from Counter Closing, Payments tab, Expenses tab and Bank Statement. Click ✏️ on any row to override. Click ↩️ to restore the auto value.
      </div>
    </div>
  )
}
