import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Modal, FormGroup, FormRow, StatCard, EmptyState, Loading, useConfirm } from '../components/ui'
import { fmtDateTime, today, getNextDue } from '../lib/utils'

const FILTERS = ['all', 'mine', 'pending', 'in-progress', 'done', 'overdue']
const PRIORITY_COLOR = { high: 'red', medium: 'amber', low: 'green' }

export default function Tasks({ user, toast, setSyncStatus }) {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [staff, setStaff] = useState([])
  const { confirm, ConfirmDialog } = useConfirm()

  const [form, setForm] = useState({
    title: '', description: '', assigned_to: 'Manager',
    priority: 'medium', due_at: '', is_recurring: false,
    rec_num: 1, rec_unit: 'months'
  })

  useEffect(() => { fetchTasks(); fetchStaff() }, [])

  async function fetchTasks() {
    const { data } = await supabase.from('tasks').select('*').order('due_at', { ascending: true })
    setTasks(data || [])
    setLoading(false)
  }

  async function fetchStaff() {
    const { data } = await supabase.from('staff').select('name')
    setStaff(data?.map(s => s.name) || [])
  }

  function openModal() {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0)
    setForm({
      title: '', description: '',
      assigned_to: user.role === 'manager' ? 'Manager' : (staff[0] || 'Staff'),
      priority: 'medium',
      due_at: d.toISOString().slice(0, 16),
      is_recurring: false, rec_num: 1, rec_unit: 'months'
    })
    setModalOpen(true)
  }

  async function saveTask() {
    if (!form.title || !form.due_at) { toast('Fill title and due date.', 'error'); return }
    setSyncStatus({ state: 'syncing', msg: 'Saving...' })
    const recurrence = form.is_recurring ? { num: form.rec_num, unit: form.rec_unit } : null
    const { error } = await supabase.from('tasks').insert({
      title: form.title,
      description: form.description,
      assigned_to: form.assigned_to,
      priority: form.priority,
      due_at: new Date(form.due_at).toISOString(),
      status: 'pending',
      created_by: user.role === 'manager' ? 'Manager' : 'Staff',
      recurrence
    })
    if (error) { toast('Failed to save task', 'error'); setSyncStatus({ state: 'error', msg: 'Save failed' }); return }
    setSyncStatus({ state: 'ok', msg: 'Saved ✓' })
    setModalOpen(false)
    fetchTasks()
    toast(form.is_recurring ? '🔁 Recurring task created ✓' : 'Task created ✓', 'success')
  }

  async function updateStatus(task, status) {
    setSyncStatus({ state: 'syncing', msg: 'Updating...' })
    await supabase.from('tasks').update({ status }).eq('id', task.id)
    setSyncStatus({ state: 'ok', msg: 'Saved ✓' })
    fetchTasks()
  }

  async function completeTask(task, note) {
    setSyncStatus({ state: 'syncing', msg: 'Saving...' })
    await supabase.from('tasks').update({
      status: 'done',
      completed_at: new Date().toISOString(),
      completion_note: note
    }).eq('id', task.id)

    // Auto-create next if recurring
    if (task.recurrence) {
      const nextDue = getNextDue(task.due_at, task.recurrence)
      if (nextDue) {
        await supabase.from('tasks').insert({
          title: task.title,
          description: task.description,
          assigned_to: task.assigned_to,
          priority: task.priority,
          due_at: nextDue,
          status: 'pending',
          created_by: 'Recurring',
          recurrence: task.recurrence
        })
        toast('✓ Done — next occurrence created', 'success')
      }
    } else {
      toast('Task completed ✓', 'success')
    }
    setSyncStatus({ state: 'ok', msg: 'Saved ✓' })
    fetchTasks()
  }

  async function deleteTask(id) {
    const ok = await confirm('Delete this task?')
    if (!ok) return
    await supabase.from('tasks').delete().eq('id', id)
    fetchTasks()
    toast('Deleted.')
  }

  const now = new Date()
  const filtered = tasks.filter(t => {
    if (filter === 'mine') return t.assigned_to === (user.role === 'manager' ? 'Manager' : staff[0] || 'Staff')
    if (filter === 'pending') return t.status === 'pending'
    if (filter === 'in-progress') return t.status === 'in-progress'
    if (filter === 'done') return t.status === 'done'
    if (filter === 'overdue') return t.status !== 'done' && new Date(t.due_at) < now
    return true
  }).sort((a, b) => {
    if (a.status === 'done' && b.status !== 'done') return 1
    if (a.status !== 'done' && b.status === 'done') return -1
    return new Date(a.due_at) - new Date(b.due_at)
  })

  const overdue = tasks.filter(t => t.status !== 'done' && new Date(t.due_at) < now)

  return (
    <div>
      <ConfirmDialog />
      <div className="stats-grid">
        <StatCard num={tasks.length} label="Total" />
        <StatCard num={tasks.filter(t => t.status === 'pending').length} label="Pending" color="amber" />
        <StatCard num={overdue.length} label="Overdue" color="red" />
        <StatCard num={tasks.filter(t => t.status === 'done').length} label="Done" color="green" />
      </div>

      <div className="section-header">
        <h2 className="section-title">To Do List</h2>
        <button className="btn btn-primary" onClick={openModal}>＋ Add Task</button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 7, marginBottom: 16, flexWrap: 'wrap' }}>
        {FILTERS.map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: '5px 13px',
            border: `1.5px solid ${filter === f ? 'var(--sage)' : 'var(--cream-dark)'}`,
            borderRadius: 20, background: filter === f ? 'var(--sage-pale)' : 'var(--white)',
            fontFamily: "'DM Sans', sans-serif", fontSize: 12, fontWeight: 500,
            cursor: 'pointer', color: filter === f ? 'var(--sage-dark)' : 'var(--muted)',
            transition: 'all .2s'
          }}>
            {f === 'all' ? 'All' : f === 'in-progress' ? 'In Progress' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {loading ? <Loading /> : filtered.length === 0 ? (
        <EmptyState icon="🌱" message="No tasks here." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map(task => (
            <TaskCard key={task.id} task={task} user={user}
              onUpdateStatus={updateStatus} onComplete={completeTask} onDelete={deleteTask} />
          ))}
        </div>
      )}

      {/* Add Task Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="🌱 Add Task">
        <FormGroup label="Title *">
          <input className="form-input" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Check expiry dates on shelf" />
        </FormGroup>
        <FormGroup label="Description / Instructions">
          <textarea className="form-input form-textarea" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Steps or details..." />
        </FormGroup>
        <FormRow>
          <FormGroup label="Assigned To">
            <select className="form-input form-select" value={form.assigned_to} onChange={e => setForm({ ...form, assigned_to: e.target.value })}>
              <option value="Manager">👑 Manager</option>
              {staff.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </FormGroup>
          <FormGroup label="Priority">
            <select className="form-input form-select" value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}>
              <option value="high">🔴 High</option>
              <option value="medium">🟡 Medium</option>
              <option value="low">🟢 Low</option>
            </select>
          </FormGroup>
        </FormRow>
        <FormGroup label="Due Date *">
          <input className="form-input" type="datetime-local" value={form.due_at} onChange={e => setForm({ ...form, due_at: e.target.value })} />
        </FormGroup>
        {/* Recurring */}
        <div style={{ background: 'var(--cream)', borderRadius: 'var(--rs)', padding: '12px 14px', marginTop: 4 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={form.is_recurring} onChange={e => setForm({ ...form, is_recurring: e.target.checked })}
              style={{ width: 16, height: 16, accentColor: 'var(--sage)', cursor: 'pointer' }} />
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>🔁 Recurring task</span>
          </label>
          {form.is_recurring && (
            <div style={{ marginTop: 12 }}>
              <label className="form-label" style={{ marginBottom: 8 }}>Repeat every</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input className="form-input" type="number" value={form.rec_num} min={1} max={365}
                  onChange={e => setForm({ ...form, rec_num: parseInt(e.target.value) || 1 })}
                  style={{ width: 80, textAlign: 'center', fontSize: 16, fontWeight: 700 }} />
                <select className="form-input form-select" value={form.rec_unit} onChange={e => setForm({ ...form, rec_unit: e.target.value })} style={{ flex: 1 }}>
                  <option value="days">Day(s)</option>
                  <option value="weeks">Week(s)</option>
                  <option value="months">Month(s)</option>
                  <option value="years">Year(s)</option>
                </select>
              </div>
              <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>Next occurrence auto-creates when this is marked done.</p>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={saveTask}>Create Task</button>
        </div>
      </Modal>
    </div>
  )
}

function TaskCard({ task, user, onUpdateStatus, onComplete, onDelete }) {
  const [showNotes, setShowNotes] = useState(false)
  const [note, setNote] = useState('')
  const now = new Date()
  const isOverdue = task.status !== 'done' && new Date(task.due_at) < now
  const isDone = task.status === 'done'

  return (
    <div className="animate-fade" style={{
      background: 'var(--white)',
      borderRadius: 'var(--r)',
      padding: '15px 18px',
      boxShadow: 'var(--shadow)',
      borderLeft: `4px solid var(--${PRIORITY_COLOR[task.priority] || 'sage'})`,
      opacity: isDone ? .6 : 1
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, fontSize: 14, textDecoration: isDone ? 'line-through' : 'none', color: isDone ? 'var(--muted)' : 'var(--text)' }}>
              {task.title}
            </span>
            <span className={`pill pill-${task.priority}`}>{task.priority}</span>
            <span className={`pill pill-${task.status}`}>{task.status}</span>
            {task.assigned_to && <span style={{ background: 'var(--blue-l)', color: 'var(--blue)', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>👤 {task.assigned_to}</span>}
            {task.recurrence && <span style={{ background: 'var(--sage-pale)', color: 'var(--sage-dark)', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>🔁</span>}
          </div>
          {task.description && <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 6 }}>{task.description}</p>}
          <div style={{ fontSize: 11, color: isOverdue ? 'var(--red)' : 'var(--muted)', fontWeight: isOverdue ? 600 : 400 }}>
            📅 {fmtDateTime(task.due_at)}{isOverdue ? ' · OVERDUE' : ''}
            {task.created_by && <span style={{ marginLeft: 12, color: 'var(--muted)' }}>by {task.created_by}</span>}
          </div>
          {isDone && task.completion_note && (
            <div style={{ marginTop: 7, padding: '7px 11px', background: 'var(--green-l)', borderRadius: 'var(--rs)', fontSize: 12, color: 'var(--green)' }}>
              ✓ {fmtDateTime(task.completed_at)} — "{task.completion_note}"
            </div>
          )}
          {showNotes && (
            <div style={{ marginTop: 8 }}>
              <textarea className="form-input form-textarea" style={{ minHeight: 50, marginBottom: 6 }}
                value={note} onChange={e => setNote(e.target.value)} placeholder="Completion note (optional)..." />
              <button className="btn btn-primary btn-sm" onClick={() => { onComplete(task, note); setShowNotes(false) }}>✓ Confirm Complete</button>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-end', flexShrink: 0 }}>
          {!isDone && (
            <>
              {task.status === 'pending' && <button className="btn btn-sm" style={{ background: 'var(--blue-l)', color: 'var(--blue)' }} onClick={() => onUpdateStatus(task, 'in-progress')}>▶ Start</button>}
              <button className="btn btn-sm" style={{ background: 'var(--green-l)', color: 'var(--green)' }} onClick={() => setShowNotes(!showNotes)}>✓ Done</button>
            </>
          )}
          {user.role === 'manager' && <button className="btn btn-sm btn-danger" onClick={() => onDelete(task.id)}>🗑</button>}
        </div>
      </div>
    </div>
  )
}
