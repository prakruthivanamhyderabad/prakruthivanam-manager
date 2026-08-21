import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Modal, FormGroup, FormRow, StatCard, Loading, useConfirm } from '../components/ui'
import { Autocomplete } from '../components/ui'
import { fmt, fmtDate, today, thisMonth, SUPPLIERS } from '../lib/utils'

const MODES = ['Bank Transfer', 'Cash', 'UPI', 'Cheque', 'NEFT', 'RTGS']
const GST_TYPES = [
  { value: 'none', label: 'No GST Invoice' },
  { value: 'cgst_sgst', label: 'CGST + SGST (Intra-state)' },
  { value: 'igst', label: 'IGST (Inter-state)' },
]

export default function Payments({ user, toast, setSyncStatus }) {
  const [payments, setPayments] = useState([])
  const [entries, setEntries] = useState({}) // paymentId -> [entries]
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(false)
  const [payModal, setPayModal] = useState(null) // payment record to add entry to
  const [expandedId, setExpandedId] = useState(null)
  const { confirm, ConfirmDialog } = useConfirm()
  const [filters, setFilters] = useState({ supplier: '', status: '', from: '', to: '' })

  const emptyForm = {
    id: null, date: today(), bill_no: '', supplier: '', brand: '',
    taxable_value: '', gst_type: 'cgst_sgst',
    igst_amount: '', cgst_amount: '', sgst_amount: '',
    transport_charge: '', category: '', grn_status: 'Pending', notes: ''
  }
  const [form, setForm] = useState(emptyForm)

  const emptyEntry = { date: today(), amount: '', mode: 'Bank Transfer', reference: '', notes: '' }
  const [entryForm, setEntryForm] = useState(emptyEntry)

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    const [{ data: pays }, { data: ents }] = await Promise.all([
      supabase.from('payments').select('*').order('date', { ascending: false }),
      supabase.from('payment_entries').select('*').order('date', { ascending: true })
    ])
    setPayments(pays || [])
    // Group entries by payment_id
    const entMap = {}
    ents?.forEach(e => {
      if (!entMap[e.payment_id]) entMap[e.payment_id] = []
      entMap[e.payment_id].push(e)
    })
    setEntries(entMap)
    setLoading(false)
  }

  // Computed fields
  function calcTotals(f) {
    const taxable = parseFloat(f.taxable_value) || 0
    const igst = parseFloat(f.igst_amount) || 0
    const cgst = parseFloat(f.cgst_amount) || 0
    const sgst = parseFloat(f.sgst_amount) || 0
    const transport = parseFloat(f.transport_charge) || 0
    const totalItc = f.gst_type === 'igst' ? igst : f.gst_type === 'cgst_sgst' ? cgst + sgst : 0
    const totalInvoice = taxable + igst + cgst + sgst + transport
    return { totalItc, totalInvoice }
  }

  function openNew() { setForm(emptyForm); setModal(true) }
  function openEdit(p) {
    setForm({
      id: p.id, date: p.date || today(), bill_no: p.bill_no || '',
      supplier: p.supplier || '', brand: p.brand || '',
      taxable_value: p.taxable_value || '', gst_type: p.gst_type || 'cgst_sgst',
      igst_amount: p.igst_amount || '', cgst_amount: p.cgst_amount || '',
      sgst_amount: p.sgst_amount || '', transport_charge: p.transport_charge || '',
      category: p.category || '', grn_status: p.grn_status || 'Pending', notes: p.notes || ''
    })
    setModal(true)
  }

  function updateForm(field, value) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  async function save() {
    if (!form.bill_no || !form.supplier || !form.taxable_value) {
      toast('Fill bill number, supplier and taxable value.', 'error'); return
    }
    setSyncStatus({ state: 'syncing', msg: 'Saving...' })
    const { totalItc, totalInvoice } = calcTotals(form)
    const payload = {
      date: form.date, bill_no: form.bill_no, supplier: form.supplier,
      brand: form.brand, category: form.category,
      taxable_value: parseFloat(form.taxable_value) || 0,
      gst_type: form.gst_type,
      igst_amount: parseFloat(form.igst_amount) || 0,
      cgst_amount: parseFloat(form.cgst_amount) || 0,
      sgst_amount: parseFloat(form.sgst_amount) || 0,
      transport_charge: parseFloat(form.transport_charge) || 0,
      total_itc: totalItc,
      bill_amount: totalInvoice,
      grn_status: form.grn_status, notes: form.notes,
      updated_at: new Date().toISOString()
    }
    if (form.id) {
      await supabase.from('payments').update(payload).eq('id', form.id)
    } else {
      await supabase.from('payments').insert({ ...payload, payment_status: 'unpaid', amount_paid: 0, balance: totalInvoice })
    }
    setSyncStatus({ state: 'ok', msg: 'Saved ✓' })
    setModal(false); fetchAll(); toast('Invoice saved ✓', 'success')
  }

  async function saveEntry() {
    if (!entryForm.amount || !entryForm.date) { toast('Enter date and amount.', 'error'); return }
    setSyncStatus({ state: 'syncing', msg: 'Saving payment...' })
    await supabase.from('payment_entries').insert({
      payment_id: payModal.id,
      date: entryForm.date,
      amount: parseFloat(entryForm.amount),
      mode: entryForm.mode,
      reference: entryForm.reference,
      notes: entryForm.notes
    })
    // Recalculate paid total
    const existingEntries = entries[payModal.id] || []
    const newTotal = existingEntries.reduce((s, e) => s + (e.amount || 0), 0) + parseFloat(entryForm.amount)
    const balance = (payModal.bill_amount || 0) - newTotal
    const status = balance <= 0 ? 'paid' : newTotal > 0 ? 'partial' : 'unpaid'
    await supabase.from('payments').update({ amount_paid: newTotal, balance: Math.max(0, balance), payment_status: status }).eq('id', payModal.id)
    setSyncStatus({ state: 'ok', msg: 'Payment saved ✓' })
    setPayModal(null); setEntryForm(emptyEntry); fetchAll()
    toast('Payment recorded ✓', 'success')
  }

  async function delEntry(entryId, paymentId) {
    const ok = await confirm('Delete this payment entry?'); if (!ok) return
    await supabase.from('payment_entries').delete().eq('id', entryId)
    // Recalculate
    const pay = payments.find(p => p.id === paymentId)
    const remaining = (entries[paymentId] || []).filter(e => e.id !== entryId)
    const newTotal = remaining.reduce((s, e) => s + (e.amount || 0), 0)
    const balance = (pay?.bill_amount || 0) - newTotal
    const status = balance <= 0 ? 'paid' : newTotal > 0 ? 'partial' : 'unpaid'
    await supabase.from('payments').update({ amount_paid: newTotal, balance: Math.max(0, balance), payment_status: status }).eq('id', paymentId)
    fetchAll(); toast('Deleted.')
  }

  async function del(id) {
    const ok = await confirm('Delete this invoice record?'); if (!ok) return
    await supabase.from('payments').delete().eq('id', id)
    fetchAll(); toast('Deleted.')
  }

  function exportCSV() {
    const h = ['Date', 'Supplier', 'Brand', 'Bill No', 'Taxable Value', 'GST Type', 'IGST', 'CGST', 'SGST', 'Transport', 'Total ITC', 'Total Invoice', 'GRN Status', 'Payment Status', 'Amount Paid', 'Balance', 'Category', 'Notes']
    const rows = payments.map(p => [p.date, p.supplier, p.brand || '', p.bill_no, p.taxable_value, p.gst_type, p.igst_amount || 0, p.cgst_amount || 0, p.sgst_amount || 0, p.transport_charge || 0, p.total_itc || 0, p.bill_amount, p.grn_status, p.payment_status, p.amount_paid || 0, p.balance || 0, p.category || '', p.notes || ''])
    const csv = [h, ...rows].map(r => r.map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a'); a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv); a.download = 'payments.csv'; a.click()
    toast('Exported ✓', 'success')
  }

  // Filter
  let filtered = payments
  if (filters.supplier) filtered = filtered.filter(p => p.supplier === filters.supplier)
  if (filters.status) filtered = filtered.filter(p => p.payment_status === filters.status)
  if (filters.from) filtered = filtered.filter(p => p.date >= filters.from)
  if (filters.to) filtered = filtered.filter(p => p.date <= filters.to)

  const totalOutstanding = payments.filter(p => p.payment_status !== 'paid').reduce((s, p) => s + (p.balance || 0), 0)
  const totalItcMonth = payments.filter(p => (p.date || '').slice(0, 7) === thisMonth()).reduce((s, p) => s + (p.total_itc || 0), 0)
  const suppliers = [...new Set(payments.map(p => p.supplier))].sort()
  const { totalItc: formItc, totalInvoice: formTotal } = calcTotals(form)

  return (
    <div>
      <ConfirmDialog />
      <div className="stats-grid">
        <StatCard num={payments.filter(p => p.payment_status === 'unpaid').length} label="Unpaid" color="red" />
        <StatCard num={payments.filter(p => p.payment_status === 'partial').length} label="Partial" color="amber" />
        <StatCard num={payments.filter(p => p.payment_status === 'paid').length} label="Paid" color="green" />
        <div className="stat-card blue">
          <div className="stat-num" style={{ fontSize: 18, marginTop: 4 }}>{fmt(totalOutstanding)}</div>
          <div className="stat-label">Outstanding</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, padding: '10px 14px', background: 'var(--cream-warm)', borderRadius: 'var(--rs)', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>This month ITC:</span>
        <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--green)' }}>{fmt(totalItcMonth)}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 12 }}>feeds → GST Filing tab automatically</span>
      </div>

      <div className="section-header">
        <h2 className="section-title">💰 Supplier Invoices</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={exportCSV}>⬇ CSV</button>
          <button className="btn btn-primary" onClick={openNew}>＋ Add Invoice</button>
        </div>
      </div>

      <div className="filter-bar">
        <select value={filters.supplier} onChange={e => setFilters({ ...filters, supplier: e.target.value })}>
          <option value="">All Suppliers</option>
          {suppliers.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}>
          <option value="">All Statuses</option>
          <option value="unpaid">Unpaid</option>
          <option value="partial">Partial</option>
          <option value="paid">Paid</option>
        </select>
        <input type="date" style={{ maxWidth: 150 }} value={filters.from} onChange={e => setFilters({ ...filters, from: e.target.value })} />
        <input type="date" style={{ maxWidth: 150 }} value={filters.to} onChange={e => setFilters({ ...filters, to: e.target.value })} />
        <button className="btn btn-secondary btn-sm" onClick={() => setFilters({ supplier: '', status: '', from: '', to: '' })}>✕ Clear</button>
      </div>

      {loading ? <Loading /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.length === 0 ? (
            <div className="empty-state"><div className="empty-icon">💰</div><p>No invoices yet. Click "+ Add Invoice" to start.</p></div>
          ) : filtered.map(p => {
            const pEntries = entries[p.id] || []
            const isExpanded = expandedId === p.id
            const statusColor = p.payment_status === 'paid' ? 'var(--green)' : p.payment_status === 'partial' ? 'var(--amber)' : 'var(--red)'
            const statusBg = p.payment_status === 'paid' ? 'var(--green-l)' : p.payment_status === 'partial' ? 'var(--amber-l)' : 'var(--red-l)'
            return (
              <div key={p.id} className="card animate-fade" style={{ overflow: 'hidden' }}>
                {/* Invoice header */}
                <div style={{ padding: '13px 16px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', cursor: 'pointer' }}
                  onClick={() => setExpandedId(isExpanded ? null : p.id)}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 5 }}>
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{p.supplier}</span>
                      <code style={{ fontSize: 11, background: 'var(--cream-dark)', padding: '1px 6px', borderRadius: 4 }}>{p.bill_no}</code>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{fmtDate(p.date)}</span>
                      {p.brand && <span style={{ fontSize: 12, color: 'var(--muted)' }}>· {p.brand}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5 }}>
                      <span>Invoice: <strong>{fmt(p.bill_amount)}</strong></span>
                      {p.total_itc > 0 && <span style={{ color: 'var(--green)' }}>ITC: <strong>{fmt(p.total_itc)}</strong></span>}
                      {p.transport_charge > 0 && <span style={{ color: 'var(--muted)' }}>Transport: {fmt(p.transport_charge)}</span>}
                      <span style={{ background: statusBg, color: statusColor, padding: '1px 8px', borderRadius: 10, fontWeight: 700, fontSize: 11, textTransform: 'uppercase' }}>{p.payment_status}</span>
                      <span style={{ background: p.grn_status === 'Completed' ? 'var(--green-l)' : 'var(--amber-l)', color: p.grn_status === 'Completed' ? 'var(--green)' : 'var(--amber)', padding: '1px 8px', borderRadius: 10, fontWeight: 700, fontSize: 11 }}>GRN: {p.grn_status}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>Balance</div>
                      <div style={{ fontWeight: 700, fontSize: 16, color: (p.balance || 0) > 0 ? 'var(--red)' : 'var(--green)' }}>{fmt(p.balance || 0)}</div>
                    </div>
                    <button className="btn btn-primary btn-sm" onClick={e => { e.stopPropagation(); setPayModal(p); setEntryForm(emptyEntry) }}>+ Pay</button>
                    <button className="btn btn-sm" style={{ background: 'var(--sage-pale)', color: 'var(--sage-dark)' }} onClick={e => { e.stopPropagation(); openEdit(p) }}>✏️</button>
                    <button className="btn btn-sm btn-danger" onClick={e => { e.stopPropagation(); del(p.id) }}>🗑</button>
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>

                {/* Invoice breakdown */}
                {isExpanded && (
                  <div style={{ borderTop: '1px solid var(--cream)', background: 'var(--cream)' }}>
                    {/* GST breakdown */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px,1fr))', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--cream-dark)' }}>
                      <BrkItem label="Taxable Value" value={fmt(p.taxable_value || 0)} />
                      {p.gst_type === 'igst' && <BrkItem label="IGST" value={fmt(p.igst_amount || 0)} color="var(--blue)" />}
                      {p.gst_type === 'cgst_sgst' && <>
                        <BrkItem label="CGST" value={fmt(p.cgst_amount || 0)} color="var(--blue)" />
                        <BrkItem label="SGST" value={fmt(p.sgst_amount || 0)} color="var(--blue)" />
                      </>}
                      {p.transport_charge > 0 && <BrkItem label="Transport" value={fmt(p.transport_charge || 0)} />}
                      <BrkItem label="Total ITC" value={fmt(p.total_itc || 0)} color="var(--green)" bold />
                      <BrkItem label="Invoice Total" value={fmt(p.bill_amount || 0)} bold />
                    </div>

                    {/* Payment entries */}
                    <div style={{ padding: '12px 16px' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 8 }}>Payment History</div>
                      {pEntries.length === 0 ? (
                        <div style={{ fontSize: 13, color: 'var(--muted)', fontStyle: 'italic' }}>No payments recorded yet.</div>
                      ) : pEntries.map(e => (
                        <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', background: 'var(--white)', borderRadius: 'var(--rs)', marginBottom: 6, fontSize: 13 }}>
                          <span style={{ color: 'var(--muted)', fontSize: 12 }}>{fmtDate(e.date)}</span>
                          <span style={{ fontWeight: 700, color: 'var(--green)' }}>{fmt(e.amount)}</span>
                          <span style={{ color: 'var(--muted)' }}>{e.mode}</span>
                          {e.reference && <code style={{ fontSize: 11, background: 'var(--cream-dark)', padding: '1px 5px', borderRadius: 3 }}>{e.reference}</code>}
                          {e.notes && <span style={{ color: 'var(--muted)', fontSize: 12, fontStyle: 'italic' }}>{e.notes}</span>}
                          <button onClick={() => delEntry(e.id, p.id)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red-l)', fontSize: 13 }}
                            onMouseOver={ev => ev.target.style.color = 'var(--red)'} onMouseOut={ev => ev.target.style.color = 'var(--red-l)'}>✕</button>
                        </div>
                      ))}
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, padding: '8px 10px', background: 'var(--cream-warm)', borderRadius: 'var(--rs)', fontSize: 13 }}>
                        <span>Paid: <strong style={{ color: 'var(--green)' }}>{fmt(p.amount_paid || 0)}</strong></span>
                        <span>Balance: <strong style={{ color: (p.balance || 0) > 0 ? 'var(--red)' : 'var(--green)' }}>{fmt(p.balance || 0)}</strong></span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Invoice Modal */}
      <Modal open={modal} onClose={() => setModal(false)} title={form.id ? '✏️ Edit Invoice' : '📄 Add Supplier Invoice'} wide>
        <FormRow>
          <FormGroup label="Invoice Date *"><input className="form-input" type="date" value={form.date} onChange={e => updateForm('date', e.target.value)} /></FormGroup>
          <FormGroup label="Invoice / Bill No. *"><input className="form-input" value={form.bill_no} onChange={e => updateForm('bill_no', e.target.value)} placeholder="e.g. INV-1042" /></FormGroup>
        </FormRow>
        <FormRow>
          <FormGroup label="Supplier *">
            <Autocomplete value={form.supplier} onChange={v => updateForm('supplier', v)} options={SUPPLIERS} placeholder="Start typing supplier..." />
          </FormGroup>
          <FormGroup label="Brand"><input className="form-input" value={form.brand} onChange={e => updateForm('brand', e.target.value)} placeholder="e.g. Timbaktu" /></FormGroup>
        </FormRow>

        {/* Invoice breakdown */}
        <div style={{ background: 'var(--cream)', borderRadius: 'var(--rs)', padding: '14px', marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 10 }}>Invoice Breakdown</div>
          <FormRow>
            <FormGroup label="Taxable Value (₹) *">
              <input className="form-input no-spinner" type="number" value={form.taxable_value} onChange={e => updateForm('taxable_value', e.target.value)} placeholder="Amount before GST" onWheel={e => e.target.blur()} />
            </FormGroup>
            <FormGroup label="GST Type">
              <select className="form-input form-select" value={form.gst_type} onChange={e => updateForm('gst_type', e.target.value)}>
                {GST_TYPES.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
              </select>
            </FormGroup>
          </FormRow>

          {form.gst_type === 'igst' && (
            <FormGroup label="IGST Amount (₹)">
              <input className="form-input no-spinner" type="number" value={form.igst_amount} onChange={e => updateForm('igst_amount', e.target.value)} placeholder="0.00" onWheel={e => e.target.blur()} />
            </FormGroup>
          )}
          {form.gst_type === 'cgst_sgst' && (
            <FormRow>
              <FormGroup label="CGST Amount (₹)">
                <input className="form-input no-spinner" type="number" value={form.cgst_amount} onChange={e => updateForm('cgst_amount', e.target.value)} placeholder="0.00" onWheel={e => e.target.blur()} />
              </FormGroup>
              <FormGroup label="SGST Amount (₹)">
                <input className="form-input no-spinner" type="number" value={form.sgst_amount} onChange={e => updateForm('sgst_amount', e.target.value)} placeholder="0.00" onWheel={e => e.target.blur()} />
              </FormGroup>
            </FormRow>
          )}

          <FormRow>
            <FormGroup label="Transport (₹)">
              <input className="form-input no-spinner" type="number" value={form.transport_charge} onChange={e => updateForm('transport_charge', e.target.value)} placeholder="0.00" onWheel={e => e.target.blur()} />
            </FormGroup>
            <FormGroup label="Category">
              <input className="form-input" value={form.category} onChange={e => updateForm('category', e.target.value)} placeholder="e.g. Oils, Millets" />
            </FormGroup>
          </FormRow>

          {/* Auto-calculated totals */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 8, padding: '10px 12px', background: 'var(--white)', borderRadius: 'var(--rs)' }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase' }}>Total ITC (claimable)</div>
              <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 20, fontWeight: 700, color: 'var(--green)' }}>{fmt(formItc)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase' }}>Total Invoice Value</div>
              <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 20, fontWeight: 700, color: 'var(--brown-dark)' }}>{fmt(formTotal)}</div>
            </div>
          </div>
        </div>

        <FormRow>
          <FormGroup label="GRN Status">
            <select className="form-input form-select" value={form.grn_status} onChange={e => updateForm('grn_status', e.target.value)}>
              <option>Pending</option><option>Completed</option><option>Partial</option>
            </select>
          </FormGroup>
          <FormGroup label="Notes">
            <input className="form-input" value={form.notes} onChange={e => updateForm('notes', e.target.value)} />
          </FormGroup>
        </FormRow>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>Save Invoice</button>
        </div>
      </Modal>

      {/* Add Payment Entry Modal */}
      {payModal && (
        <Modal open={!!payModal} onClose={() => setPayModal(null)} title={`💳 Record Payment — ${payModal.supplier}`}>
          <div style={{ background: 'var(--cream)', borderRadius: 'var(--rs)', padding: '10px 14px', marginBottom: 14, fontSize: 13 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span>Invoice Total: <strong>{fmt(payModal.bill_amount || 0)}</strong></span>
              <span>Already Paid: <strong style={{ color: 'var(--green)' }}>{fmt(payModal.amount_paid || 0)}</strong></span>
            </div>
            <div style={{ fontWeight: 700, color: 'var(--red)', fontSize: 14 }}>Balance Due: {fmt(payModal.balance || 0)}</div>
          </div>
          <FormRow>
            <FormGroup label="Payment Date *"><input className="form-input" type="date" value={entryForm.date} onChange={e => setEntryForm(p => ({ ...p, date: e.target.value }))} /></FormGroup>
            <FormGroup label="Amount (₹) *"><input className="form-input no-spinner" type="number" value={entryForm.amount} onChange={e => setEntryForm(p => ({ ...p, amount: e.target.value }))} placeholder={fmt(payModal.balance || 0)} onWheel={e => e.target.blur()} /></FormGroup>
          </FormRow>
          <FormRow>
            <FormGroup label="Payment Mode">
              <select className="form-input form-select" value={entryForm.mode} onChange={e => setEntryForm(p => ({ ...p, mode: e.target.value }))}>
                {MODES.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </FormGroup>
            <FormGroup label="Reference (UTR/Cheque No.)">
              <input className="form-input" value={entryForm.reference} onChange={e => setEntryForm(p => ({ ...p, reference: e.target.value }))} placeholder="UTR number..." />
            </FormGroup>
          </FormRow>
          <FormGroup label="Notes"><input className="form-input" value={entryForm.notes} onChange={e => setEntryForm(p => ({ ...p, notes: e.target.value }))} /></FormGroup>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setPayModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveEntry}>Record Payment</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function BrkItem({ label, value, color, bold }) {
  return (
    <div style={{ background: 'var(--white)', borderRadius: 6, padding: '7px 10px' }}>
      <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: bold ? 700 : 500, color: color || 'var(--text)', marginTop: 2 }}>{value}</div>
    </div>
  )
}
