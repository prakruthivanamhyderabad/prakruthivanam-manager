import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Modal, FormGroup, FormRow, StatCard, Loading, useConfirm } from '../components/ui'
import { fmt, fmtDate, today, thisMonth } from '../lib/utils'

const CATEGORIES = [
  { id: 'staff', label: 'Staff & HR', icon: '👥' },
  { id: 'premises', label: 'Premises', icon: '🏠' },
  { id: 'utilities', label: 'Utilities', icon: '⚡' },
  { id: 'logistics', label: 'Logistics', icon: '🚚' },
  { id: 'marketing', label: 'Marketing', icon: '📢' },
  { id: 'admin', label: 'Admin & Bank', icon: '🏦' },
  { id: 'other', label: 'Other', icon: '📦' },
]

const PAYMENT_MODES = ['Bank Transfer', 'Cash', 'UPI', 'Personal Account', 'Cheque']

export default function Expenses({ user, toast, setSyncStatus }) {
  const [expenses, setExpenses] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(false)
  const [recurringModal, setRecurringModal] = useState(false)
  const [filterMonth, setFilterMonth] = useState(thisMonth())
  const [filterCat, setFilterCat] = useState('')
  const { confirm, ConfirmDialog } = useConfirm()
  const [staff, setStaff] = useState([])

  const emptyForm = {
    id: null, date: today(), description: '', category: 'staff',
    amount: '', payment_mode: 'Bank Transfer', paid_by: 'business',
    is_recurring: false, recurrence_day: 1, assigned_to: '', notes: ''
  }
  const [form, setForm] = useState(emptyForm)

  useEffect(() => { fetchExpenses(); fetchStaff() }, [])

  async function fetchExpenses() {
    const { data } = await supabase.from('expenses').select('*').order('date', { ascending: false })
    setExpenses(data || [])
    setLoading(false)
  }

  async function fetchStaff() {
    const { data } = await supabase.from('staff').select('name')
    setStaff(data?.map(s => s.name) || [])
  }

  function openNew() { setForm(emptyForm); setModal(true) }
  function openEdit(e) {
    setForm({
      id: e.id, date: e.date, description: e.description, category: e.category,
      amount: e.amount, payment_mode: e.payment_mode, paid_by: e.paid_by,
      is_recurring: e.is_recurring, recurrence_day: e.recurrence_day || 1,
      assigned_to: e.assigned_to || '', notes: e.notes || ''
    })
    setModal(true)
  }

  async function save() {
    if (!form.description || !form.amount || !form.date) {
      toast('Fill description, amount and date.', 'error'); return
    }
    setSyncStatus({ state: 'syncing', msg: 'Saving...' })
    const payload = {
      date: form.date, description: form.description, category: form.category,
      amount: parseFloat(form.amount), payment_mode: form.payment_mode,
      paid_by: form.paid_by, is_recurring: form.is_recurring,
      recurrence_day: form.is_recurring ? parseInt(form.recurrence_day) : null,
      assigned_to: form.assigned_to || null, notes: form.notes
    }
    if (form.id) {
      await supabase.from('expenses').update(payload).eq('id', form.id)
    } else {
      await supabase.from('expenses').insert(payload)
    }
    setSyncStatus({ state: 'ok', msg: 'Saved ✓' })
    setModal(false); fetchExpenses()
    toast('Expense saved ✓', 'success')
  }

  async function del(id) {
    const ok = await confirm('Delete this expense?'); if (!ok) return
    await supabase.from('expenses').delete().eq('id', id)
    fetchExpenses(); toast('Deleted.')
  }

  function exportCSV() {
    const h = ['Date', 'Description', 'Category', 'Amount', 'Payment Mode', 'Paid By', 'Recurring', 'Notes']
    const rows = expenses.map(e => [e.date, e.description, e.category, e.amount, e.payment_mode, e.paid_by, e.is_recurring ? 'Yes' : 'No', e.notes || ''])
    const csv = [h, ...rows].map(r => r.map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a'); a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv); a.download = 'expenses.csv'; a.click()
    toast('Exported ✓', 'success')
  }

  // Filter
  let filtered = expenses
  if (filterMonth) filtered = filtered.filter(e => (e.date || '').slice(0, 7) === filterMonth)
  if (filterCat) filtered = filtered.filter(e => e.category === filterCat)

  // Stats for current month
  const monthExp = expenses.filter(e => (e.date || '').slice(0, 7) === filterMonth)
  const totalAmt = monthExp.reduce((s, e) => s + (e.amount || 0), 0)
  const byCategory = CATEGORIES.map(c => ({
    ...c,
    total: monthExp.filter(e => e.category === c.id).reduce((s, e) => s + (e.amount || 0), 0)
  })).filter(c => c.total > 0)

  // Recurring due this month
  const today_d = new Date()
  const recurring = expenses.filter(e => e.is_recurring)
  const dueSoon = recurring.filter(e => {
    const day = e.recurrence_day
    const daysLeft = day - today_d.getDate()
    return daysLeft >= 0 && daysLeft <= 5
  })

  const catMap = Object.fromEntries(CATEGORIES.map(c => [c.id, c]))

  return (
    <div>
      <ConfirmDialog />

      {/* Due soon alert */}
      {dueSoon.length > 0 && (
        <div style={{ background: 'var(--amber-l)', border: '1.5px solid var(--amber)', borderRadius: 'var(--r)', padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 18 }}>⏰</span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--amber)' }}>Recurring expenses due soon</div>
            <div style={{ fontSize: 12, color: 'var(--brown-light)', marginTop: 2 }}>
              {dueSoon.map(e => `${e.description} (day ${e.recurrence_day})`).join(' · ')}
            </div>
          </div>
        </div>
      )}

      <div className="stats-grid">
        <div className="stat-card gold">
          <div className="stat-num">{fmt(totalAmt)}</div>
          <div className="stat-label">Total This Month</div>
        </div>
        <StatCard num={monthExp.filter(e => e.paid_by === 'personal').length} label="Personal Account" color="amber" />
        <StatCard num={recurring.length} label="Recurring" color="blue" />
        <StatCard num={dueSoon.length} label="Due This Week" color="red" />
      </div>

      {/* Category breakdown */}
      {byCategory.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
          {byCategory.map(c => (
            <div key={c.id} style={{ background: 'var(--white)', borderRadius: 'var(--rs)', padding: '8px 14px', boxShadow: 'var(--shadow)', fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>{c.icon}</span>
              <span style={{ color: 'var(--muted)' }}>{c.label}</span>
              <span style={{ fontWeight: 700, color: 'var(--brown-dark)' }}>{fmt(c.total)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="section-header">
        <h2 className="section-title">💸 Expenses</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={exportCSV}>⬇ CSV</button>
          <button className="btn btn-primary" onClick={openNew}>＋ Add Expense</button>
        </div>
      </div>

      <div className="filter-bar">
        <input type="month" value={filterMonth} onChange={e => setFilterMonth(e.target.value)} style={{ maxWidth: 160 }} />
        <select value={filterCat} onChange={e => setFilterCat(e.target.value)}>
          <option value="">All Categories</option>
          {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
        </select>
        <button className="btn btn-secondary btn-sm" onClick={() => { setFilterMonth(thisMonth()); setFilterCat('') }}>✕ Clear</button>
      </div>

      {loading ? <Loading /> : (
        <div className="card table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Date</th><th>Description</th><th>Category</th><th>Amount</th><th>Mode</th><th>Paid By</th><th>Recurring</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: 36, color: 'var(--muted)' }}>No expenses for this period.</td></tr>
              ) : filtered.map(e => {
                const cat = catMap[e.category]
                return (
                  <tr key={e.id}>
                    <td>{fmtDate(e.date)}</td>
                    <td>
                      <strong>{e.description}</strong>
                      {e.notes && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{e.notes}</div>}
                    </td>
                    <td><span style={{ fontSize: 12 }}>{cat?.icon} {cat?.label || e.category}</span></td>
                    <td style={{ fontWeight: 700, color: 'var(--red)' }}>{fmt(e.amount)}</td>
                    <td style={{ fontSize: 12 }}>{e.payment_mode}</td>
                    <td>
                      {e.paid_by === 'personal'
                        ? <span className="pill pill-pending">Personal</span>
                        : <span className="pill pill-approved">Business</span>}
                    </td>
                    <td>
                      {e.is_recurring
                        ? <span className="pill pill-submitted">🔁 Day {e.recurrence_day}</span>
                        : <span style={{ color: 'var(--muted)', fontSize: 12 }}>—</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm" style={{ background: 'var(--sage-pale)', color: 'var(--sage-dark)', marginRight: 4 }} onClick={() => openEdit(e)}>✏️</button>
                      <button className="btn btn-sm btn-danger" onClick={() => del(e.id)}>🗑</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title={form.id ? '✏️ Edit Expense' : '💸 Add Expense'} wide>
        <FormRow>
          <FormGroup label="Date *">
            <input className="form-input" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
          </FormGroup>
          <FormGroup label="Category *">
            <select className="form-input form-select" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
            </select>
          </FormGroup>
        </FormRow>
        <FormGroup label="Description *">
          <input className="form-input" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="e.g. April Rent, Electricity Bill, Ravi Salary" />
        </FormGroup>
        <FormRow>
          <FormGroup label="Amount (₹) *">
            <input className="form-input" type="number" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="0.00" />
          </FormGroup>
          <FormGroup label="Payment Mode">
            <select className="form-input form-select" value={form.payment_mode} onChange={e => setForm({ ...form, payment_mode: e.target.value })}>
              {PAYMENT_MODES.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </FormGroup>
        </FormRow>
        <FormRow>
          <FormGroup label="Paid By">
            <select className="form-input form-select" value={form.paid_by} onChange={e => setForm({ ...form, paid_by: e.target.value })}>
              <option value="business">Business Account</option>
              <option value="personal">Personal Account (reimburse)</option>
            </select>
          </FormGroup>
          <FormGroup label="Assign To (optional)">
            <select className="form-input form-select" value={form.assigned_to} onChange={e => setForm({ ...form, assigned_to: e.target.value })}>
              <option value="">Manager only</option>
              {staff.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </FormGroup>
        </FormRow>

        {/* Recurring */}
        <div style={{ background: 'var(--cream)', borderRadius: 'var(--rs)', padding: '12px 14px', marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: form.is_recurring ? 10 : 0 }}>
            <input type="checkbox" checked={form.is_recurring} onChange={e => setForm({ ...form, is_recurring: e.target.checked })}
              style={{ width: 16, height: 16, accentColor: 'var(--gold-mid)' }} />
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>🔁 Recurring every month</span>
          </label>
          {form.is_recurring && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label className="form-label" style={{ marginBottom: 0, whiteSpace: 'nowrap' }}>Due on day</label>
              <input className="form-input" type="number" min={1} max={31} value={form.recurrence_day}
                onChange={e => setForm({ ...form, recurrence_day: e.target.value })}
                style={{ width: 80, textAlign: 'center', fontWeight: 700 }} />
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>of each month</span>
            </div>
          )}
        </div>

        <FormGroup label="Notes">
          <input className="form-input" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Any additional details..." />
        </FormGroup>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>Save Expense</button>
        </div>
      </Modal>
    </div>
  )
}
