import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Modal, FormGroup, StatCard, Loading } from '../components/ui'
import { fmtDate, today, thisMonth } from '../lib/utils'
import { format, getDaysInMonth, parseISO } from 'date-fns'

const STATUS_OPTS = [
  { code: 'P', label: 'Present', color: 'var(--green)', bg: 'var(--green-l)', border: 'var(--green)' },
  { code: 'A', label: 'Absent', color: 'var(--red)', bg: 'var(--red-l)', border: 'var(--red)' },
  { code: 'H', label: 'Half Day', color: 'var(--amber)', bg: 'var(--amber-l)', border: 'var(--amber)' },
  { code: 'L', label: 'Late', color: 'var(--blue)', bg: 'var(--blue-l)', border: 'var(--blue)' },
]

export default function Attendance({ user, toast, setSyncStatus }) {
  const [date, setDate] = useState(today())
  const [staff, setStaff] = useState([])
  const [attendance, setAttendance] = useState({}) // { 'staffId-date': 'P'|'A'|'H'|'L' }
  const [summaryMonth, setSummaryMonth] = useState(thisMonth())
  const [loading, setLoading] = useState(true)
  const [staffModal, setStaffModal] = useState(false)
  const [newStaff, setNewStaff] = useState({ name: '', role: '', pin: '' })

  useEffect(() => { fetchStaff() }, [])
  useEffect(() => { if (staff.length) fetchAttendance() }, [staff, date])
  useEffect(() => { if (staff.length) fetchSummary() }, [staff, summaryMonth])

  async function fetchStaff() {
    const { data } = await supabase.from('staff').select('*').order('name')
    setStaff(data || [])
    setLoading(false)
  }

  const [attMap, setAttMap] = useState({})

  async function fetchAttendance() {
    const { data } = await supabase.from('attendance').select('*').eq('date', date)
    const map = {}
    data?.forEach(r => { map[r.staff_id] = r.status })
    setAttMap(map)
  }

  const [summaryData, setSummaryData] = useState({})

  async function fetchSummary() {
    const [yr, mo] = summaryMonth.split('-').map(Number)
    const days = getDaysInMonth(new Date(yr, mo - 1))
    const from = `${summaryMonth}-01`
    const to = `${summaryMonth}-${String(days).padStart(2, '0')}`
    const { data } = await supabase.from('attendance').select('*').gte('date', from).lte('date', to)
    const map = {}
    data?.forEach(r => {
      if (!map[r.staff_id]) map[r.staff_id] = { P: 0, A: 0, H: 0, L: 0 }
      map[r.staff_id][r.status] = (map[r.staff_id][r.status] || 0) + 1
    })
    setSummaryData(map)
  }

  async function markAtt(staffId, status) {
    setSyncStatus({ state: 'syncing', msg: 'Saving...' })
    const current = attMap[staffId]
    if (current === status) {
      // Toggle off
      await supabase.from('attendance').delete().eq('staff_id', staffId).eq('date', date)
      setAttMap(prev => { const n = { ...prev }; delete n[staffId]; return n })
    } else {
      await supabase.from('attendance').upsert({ staff_id: staffId, date, status }, { onConflict: 'staff_id,date' })
      setAttMap(prev => ({ ...prev, [staffId]: status }))
    }
    setSyncStatus({ state: 'ok', msg: 'Saved ✓' })
    fetchSummary()
  }

  async function addStaff() {
    if (!newStaff.name) { toast('Enter name.', 'error'); return }
    const { error } = await supabase.from('staff').insert({ name: newStaff.name, role: newStaff.role || 'Store Assistant', pin: newStaff.pin || '1234' })
    if (error) { toast('Failed to add staff', 'error'); return }
    setStaffModal(false)
    setNewStaff({ name: '', role: '', pin: '' })
    fetchStaff()
    toast('Staff added ✓', 'success')
  }

  async function removeStaff(id) {
    if (!confirm('Remove this staff member?')) return
    await supabase.from('staff').delete().eq('id', id)
    fetchStaff()
    toast('Staff removed.')
  }

  function changeDate(delta) {
    const d = new Date(date + 'T00:00:00')
    d.setDate(d.getDate() + delta)
    setDate(d.toISOString().slice(0, 10))
  }

  const counts = { P: 0, A: 0, H: 0, L: 0 }
  Object.values(attMap).forEach(s => { if (counts[s] !== undefined) counts[s]++ })

  const dateDisplay = date === today()
    ? 'Today — ' + new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })
    : new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div>
      <div className="stats-grid">
        <StatCard num={counts.P} label="Present" color="green" />
        <StatCard num={counts.A} label="Absent" color="red" />
        <StatCard num={counts.H} label="Half Day" color="amber" />
        <StatCard num={counts.L} label="Late" color="blue" />
      </div>

      {/* Date nav */}
      <div className="card" style={{ padding: '14px 18px', marginBottom: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => changeDate(-1)}>← Prev</button>
          <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 16, fontWeight: 600, color: 'var(--sage-dark)' }}>{dateDisplay}</span>
          <button className="btn btn-secondary btn-sm" onClick={() => changeDate(1)}>Next →</button>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="date" className="form-input" style={{ width: 148, padding: '6px 10px', fontSize: 12.5 }}
            value={date} onChange={e => setDate(e.target.value)} />
          {user.role === 'manager' && <button className="btn btn-primary btn-sm" onClick={() => setStaffModal(true)}>＋ Add Staff</button>}
        </div>
      </div>

      {/* Staff grid */}
      {loading ? <Loading /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px,1fr))', gap: 12, marginBottom: 22 }}>
          {staff.map(s => {
            const cur = attMap[s.id] || ''
            const initials = s.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
            return (
              <div key={s.id} className="card animate-fade" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'var(--sage-pale)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Playfair Display', serif", fontSize: 16, fontWeight: 700, color: 'var(--sage-dark)', flexShrink: 0 }}>
                  {initials}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 5 }}>{s.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>{s.role}</div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {STATUS_OPTS.map(opt => (
                      <button key={opt.code} onClick={() => markAtt(s.id, opt.code)} style={{
                        padding: '4px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', transition: 'all .2s',
                        border: `1.5px solid ${cur === opt.code ? opt.border : 'var(--cream-dark)'}`,
                        background: cur === opt.code ? opt.bg : 'var(--cream)',
                        color: cur === opt.code ? opt.color : 'var(--muted)'
                      }}>{opt.label}</button>
                    ))}
                  </div>
                  {user.role === 'manager' && (
                    <button onClick={() => removeStaff(s.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red-l)', fontSize: 11, marginTop: 4, transition: 'color .2s' }}
                      onMouseOver={e => e.target.style.color = 'var(--red)'}
                      onMouseOut={e => e.target.style.color = 'var(--red-l)'}>✕ Remove</button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Monthly summary */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--cream-dark)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--sage-dark)' }}>📊 Monthly Summary</span>
          <input type="month" className="form-input" style={{ width: 148, padding: '6px 10px', fontSize: 12.5 }}
            value={summaryMonth} onChange={e => setSummaryMonth(e.target.value)} />
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Staff</th><th>Present</th><th>Absent</th><th>Half Day</th><th>Late</th><th>Total</th><th>Attendance %</th></tr></thead>
            <tbody>
              {staff.map(s => {
                const d = summaryData[s.id] || { P: 0, A: 0, H: 0, L: 0 }
                const total = d.P + d.A + d.H + d.L
                const pct = total > 0 ? Math.round(((d.P + d.H * 0.5 + d.L) * 100) / total) : 0
                return (
                  <tr key={s.id}>
                    <td><strong>{s.name}</strong><br /><small style={{ color: 'var(--muted)' }}>{s.role}</small></td>
                    <td style={{ color: 'var(--green)', fontWeight: 600 }}>{d.P}</td>
                    <td style={{ color: 'var(--red)', fontWeight: 600 }}>{d.A}</td>
                    <td style={{ color: 'var(--amber)', fontWeight: 600 }}>{d.H}</td>
                    <td style={{ color: 'var(--blue)', fontWeight: 600 }}>{d.L}</td>
                    <td>{total}</td>
                    <td><strong style={{ color: pct >= 80 ? 'var(--green)' : pct >= 60 ? 'var(--amber)' : 'var(--red)' }}>{pct}%</strong></td>
                  </tr>
                )
              })}
              {staff.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 28, color: 'var(--muted)' }}>No staff added yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={staffModal} onClose={() => setStaffModal(false)} title="👤 Add Staff Member">
        <FormGroup label="Full Name *">
          <input className="form-input" value={newStaff.name} onChange={e => setNewStaff({ ...newStaff, name: e.target.value })} placeholder="e.g. Ravi Kumar" />
        </FormGroup>
        <FormGroup label="Role / Designation">
          <input className="form-input" value={newStaff.role} onChange={e => setNewStaff({ ...newStaff, role: e.target.value })} placeholder="e.g. Store Assistant" />
        </FormGroup>
        <FormGroup label="PIN (for staff login)">
          <input className="form-input" type="password" value={newStaff.pin} onChange={e => setNewStaff({ ...newStaff, pin: e.target.value })} placeholder="4+ digit PIN" />
        </FormGroup>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setStaffModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={addStaff}>Add Staff</button>
        </div>
      </Modal>
    </div>
  )
}
