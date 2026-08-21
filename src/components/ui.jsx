import { useState, useRef, useEffect } from 'react'
import { X } from 'lucide-react'
import { fmt } from '../lib/utils'

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

// ── Upload Card ─────────────────────────────
export function UploadCard({ title, subtitle, desc, loading, accept, onChange, badge }) {
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

// ── Bar Cell (inline bar-in-table-cell) ─────
export function BarCell({ value, max, color, display }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: 'var(--cream)', borderRadius: 3, overflow: 'hidden', minWidth: 50 }}>
        <div style={{ width: `${Math.min(100, (value / max) * 100)}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 70, textAlign: 'right', whiteSpace: 'nowrap' }}>{display}</span>
    </div>
  )
}

// ── Trend Chart (simple CSS bar chart) ──────
export function TrendChart({ data, xKey, metric, formatValue, subLabel }) {
  const max = Math.max(...data.map(d => d[metric] || 0), 1)
  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 230, overflowX: 'auto', paddingTop: 8 }}>
        {data.map(d => {
          const h = Math.max(4, (d[metric] / max) * 180)
          return (
            <div key={d[xKey]} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 64, flex: '1 0 64px' }}>
              <div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 4, fontWeight: 600, whiteSpace: 'nowrap' }}>
                {formatValue(d)}
              </div>
              <div title={`${d[xKey]}: ${formatValue(d)}`} style={{
                width: '100%', maxWidth: 46, height: h,
                background: 'linear-gradient(180deg, var(--gold) 0%, var(--gold-mid) 100%)',
                borderRadius: '6px 6px 0 0'
              }} />
              <div style={{ fontSize: 11.5, color: 'var(--brown-dark)', fontWeight: 700, marginTop: 8 }}>{d[xKey]}</div>
              {subLabel && <div style={{ fontSize: 10, color: 'var(--muted)' }}>{subLabel(d)}</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Rank Table (name + qty/revenue bar + % share) ──
export function RankTable({ rows, nameKey, metric, icon, extraCol }) {
  const max = Math.max(...rows.map(r => r[metric] || 0), 1)
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0)
  return (
    <div className="card table-wrap">
      <table className="data-table" style={{ minWidth: 600 }}>
        <thead>
          <tr>
            <th>#</th><th style={{ textTransform: 'capitalize' }}>{nameKey}</th>
            {extraCol && <th>{extraCol.label}</th>}
            <th>Qty Sold</th><th>Revenue</th><th>% of Revenue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={r[nameKey]}>
              <td>{idx + 1}</td>
              <td style={{ fontWeight: 600 }}>{icon} {r[nameKey] || 'Unknown'}</td>
              {extraCol && <td style={{ textAlign: 'center', color: 'var(--muted)' }}>{extraCol.value(r)}</td>}
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
