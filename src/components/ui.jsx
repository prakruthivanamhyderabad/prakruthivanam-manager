import { useState, useRef, useEffect } from 'react'
import { X } from 'lucide-react'

// ── Modal ──────────────────────────────────
export function Modal({ open, onClose, title, children, wide }) {
  useEffect(() => {
    if (!open) return
    const handler = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`modal-box ${wide ? 'wide' : ''}`}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <h2 className="modal-title" style={{ margin: 0 }}>{title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ── Form Row ───────────────────────────────
export function FormRow({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>{children}</div>
}

export function FormGroup({ label, children }) {
  return (
    <div style={{ marginBottom: 13 }}>
      {label && <label className="form-label">{label}</label>}
      {children}
    </div>
  )
}

// ── Autocomplete ───────────────────────────
export function Autocomplete({ value, onChange, options, placeholder, className }) {
  const [open, setOpen] = useState(false)
  const [filtered, setFiltered] = useState([])
  const ref = useRef(null)

  useEffect(() => {
    const handler = e => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  function handleInput(e) {
    const q = e.target.value
    onChange(q)
    if (q.trim().length === 0) { setOpen(false); return }
    const matches = options.filter(o => o.toLowerCase().includes(q.toLowerCase())).slice(0, 10)
    setFiltered(matches)
    setOpen(matches.length > 0)
  }

  function select(val) {
    onChange(val)
    setOpen(false)
  }

  return (
    <div className="ac-wrap" ref={ref}>
      <input
        className={`form-input ${className || ''}`}
        value={value}
        onChange={handleInput}
        placeholder={placeholder}
        autoComplete="off"
      />
      {open && (
        <div className="ac-dropdown">
          {filtered.map(o => (
            <div key={o} className="ac-item" onMouseDown={() => select(o)}>{o}</div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Stat Card ──────────────────────────────
export function StatCard({ num, label, color }) {
  return (
    <div className={`stat-card ${color || ''}`}>
      <div className="stat-num">{num}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

// ── Confirm Dialog ─────────────────────────
export function useConfirm() {
  const [state, setState] = useState(null)

  function confirm(message) {
    return new Promise(resolve => {
      setState({ message, resolve })
    })
  }

  function ConfirmDialog() {
    if (!state) return null
    return (
      <div className="modal-overlay">
        <div className="modal-box" style={{ maxWidth: 360 }}>
          <p style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 20 }}>{state.message}</p>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => { state.resolve(false); setState(null) }}>Cancel</button>
            <button className="btn btn-danger" onClick={() => { state.resolve(true); setState(null) }}>Delete</button>
          </div>
        </div>
      </div>
    )
  }

  return { confirm, ConfirmDialog }
}

// ── Empty State ────────────────────────────
export function EmptyState({ icon, message, action }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <p style={{ marginBottom: action ? 16 : 0 }}>{message}</p>
      {action}
    </div>
  )
}

// ── Loading ────────────────────────────────
export function Loading({ message }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48, gap: 12, color: 'var(--muted)' }}>
      <div className="spinner" />
      <span>{message || 'Loading...'}</span>
    </div>
  )
}
