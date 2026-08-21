import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { StatCard, Loading, useConfirm, Modal } from '../components/ui'
import { fmt, fmtDate, today, thisMonth, DENOMS } from '../lib/utils'
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth, parseISO } from 'date-fns'

// ── Default field configs ──────────────────
const DEFAULT_PAYS = [
  { id: 'card', lbl: 'Credit Card' },
  { id: 'paytm', lbl: 'Paytm / UPI' },
  { id: 'delivery', lbl: 'Delivery App' },
  { id: 'neft', lbl: 'NEFT / Bank Transfer' },
]
const DEFAULT_EXPS = [
  { id: 'xtravel', lbl: 'Transport Expense' },
  { id: 'xstore', lbl: 'Store Expense' },
]

async function saveFields(key, fields) {
  await supabase.from('settings').upsert({ key, value: JSON.stringify(fields) }, { onConflict: 'key' })
}

export default function CounterClosing({ user, toast, setSyncStatus }) {
  const [closings, setClosings] = useState([])
  const [loading, setLoading] = useState(true)
  const [histMonth, setHistMonth] = useState(thisMonth())
  const { confirm, ConfirmDialog } = useConfirm()

  // Form state
  const [date, setDate] = useState(today())
  const [sale, setSale] = useState('')
  const [open, setOpen] = useState('')
  const [dep, setDep] = useState('')
  const [notes, setNotes] = useState('')
  const [pays, setPays] = useState({})
  const [exps, setExps] = useState({})
  const [denoms, setDenoms] = useState({})
  const [payFields, setPayFields] = useState(DEFAULT_PAYS)
  const [expFields, setExpFields] = useState(DEFAULT_EXPS)
  const [editingDate, setEditingDate] = useState(null)
  const [expModal, setExpModal] = useState(null)
  const [expItems, setExpItems] = useState({})
  const [expBuf, setExpBuf] = useState([])
  const [newExpItem, setNewExpItem] = useState({ desc: '', amt: '' })
  const [renameModal, setRenameModal] = useState(null) // { type: 'pay'|'exp', field }
  const [renameLbl, setRenameLbl] = useState('')

  // Stats filter
  const [statPeriod, setStatPeriod] = useState('month')
  const [statFrom, setStatFrom] = useState('')
  const [statTo, setStatTo] = useState('')

  // Computed values
  const totalSale = parseFloat(sale) || 0
  const ncTotal = payFields.reduce((s, f) => s + (parseFloat(pays[f.id]) || 0), 0)
  const expTotal = expFields.reduce((s, f) => s + (parseFloat(exps[f.id]) || 0), 0)
  const cashSales = totalSale - ncTotal
  const openBal = parseFloat(open) || 0
  const depAmt = parseFloat(dep) || 0
  const expected = cashSales + openBal - expTotal - depAmt
  const actual = DENOMS.reduce((s, d) => s + (parseInt(denoms[d]) || 0) * d, 0)
  const variance = actual - expected
  const varClass = totalSale === 0 && actual === 0 ? '' : Math.abs(variance) < 0.01 ? 'balanced' : variance < 0 ? 'shortage' : 'excess'

  const todayStr = today()
  const yest = new Date(); yest.setDate(yest.getDate() - 1)
  const yStr = yest.toISOString().slice(0, 10)
  const threeDaysAgo = new Date(); threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)
  const threeStr = threeDaysAgo.toISOString().slice(0, 10)
  const canEdit = user.role === 'manager' || date >= threeStr

  useEffect(() => { fetchClosings(); fetchFields() }, [])

  async function fetchFields() {
    const { data } = await supabase.from('settings').select('key,value').in('key', ['cc_pay_fields', 'cc_exp_fields'])
    if (data) {
      data.forEach(row => {
        try {
          const parsed = JSON.parse(row.value)
          if (row.key === 'cc_pay_fields') setPayFields(parsed)
          if (row.key === 'cc_exp_fields') setExpFields(parsed)
        } catch {}
      })
    }
  }

  async function fetchClosings() {
    const { data } = await supabase.from('counter_closing').select('*').order('date', { ascending: false })
    const rows = data || []
    setClosings(rows)
    setLoading(false)
    // Auto-fill opening balance for today if no existing record
    const todayRec = rows.find(c => c.date === todayStr)
    if (!todayRec) {
      // No closing for today yet — auto-fill from most recent previous day
      const prev = rows.find(c => c.date < todayStr)
      if (prev) {
        const bal = (prev.actual_cash || 0) - (prev.cash_deposited || 0)
        setOpen(bal.toFixed(2))
      }
    } else {
      // Today's record exists — load it
      loadRecord(todayRec)
    }
  }

  function clearForm() {
    setSale(''); setOpen(''); setDep(''); setNotes('')
    setPays({}); setExps({}); setDenoms({}); setExpItems({})
    setEditingDate(null)
  }

  function loadRecord(rec) {
    setSale(rec.total_sale?.toString() || '')
    setOpen(rec.opening_balance?.toString() || '')
    setDep(rec.cash_deposited?.toString() || '')
    setNotes(rec.notes || '')
    try { setPays(rec.pay_breakdown ? JSON.parse(rec.pay_breakdown) : {}) } catch { setPays({}) }
    try { setExps(rec.exp_breakdown ? JSON.parse(rec.exp_breakdown) : {}) } catch { setExps({}) }
    try { setDenoms(rec.denom_breakdown ? JSON.parse(rec.denom_breakdown) : {}) } catch { setDenoms({}) }
    try { setExpItems(rec.exp_items_detail ? JSON.parse(rec.exp_items_detail) : {}) } catch { setExpItems({}) }
    setEditingDate(rec.date)
  }

  function onDateChange(d) {
    setDate(d)
    const rec = closings.find(c => c.date === d)
    if (rec) {
      loadRecord(rec)
    } else {
      clearForm()
      const prev = closings.find(c => c.date < d)
      if (prev) {
        const bal = (prev.actual_cash || 0) - (prev.cash_deposited || 0)
        setOpen(bal.toFixed(2))
      }
    }
  }

  async function submit() {
    if (!date || !totalSale) { toast('Enter date and total sale.', 'error'); return }
    if (!canEdit) { toast('Staff can only enter data for the last 3 days.', 'error'); return }
    setSyncStatus({ state: 'syncing', msg: 'Saving...' })
    const { error } = await supabase.from('counter_closing').upsert({
      date, total_sale: totalSale, non_cash: ncTotal, expenses: expTotal,
      cash_sales: cashSales, opening_balance: openBal, cash_deposited: depAmt,
      expected_cash: expected, actual_cash: actual, variance,
      pay_breakdown: JSON.stringify(pays),
      exp_breakdown: JSON.stringify(exps),
      denom_breakdown: JSON.stringify(denoms),
      exp_items_detail: JSON.stringify(expItems),
      notes, status: user.role === 'manager' ? 'approved' : 'submitted',
      submitted_by: user.role,
    }, { onConflict: 'date' })
    if (error) { toast('Save failed: ' + error.message, 'error'); setSyncStatus({ state: 'error', msg: 'Failed' }); return }
    setSyncStatus({ state: 'ok', msg: 'Saved ✓' })
    toast('Counter closing saved ✓', 'success')
    setEditingDate(date)
    fetchClosings()
    sendWhatsApp({ date, totalSale, ncTotal, expTotal, cashSales, openBal, depAmt, expected, actual, variance, submittedBy: user.role })
  }

  async function sendWhatsApp({ date, totalSale, ncTotal, expTotal, cashSales, openBal, depAmt, expected, actual, variance, submittedBy }) {
    try {
      const { data } = await supabase.from('settings').select('key,value').in('key', ['wa_token', 'wa_phone_id', 'wa_recipient'])
      if (!data || data.length < 3) return
      const s = {}
      data.forEach(r => { s[r.key] = r.value })
      if (!s.wa_token || !s.wa_phone_id || !s.wa_recipient) return
      const varIcon = Math.abs(variance) < 0.01 ? 'Balanced' : variance < 0 ? 'Short Rs.' + Math.abs(variance).toFixed(2) : 'Excess Rs.' + variance.toFixed(2)
      const msg = '🌿 Prakruthivanam — Counter Closing\nDate: ' + date + '\n\nTotal Sale: Rs.' + totalSale.toLocaleString('en-IN') + '\nNon-Cash: Rs.' + ncTotal.toLocaleString('en-IN') + '\nExpenses: Rs.' + expTotal.toLocaleString('en-IN') + '\nCash from Sales: Rs.' + cashSales.toLocaleString('en-IN') + '\n\nOpening Balance: Rs.' + openBal.toLocaleString('en-IN') + '\nExpected: Rs.' + expected.toLocaleString('en-IN') + '\nActual Counted: Rs.' + actual.toLocaleString('en-IN') + '\nVariance: ' + varIcon + '\n\nSubmitted by: ' + (submittedBy === 'manager' ? 'Manager' : 'Staff')
      const res = await fetch('https://graph.facebook.com/v18.0/' + s.wa_phone_id + '/messages', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + s.wa_token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: s.wa_recipient, type: 'text', text: { body: msg } })
      })
      const json = await res.json()
      console.log('WhatsApp response:', json)
      if (res.ok) console.log('WhatsApp sent successfully')
      else console.error('WhatsApp failed:', json.error)
    } catch (err) { console.error('WhatsApp error:', err) }
  }

  async function approve(id) {
    await supabase.from('counter_closing').update({ status: 'approved', approved_at: new Date().toISOString() }).eq('id', id)
    fetchClosings(); toast('Approved ✓', 'success')
  }

  async function del(id) {
    const ok = await confirm('Delete this record?'); if (!ok) return
    await supabase.from('counter_closing').delete().eq('id', id)
    fetchClosings(); toast('Deleted.')
  }

  // Field management
  function addPayField(lbl) {
    const n = [...payFields, { id: 'p' + Date.now(), lbl }]
    setPayFields(n); saveFields('cc_pay_fields', n)
  }
  function removePayField(id) {
    const n = payFields.filter(f => f.id !== id)
    setPayFields(n); saveFields('cc_pay_fields', n)
  }
  function renamePayField(id, lbl) {
    const n = payFields.map(f => f.id === id ? { ...f, lbl } : f)
    setPayFields(n); saveFields('cc_pay_fields', n)
  }
  function addExpField(lbl) {
    const n = [...expFields, { id: 'e' + Date.now(), lbl }]
    setExpFields(n); saveFields('cc_exp_fields', n)
  }
  function removeExpField(id) {
    const n = expFields.filter(f => f.id !== id)
    setExpFields(n); saveFields('cc_exp_fields', n)
  }
  function renameExpField(id, lbl) {
    const n = expFields.map(f => f.id === id ? { ...f, lbl } : f)
    setExpFields(n); saveFields('cc_exp_fields', n)
  }

  // Expense itemisation
  function openExpModal(field) {
    setExpModal(field)
    setExpBuf(expItems[field.id] ? [...expItems[field.id]] : [])
    setNewExpItem({ desc: '', amt: '' })
  }
  function addExpItem() {
    if (!newExpItem.desc || !newExpItem.amt) return
    setExpBuf(prev => [...prev, { desc: newExpItem.desc, amt: parseFloat(newExpItem.amt) }])
    setNewExpItem({ desc: '', amt: '' })
  }
  function confirmExpModal() {
    const total = expBuf.reduce((s, i) => s + i.amt, 0)
    setExpItems(prev => ({ ...prev, [expModal.id]: expBuf }))
    setExps(prev => ({ ...prev, [expModal.id]: total.toFixed(2) }))
    setExpModal(null)
  }

  // Stats computation
  function getStatRange() {
    const now = new Date()
    if (statPeriod === 'today') return { from: todayStr, to: todayStr }
    if (statPeriod === 'week') return { from: format(startOfWeek(now, { weekStartsOn: 1 }), 'yyyy-MM-dd'), to: format(endOfWeek(now, { weekStartsOn: 1 }), 'yyyy-MM-dd') }
    if (statPeriod === 'month') return { from: format(startOfMonth(now), 'yyyy-MM-dd'), to: format(endOfMonth(now), 'yyyy-MM-dd') }
    if (statPeriod === 'custom') return { from: statFrom, to: statTo }
    return { from: '', to: '' }
  }

  const { from: statFromDate, to: statToDate } = getStatRange()
  const statClosings = closings.filter(c => {
    if (!statFromDate || !statToDate) return true
    return c.date >= statFromDate && c.date <= statToDate
  })

  const statTotalSale = statClosings.reduce((s, c) => s + (c.total_sale || 0), 0)
  const statNcTotal = statClosings.reduce((s, c) => s + (c.non_cash || 0), 0)
  const statExpTotal = statClosings.reduce((s, c) => s + (c.expenses || 0), 0)
  const statCashSales = statClosings.reduce((s, c) => s + (c.cash_sales || 0), 0)
  const statVariance = statClosings.reduce((s, c) => s + (c.variance || 0), 0)
  const statShortDays = statClosings.filter(c => (c.variance || 0) < -0.01).length
  const statExcessDays = statClosings.filter(c => (c.variance || 0) > 0.01).length

  // Pay breakdown for stats
  const statPayBreakdown = {}
  payFields.forEach(f => {
    statPayBreakdown[f.id] = statClosings.reduce((s, c) => {
      try { const pb = JSON.parse(c.pay_breakdown || '{}'); return s + (parseFloat(pb[f.id]) || 0) } catch { return s }
    }, 0)
  })

  const hist = closings.filter(c => (c.date || '').slice(0, 7) === histMonth)
  const varColor = varClass === 'balanced' ? 'var(--green)' : varClass === 'shortage' ? 'var(--red)' : varClass === 'excess' ? 'var(--amber)' : 'var(--muted)'
  const varBg = varClass === 'balanced' ? 'var(--green-l)' : varClass === 'shortage' ? 'var(--red-l)' : varClass === 'excess' ? 'var(--amber-l)' : 'var(--cream-dark)'

  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <ConfirmDialog />

      {/* ── Stats / Summary ── */}
      <div className="card" style={{ padding: '14px 18px', marginBottom: 18 }}>
        {/* Period selector */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--brown-light)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Summary:</span>
          {['today', 'week', 'month', 'custom'].map(p => (
            <button key={p} onClick={() => setStatPeriod(p)} style={{
              padding: '4px 12px', border: `1.5px solid ${statPeriod === p ? 'var(--gold-mid)' : 'var(--cream-dark)'}`,
              borderRadius: 20, background: statPeriod === p ? 'var(--cream-warm)' : 'var(--white)',
              fontFamily: 'inherit', fontSize: 12, fontWeight: statPeriod === p ? 700 : 500,
              color: statPeriod === p ? 'var(--brown-dark)' : 'var(--muted)', cursor: 'pointer'
            }}>{p === 'today' ? 'Today' : p === 'week' ? 'This Week' : p === 'month' ? 'This Month' : 'Custom'}</button>
          ))}
          {statPeriod === 'custom' && (
            <>
              <input type="date" value={statFrom} onChange={e => setStatFrom(e.target.value)}
                style={{ padding: '4px 8px', border: '1.5px solid var(--cream-dark)', borderRadius: 8, fontFamily: 'inherit', fontSize: 12, outline: 'none' }} />
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>to</span>
              <input type="date" value={statTo} onChange={e => setStatTo(e.target.value)}
                style={{ padding: '4px 8px', border: '1.5px solid var(--cream-dark)', borderRadius: 8, fontFamily: 'inherit', fontSize: 12, outline: 'none' }} />
            </>
          )}
          <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>{statClosings.length} closing{statClosings.length !== 1 ? 's' : ''}</span>
        </div>

        {/* Stats grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
          <StatBox label="Total Sales" value={fmt(statTotalSale)} color="var(--green)" />
          <StatBox label="Non-Cash" value={fmt(statNcTotal)} color="var(--blue)" />
          <StatBox label="Cash Sales" value={fmt(statCashSales)} color="var(--gold-mid)" />
          <StatBox label="Expenses" value={fmt(statExpTotal)} color="var(--amber)" />
          <StatBox label="Variance" value={fmt(statVariance)} color={statVariance < -0.01 ? 'var(--red)' : statVariance > 0.01 ? 'var(--amber)' : 'var(--green)'} />
          <StatBox label="Shortage Days" value={statShortDays} color="var(--red)" small />
          <StatBox label="Excess Days" value={statExcessDays} color="var(--amber)" small />
          {payFields.map(f => (
            <StatBox key={f.id} label={f.lbl} value={fmt(statPayBreakdown[f.id] || 0)} color="var(--muted)" small />
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) min(390px,100%)', gap: 16, alignItems: 'start' }}>
        {/* LEFT — Form */}
        <div className="card">
          <div style={{ background: 'var(--brown-dark)', padding: '11px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '2px solid var(--gold)' }}>
            <span style={{ fontWeight: 700, fontSize: 11.5, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '.5px' }}>💳 Sales & Cash</span>
            <input type="date" value={date} onChange={e => onDateChange(e.target.value)}
              style={{ padding: '4px 8px', border: '1px solid var(--gold-mid)', borderRadius: 6, fontFamily: 'inherit', fontSize: 12, background: 'var(--brown-mid)', color: 'var(--gold)', outline: 'none' }} />
          </div>
          {editingDate && <div style={{ padding: '7px 16px', background: 'var(--amber-l)', fontSize: 12, color: 'var(--amber)', borderBottom: '1px solid var(--cream)' }}>✏️ Editing: {editingDate}</div>}

          <CCRow label="Total Sale" bold total><NumIn value={sale} onChange={setSale} /></CCRow>

          {/* Non-cash payments */}
          <GroupLabel>Non-Cash Payments</GroupLabel>
          {payFields.map(f => (
            <CCRow key={f.id} label={
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {user.role === 'manager' && <>
                  <Xbtn onClick={() => removePayField(f.id)} />
                  <button onClick={() => { setRenameModal({ type: 'pay', field: f }); setRenameLbl(f.lbl) }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 11, padding: '0 2px' }} title="Rename">✏️</button>
                </>}
                {f.lbl}
              </span>
            }>
              <NumIn value={pays[f.id] || ''} onChange={v => setPays(p => ({ ...p, [f.id]: v }))} />
            </CCRow>
          ))}
          <CCRow label="Non-Cash Total" computed><span style={{ textAlign: 'right', fontWeight: 700, color: 'var(--gold-mid)', display: 'block' }}>{fmt(ncTotal)}</span></CCRow>
          {user.role === 'manager' && <AddFieldRow placeholder="Add payment type..." onAdd={addPayField} />}

          {/* Expenses */}
          <GroupLabel>Expenses</GroupLabel>
          {expFields.map(f => (
            <CCRow key={f.id} label={
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {user.role === 'manager' && <>
                  <Xbtn onClick={() => removeExpField(f.id)} />
                  <button onClick={() => { setRenameModal({ type: 'exp', field: f }); setRenameLbl(f.lbl) }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 11, padding: '0 2px' }} title="Rename">✏️</button>
                </>}
                {f.lbl}
                <button onClick={() => openExpModal(f)} style={{ background: 'var(--blue-l)', color: 'var(--blue)', border: 'none', borderRadius: 4, padding: '1px 6px', fontSize: 10, cursor: 'pointer' }}>📋</button>
              </span>
            }>
              <NumIn value={exps[f.id] || ''} onChange={v => setExps(p => ({ ...p, [f.id]: v }))} />
            </CCRow>
          ))}
          {user.role === 'manager' && <AddFieldRow placeholder="Add expense type..." onAdd={addExpField} />}

          {/* Cash calculation */}
          <GroupLabel>Cash Calculation</GroupLabel>
          <CCRow label="Cash from Sales" computed>
            <span style={{ textAlign: 'right', fontWeight: 700, display: 'block', color: cashSales < 0 ? 'var(--red)' : 'var(--text)' }}>{fmt(cashSales)}</span>
          </CCRow>
          <CCRow label="Opening Balance"><NumIn value={open} onChange={setOpen} /></CCRow>
          <CCRow label="Cash Deposited to Bank"><NumIn value={dep} onChange={setDep} /></CCRow>
          <CCRow label="✅ Expected in Counter" bold total>
            <span style={{ textAlign: 'right', fontSize: 17, fontWeight: 700, display: 'block', color: expected < 0 ? 'var(--red)' : 'var(--brown-dark)' }}>
              {expected < 0 ? '-' : ''}{fmt(Math.abs(expected))}
            </span>
          </CCRow>
        </div>

        {/* RIGHT — Denominations */}
        <div style={{ position: 'sticky', top: 110 }}>
          <div className="card">
            <div style={{ background: 'var(--brown-dark)', padding: '11px 16px', borderBottom: '2px solid var(--gold)', fontWeight: 700, fontSize: 11.5, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '.5px' }}>💵 Count the Cash</div>
            <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr 85px', gap: 5, padding: '5px 13px', fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', background: 'var(--cream)', borderBottom: '1px solid var(--cream-dark)' }}>
              <span>Note</span><span style={{ textAlign: 'center' }}>Qty</span><span style={{ textAlign: 'right' }}>Amount</span>
            </div>
            {DENOMS.map(d => {
              const qty = parseInt(denoms[d]) || 0
              return (
                <div key={d} style={{ display: 'grid', gridTemplateColumns: '60px 1fr 85px', gap: 5, alignItems: 'center', padding: '4px 13px', borderBottom: '1px solid var(--cream)' }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--brown-dark)' }}>₹{d}</span>
                  <input type="number" min={0} value={denoms[d] || ''} onChange={e => setDenoms(p => ({ ...p, [d]: e.target.value }))}
                    onWheel={e => e.target.blur()} className="no-spinner"
                    style={{ padding: '4px 6px', border: '1.5px solid var(--cream-dark)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13, textAlign: 'center', outline: 'none', background: 'var(--white)', width: '100%' }} />
                  <span style={{ textAlign: 'right', fontSize: 12, fontWeight: 600, color: qty > 0 ? 'var(--brown-dark)' : 'var(--muted)' }}>{qty > 0 ? fmt(qty * d) : '—'}</span>
                </div>
              )
            })}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', padding: '9px 13px', background: 'var(--cream-warm)', borderTop: '2px solid var(--gold)' }}>
              <span style={{ fontWeight: 700, fontSize: 12.5 }}>Total Counted</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--brown-dark)' }}>{fmt(actual)}</span>
            </div>

            {/* Variance */}
            <div style={{ margin: '11px 13px', borderRadius: 10, padding: 13, textAlign: 'center', background: varBg }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: varColor, marginBottom: 3 }}>Variance</div>
              <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 26, fontWeight: 700, color: varColor }}>
                {!varClass ? '—' : (variance < 0 ? '-' : '') + fmt(Math.abs(variance))}
              </div>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: varColor, marginTop: 2 }}>
                {!varClass ? 'Enter values above' : varClass === 'balanced' ? '✅ Balanced!' : varClass === 'shortage' ? `Short by ${fmt(Math.abs(variance))}` : `Excess ${fmt(variance)}`}
              </div>
            </div>

            <div style={{ padding: '0 13px 13px' }}>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes..."
                style={{ width: '100%', padding: '8px 11px', border: '1.5px solid var(--cream-dark)', borderRadius: 8, fontFamily: 'inherit', fontSize: 13, resize: 'vertical', minHeight: 48, outline: 'none', marginBottom: 8, background: 'var(--white)' }} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={submit} disabled={!canEdit} className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }}>
                  {!canEdit ? '🔒 Manager Only' : '✅ Submit Closing'}
                </button>
                <button onClick={clearForm} className="btn btn-secondary">🔄</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* History */}
      <div style={{ marginTop: 22 }}>
        <div className="section-header">
          <h2 className="section-title" style={{ fontSize: 18 }}>📅 Closing History</h2>
          <input type="month" value={histMonth} onChange={e => setHistMonth(e.target.value)}
            style={{ padding: '6px 10px', border: '1.5px solid var(--cream-dark)', borderRadius: 8, fontFamily: 'inherit', fontSize: 12.5, background: 'var(--white)', outline: 'none' }} />
        </div>
        <div className="card table-wrap">
          <table className="data-table">
            <thead><tr><th>Date</th><th>Total Sale</th><th>Non-Cash</th><th>Expenses</th><th>Cash Sales</th><th>Opening</th><th>Expected</th><th>Counted</th><th>Variance</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={11}><Loading /></td></tr>
                : hist.length === 0 ? <tr><td colSpan={11} style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>No closings for this period.</td></tr>
                : hist.map(c => {
                  const v = c.variance || 0
                  const vp = Math.abs(v) < 0.01 ? 'pill-approved' : v < 0 ? 'pill-unpaid' : 'pill-open'
                  const vl = Math.abs(v) < 0.01 ? 'Balanced' : v < 0 ? `-${fmt(Math.abs(v))}` : `+${fmt(v)}`
                  return (
                    <tr key={c.id}>
                      <td><button onClick={() => { setDate(c.date); loadRecord(c) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--blue)', fontWeight: 700, textDecoration: 'underline', fontSize: 13, padding: 0 }}>{fmtDate(c.date)}</button></td>
                      <td>{fmt(c.total_sale)}</td>
                      <td>{fmt(c.non_cash)}</td>
                      <td>{fmt(c.expenses)}</td>
                      <td style={{ color: (c.cash_sales || 0) < 0 ? 'var(--red)' : 'inherit' }}>{fmt(c.cash_sales)}</td>
                      <td>{fmt(c.opening_balance)}</td>
                      <td style={{ color: (c.expected_cash || 0) < 0 ? 'var(--red)' : 'inherit' }}>{fmt(c.expected_cash)}</td>
                      <td>{fmt(c.actual_cash)}</td>
                      <td><span className={`pill ${vp}`}>{vl}</span></td>
                      <td><span className={`pill ${c.status === 'approved' ? 'pill-approved' : 'pill-submitted'}`}>{c.status === 'approved' ? '✓ Approved' : '⏳ Pending'}</span></td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {user.role === 'manager' && c.status === 'submitted' && <button className="btn btn-sm" style={{ background: 'var(--green-l)', color: 'var(--green)', marginRight: 4 }} onClick={() => approve(c.id)}>✅</button>}
                        {user.role === 'manager' && <button className="btn btn-sm btn-danger" onClick={() => del(c.id)}>🗑</button>}
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Expense detail modal */}
      {expModal && (
        <Modal open={!!expModal} onClose={() => setExpModal(null)} title={`📋 ${expModal.lbl}`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12, maxHeight: 240, overflowY: 'auto' }}>
            {expBuf.length === 0 ? <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: 16 }}>No items yet.</p>
              : expBuf.map((item, idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--cream)', padding: '8px 12px', borderRadius: 8 }}>
                  <span style={{ flex: 1, fontSize: 13 }}>{item.desc}</span>
                  <span style={{ fontWeight: 700 }}>{fmt(item.amt)}</span>
                  <button onClick={() => setExpBuf(p => p.filter((_, i) => i !== idx))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', fontSize: 14 }}>✕</button>
                </div>
              ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px auto', gap: 8, marginBottom: 12 }}>
            <input className="form-input" value={newExpItem.desc} onChange={e => setNewExpItem(p => ({ ...p, desc: e.target.value }))} placeholder="Description" onKeyDown={e => e.key === 'Enter' && addExpItem()} />
            <input className="form-input" type="number" value={newExpItem.amt} onChange={e => setNewExpItem(p => ({ ...p, amt: e.target.value }))} placeholder="₹" onKeyDown={e => e.key === 'Enter' && addExpItem()} />
            <button className="btn btn-primary" onClick={addExpItem}>+</button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', background: 'var(--cream-warm)', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
            <span style={{ fontWeight: 700 }}>Total</span>
            <span style={{ fontWeight: 700 }}>{fmt(expBuf.reduce((s, i) => s + i.amt, 0))}</span>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setExpModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={confirmExpModal}>✓ Confirm</button>
          </div>
        </Modal>
      )}

      {/* Rename modal */}
      {renameModal && (
        <Modal open={!!renameModal} onClose={() => setRenameModal(null)} title="✏️ Rename Field">
          <div style={{ marginBottom: 16 }}>
            <label className="form-label">New Name</label>
            <input className="form-input" value={renameLbl} onChange={e => setRenameLbl(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  if (renameModal.type === 'pay') renamePayField(renameModal.field.id, renameLbl)
                  else renameExpField(renameModal.field.id, renameLbl)
                  setRenameModal(null)
                }
              }}
              autoFocus />
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setRenameModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => {
              if (renameModal.type === 'pay') renamePayField(renameModal.field.id, renameLbl)
              else renameExpField(renameModal.field.id, renameLbl)
              setRenameModal(null)
            }}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── Helpers ────────────────────────────────
function StatBox({ label, value, color, small }) {
  return (
    <div style={{ background: 'var(--cream)', borderRadius: 'var(--rs)', padding: '10px 13px', borderLeft: `3px solid ${color}` }}>
      <div style={{ fontFamily: small ? 'inherit' : "'Playfair Display', serif", fontSize: small ? 16 : 20, fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px' }}>{label}</div>
    </div>
  )
}

function CCRow({ label, children, computed, total, bold }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 150px', alignItems: 'center', padding: '7px 16px', minHeight: 40, background: computed || total ? 'var(--cream-warm)' : 'var(--white)', borderTop: total ? '2px solid var(--gold)' : 'none', borderBottom: '1px solid var(--cream)' }}>
      <span style={{ fontSize: 13, fontWeight: bold || total ? 700 : 400 }}>{label}</span>
      <div>{children}</div>
    </div>
  )
}

function GroupLabel({ children }) {
  return (
    <div style={{ padding: '6px 16px 2px', fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', background: 'var(--cream)', borderBottom: '1px solid var(--cream-dark)' }}>
      {children}
    </div>
  )
}

function NumIn({ value, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', border: '1.5px solid var(--cream-dark)', borderRadius: 8, overflow: 'hidden', background: 'var(--white)' }}>
      <span style={{ padding: '0 6px', fontSize: 12, color: 'var(--muted)', fontWeight: 600, background: 'var(--cream-dark)', alignSelf: 'stretch', display: 'flex', alignItems: 'center' }}>₹</span>
      <input type="number" value={value} onChange={e => onChange(e.target.value)} placeholder="0" min={0}
        onWheel={e => e.target.blur()} className="no-spinner"
        style={{ width: '100%', padding: '7px 8px', border: 'none', background: 'transparent', fontFamily: 'inherit', fontSize: 14, fontWeight: 500, outline: 'none', textAlign: 'right' }} />
    </div>
  )
}

function Xbtn({ onClick }) {
  return <button onClick={onClick} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red-l)', fontSize: 12, lineHeight: 1, padding: 0 }}
    onMouseOver={e => e.target.style.color = 'var(--red)'} onMouseOut={e => e.target.style.color = 'var(--red-l)'}>✕</button>
}

function AddFieldRow({ placeholder, onAdd }) {
  const [val, setVal] = useState('')
  function add() { if (val.trim()) { onAdd(val.trim()); setVal('') } }
  return (
    <div style={{ padding: '7px 16px', display: 'flex', gap: 7, borderBottom: '1px solid var(--cream-dark)', background: 'var(--cream)' }}>
      <input value={val} onChange={e => setVal(e.target.value)} placeholder={placeholder} onKeyDown={e => e.key === 'Enter' && add()}
        style={{ flex: 1, padding: '5px 9px', border: '1.5px dashed var(--cream-dark)', borderRadius: 8, fontFamily: 'inherit', fontSize: 12, background: 'transparent', outline: 'none' }} />
      <button onClick={add} style={{ padding: '5px 11px', background: 'var(--cream-warm)', color: 'var(--brown-dark)', border: 'none', borderRadius: 8, fontFamily: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>+ Add</button>
    </div>
  )
}
