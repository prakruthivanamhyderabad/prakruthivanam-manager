// ═══════════════════════════════════════════
// InvoiceMismatches.jsx
// ═══════════════════════════════════════════
import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Modal, FormGroup, FormRow, StatCard, Loading, useConfirm } from '../components/ui'
import { Autocomplete } from '../components/ui'
import { fmtDate, today, SUPPLIERS } from '../lib/utils'

export function InvoiceMismatches({ user, toast, setSyncStatus }) {
  const [invoices, setInvoices] = useState([])
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(false)
  const [editId, setEditId] = useState(null)
  const [expanded, setExpanded] = useState({})
  const { confirm, ConfirmDialog } = useConfirm()
  const [filters, setFilters] = useState({ search: '', status: '', from: '', to: '' })

  const [form, setForm] = useState({ invoice_no: '', supplier: '', date: today() })
  const [itemBuf, setItemBuf] = useState([])
  const [newItem, setNewItem] = useState({ item_name: '', type: 'short', invoiced_qty: '', received_qty: '' })

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    const [{ data: invs }, { data: items }, { data: prods }] = await Promise.all([
      supabase.from('invoices').select('*').order('date', { ascending: false }),
      supabase.from('invoice_items').select('*'),
      supabase.from('products').select('name,brand')
    ])
    const invMap = {}
    invs?.forEach(inv => { invMap[inv.id] = { ...inv, items: [] } })
    items?.forEach(item => { if (invMap[item.invoice_id]) invMap[item.invoice_id].items.push(item) })
    setInvoices(Object.values(invMap))
    setProducts(prods || [])
    setLoading(false)
  }

  function openNew() {
    setEditId(null)
    setForm({ invoice_no: '', supplier: '', date: today() })
    setItemBuf([])
    setNewItem({ item_name: '', type: 'short', invoiced_qty: '', received_qty: '' })
    setModal(true)
  }

  function openEdit(inv) {
    setEditId(inv.id)
    setForm({ invoice_no: inv.invoice_no, supplier: inv.supplier, date: inv.date || today() })
    setItemBuf(inv.items.map(i => ({ ...i })))
    setNewItem({ item_name: '', type: 'short', invoiced_qty: '', received_qty: '' })
    setModal(true)
  }

  function addItem() {
    if (!newItem.item_name) { toast('Enter item name.', 'error'); return }
    setItemBuf(prev => [...prev, { ...newItem, id: 'new-' + Date.now(), status: 'pending', credit_note: '', remarks: '' }])
    setNewItem({ item_name: '', type: 'short', invoiced_qty: '', received_qty: '' })
  }

  async function save() {
    if (!form.invoice_no || !form.supplier) { toast('Fill invoice number and supplier.', 'error'); return }
    if (!itemBuf.length) { toast('Add at least one item.', 'error'); return }
    setSyncStatus({ state: 'syncing', msg: 'Saving...' })
    let invId = editId
    if (editId) {
      await supabase.from('invoices').update({ invoice_no: form.invoice_no, supplier: form.supplier, date: form.date }).eq('id', editId)
      await supabase.from('invoice_items').delete().eq('invoice_id', editId)
    } else {
      const { data } = await supabase.from('invoices').insert({ invoice_no: form.invoice_no, supplier: form.supplier, date: form.date }).select()
      invId = data[0].id
    }
    await supabase.from('invoice_items').insert(itemBuf.map(i => ({
      invoice_id: invId, item_name: i.item_name, type: i.type,
      invoiced_qty: parseFloat(i.invoiced_qty) || 0, received_qty: parseFloat(i.received_qty) || 0,
      status: i.status || 'pending', credit_note: i.credit_note || '', remarks: i.remarks || ''
    })))
    setSyncStatus({ state: 'ok', msg: 'Saved ✓' })
    setModal(false); fetchAll(); toast('Invoice saved ✓', 'success')
  }

  async function del(id) {
    const ok = await confirm('Delete this invoice and all its items?'); if (!ok) return
    await supabase.from('invoices').delete().eq('id', id)
    fetchAll(); toast('Deleted.')
  }

  async function updateItemStatus(itemId, status) {
    await supabase.from('invoice_items').update({ status }).eq('id', itemId)
    fetchAll()
  }

  async function updateItemCN(itemId, credit_note) {
    await supabase.from('invoice_items').update({ credit_note }).eq('id', itemId)
  }

  const allItems = invoices.flatMap(i => i.items || [])
  const suppOptions = [...new Set([...SUPPLIERS, ...products.map(p => p.brand).filter(Boolean)])].sort()
  const itemOptions = products.map(p => p.name)

  let filtered = invoices
  if (filters.search) filtered = filtered.filter(i => i.supplier.toLowerCase().includes(filters.search.toLowerCase()) || i.invoice_no.toLowerCase().includes(filters.search.toLowerCase()))
  if (filters.status) filtered = filtered.filter(i => i.items.some(it => it.status === filters.status))
  if (filters.from) filtered = filtered.filter(i => (i.date || '') >= filters.from)
  if (filters.to) filtered = filtered.filter(i => (i.date || '') <= filters.to)

  return (
    <div>
      <ConfirmDialog />
      <div className="stats-grid">
        <StatCard num={allItems.filter(i => i.status === 'pending').length} label="Pending Items" color="amber" />
        <StatCard num={allItems.filter(i => i.status === 'partial').length} label="Partial Items" color="blue" />
        <StatCard num={allItems.filter(i => i.status === 'resolved').length} label="Resolved Items" color="green" />
        <StatCard num={allItems.filter(i => i.type === 'short').reduce((s, i) => s + ((i.invoiced_qty || 0) - (i.received_qty || 0)), 0)} label="Units Short" color="red" />
      </div>
      <div className="section-header">
        <h2 className="section-title">⚖️ Invoice Mismatches</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={openNew}>＋ Add Invoice</button>
        </div>
      </div>
      <div className="filter-bar">
        <input placeholder="Search supplier or invoice..." value={filters.search} onChange={e => setFilters({ ...filters, search: e.target.value })} />
        <select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}>
          <option value="">All Statuses</option><option value="pending">Pending</option><option value="partial">Partial</option><option value="resolved">Resolved</option>
        </select>
        <input type="date" style={{ maxWidth: 150 }} value={filters.from} onChange={e => setFilters({ ...filters, from: e.target.value })} />
        <input type="date" style={{ maxWidth: 150 }} value={filters.to} onChange={e => setFilters({ ...filters, to: e.target.value })} />
        <button className="btn btn-secondary btn-sm" onClick={() => setFilters({ search: '', status: '', from: '', to: '' })}>✕</button>
      </div>
      {loading ? <Loading /> : filtered.length === 0 ? (
        <div className="empty-state"><div className="empty-icon">⚖️</div><p>No invoices yet.</p></div>
      ) : filtered.map(inv => {
        const items = inv.items || []
        const pending = items.filter(i => i.status === 'pending').length
        const resolved = items.filter(i => i.status === 'resolved').length
        const isOpen = expanded[inv.id]
        return (
          <div key={inv.id} className="group-card animate-fade">
            <div className="group-card-header" onClick={() => setExpanded(prev => ({ ...prev, [inv.id]: !prev[inv.id] }))}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--muted)', transition: 'transform .2s', display: 'inline-block', transform: isOpen ? 'rotate(180deg)' : 'none' }}>▼</span>
                <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--sage-dark)' }}>📄 {inv.invoice_no}</span>
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>— {inv.supplier}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{fmtDate(inv.date)}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{items.length} items</span>
                <span className={`pill ${resolved === items.length && items.length > 0 ? 'pill-resolved' : pending > 0 ? 'pill-pending' : 'pill-partial'}`}>
                  {resolved === items.length && items.length > 0 ? 'All Resolved' : pending > 0 ? `${pending} Pending` : 'Partial'}
                </span>
                {user.role === 'manager' && <>
                  <button className="btn btn-sm" style={{ background: 'var(--sage-pale)', color: 'var(--sage-dark)' }} onClick={e => { e.stopPropagation(); openEdit(inv) }}>✏️</button>
                  <button className="btn btn-sm btn-danger" onClick={e => { e.stopPropagation(); del(inv.id) }}>🗑</button>
                </>}
              </div>
            </div>
            <div className={`group-card-body ${isOpen ? 'open' : ''}`}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 70px 70px 60px 120px 130px', background: 'var(--cream)', padding: '7px 14px', fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', borderBottom: '1px solid var(--cream-dark)' }}>
                <span>Item</span><span>Type</span><span>Invoiced</span><span>Received</span><span>Diff</span><span>Status</span><span>Credit Note</span>
              </div>
              {items.map(item => {
                const diff = (item.received_qty || 0) - (item.invoiced_qty || 0)
                return (
                  <div key={item.id} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 70px 70px 60px 120px 130px', alignItems: 'center', padding: '9px 14px', borderBottom: '1px solid var(--cream-dark)', fontSize: 13 }}>
                    <span style={{ fontWeight: 500 }}>{item.item_name}</span>
                    <span><span className={`pill pill-${item.type}`}>{item.type}</span></span>
                    <span style={{ textAlign: 'center' }}>{item.invoiced_qty}</span>
                    <span style={{ textAlign: 'center' }}>{item.received_qty}</span>
                    <span style={{ textAlign: 'center', fontWeight: 700, color: diff < 0 ? 'var(--red)' : 'var(--purple)' }}>{diff > 0 ? '+' : ''}{diff}</span>
                    <span>
                      <select value={item.status} onChange={e => updateItemStatus(item.id, e.target.value)}
                        style={{ fontSize: 11.5, padding: '3px 6px', border: '1px solid var(--cream-dark)', borderRadius: 5, background: 'var(--cream)', cursor: 'pointer', width: '100%' }}>
                        <option value="pending">Pending</option><option value="partial">Partial</option><option value="resolved">Resolved</option>
                      </select>
                    </span>
                    <span>
                      <input defaultValue={item.credit_note || ''} onBlur={e => updateItemCN(item.id, e.target.value)} placeholder="Credit Note No."
                        style={{ fontSize: 11.5, padding: '3px 7px', border: '1px solid var(--cream-dark)', borderRadius: 5, background: 'var(--cream)', width: '100%' }} />
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      <Modal open={modal} onClose={() => setModal(false)} title="⚖️ Invoice Mismatch" wide>
        <FormRow>
          <FormGroup label="Invoice No. *"><input className="form-input" value={form.invoice_no} onChange={e => setForm({ ...form, invoice_no: e.target.value })} placeholder="e.g. INV-2025-0456" /></FormGroup>
          <FormGroup label="Invoice Date *"><input className="form-input" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></FormGroup>
        </FormRow>
        <FormGroup label="Supplier *">
          <Autocomplete value={form.supplier} onChange={v => setForm({ ...form, supplier: v })} options={suppOptions} placeholder="Start typing supplier..." />
        </FormGroup>
        <div style={{ margin: '14px 0 8px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Items with Mismatch</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10, maxHeight: 240, overflowY: 'auto' }}>
          {itemBuf.length === 0 ? <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: 16 }}>No items yet.</p> :
            itemBuf.map((item, idx) => {
              const diff = (parseFloat(item.received_qty) || 0) - (parseFloat(item.invoiced_qty) || 0)
              return (
                <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 55px 55px 55px auto', gap: 8, alignItems: 'center', background: 'var(--cream)', padding: '8px 12px', borderRadius: 'var(--rs)', fontSize: 12.5 }}>
                  <span style={{ fontWeight: 500 }}>{item.item_name}</span>
                  <span className={`pill pill-${item.type}`}>{item.type}</span>
                  <span style={{ textAlign: 'center' }}>{item.invoiced_qty}</span>
                  <span style={{ textAlign: 'center' }}>{item.received_qty}</span>
                  <span style={{ fontWeight: 700, color: diff < 0 ? 'var(--red)' : 'var(--purple)', textAlign: 'center' }}>{diff > 0 ? '+' : ''}{diff}</span>
                  <button onClick={() => setItemBuf(prev => prev.filter((_, i) => i !== idx))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', fontSize: 14 }}>✕</button>
                </div>
              )
            })}
        </div>
        <div style={{ background: 'var(--cream)', borderRadius: 'var(--rs)', padding: 12, display: 'grid', gridTemplateColumns: '1fr 90px 80px 80px auto', gap: 8, alignItems: 'flex-end' }}>
          <div><label className="form-label">Item Name</label>
            <Autocomplete value={newItem.item_name} onChange={v => setNewItem({ ...newItem, item_name: v })} options={form.supplier ? products.filter(p => !form.supplier || p.brand === form.supplier).map(p => p.name) : products.map(p => p.name)} placeholder="Start typing item..." />
          </div>
          <div><label className="form-label">Type</label>
            <select className="form-input form-select" value={newItem.type} onChange={e => setNewItem({ ...newItem, type: e.target.value })}>
              <option value="short">Short</option><option value="excess">Excess</option><option value="wrong">Wrong</option>
            </select>
          </div>
          <div><label className="form-label">Invoiced</label><input className="form-input" type="number" value={newItem.invoiced_qty} onChange={e => setNewItem({ ...newItem, invoiced_qty: e.target.value })} placeholder="0" /></div>
          <div><label className="form-label">Received</label><input className="form-input" type="number" value={newItem.received_qty} onChange={e => setNewItem({ ...newItem, received_qty: e.target.value })} placeholder="0" onKeyDown={e => e.key === 'Enter' && addItem()} /></div>
          <button className="btn btn-primary" onClick={addItem} style={{ paddingTop: 9, paddingBottom: 9 }}>+</button>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>Save Invoice</button>
        </div>
      </Modal>
    </div>
  )
}

// ═══════════════════════════════════════════
// StockReturns.jsx
// ═══════════════════════════════════════════
export function StockReturns({ user, toast, setSyncStatus }) {
  const [groups, setGroups] = useState([])
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(false)
  const [editId, setEditId] = useState(null)
  const [expanded, setExpanded] = useState({})
  const { confirm, ConfirmDialog } = useConfirm()
  const [filters, setFilters] = useState({ search: '', status: '', from: '', to: '' })

  const [form, setForm] = useState({ date: today(), supplier: '', notes: '' })
  const [itemBuf, setItemBuf] = useState([])
  const [newItem, setNewItem] = useState({ item_name: '', reason: 'damaged', qty: '', resolution: 'credit-note' })

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    const [{ data: grps }, { data: items }, { data: prods }] = await Promise.all([
      supabase.from('return_groups').select('*').order('date', { ascending: false }),
      supabase.from('return_items').select('*'),
      supabase.from('products').select('name,brand')
    ])
    const map = {}
    grps?.forEach(g => { map[g.id] = { ...g, items: [] } })
    items?.forEach(i => { if (map[i.return_id]) map[i.return_id].items.push(i) })
    setGroups(Object.values(map))
    setProducts(prods || [])
    setLoading(false)
  }

  function openNew() { setEditId(null); setForm({ date: today(), supplier: '', notes: '' }); setItemBuf([]); setNewItem({ item_name: '', reason: 'damaged', qty: '', resolution: 'credit-note' }); setModal(true) }
  function openEdit(g) { setEditId(g.id); setForm({ date: g.date || today(), supplier: g.supplier, notes: g.notes || '' }); setItemBuf(g.items.map(i => ({ ...i }))); setModal(true) }

  function addItem() {
    if (!newItem.item_name || !newItem.qty) { toast('Enter item and qty.', 'error'); return }
    setItemBuf(prev => [...prev, { ...newItem, id: 'new-' + Date.now(), status: 'pending' }])
    setNewItem({ item_name: '', reason: 'damaged', qty: '', resolution: 'credit-note' })
  }

  async function save() {
    if (!form.supplier) { toast('Enter supplier.', 'error'); return }
    if (!itemBuf.length) { toast('Add at least one item.', 'error'); return }
    setSyncStatus({ state: 'syncing', msg: 'Saving...' })
    let gId = editId
    if (editId) {
      await supabase.from('return_groups').update({ date: form.date, supplier: form.supplier, notes: form.notes }).eq('id', editId)
      await supabase.from('return_items').delete().eq('return_id', editId)
    } else {
      const { data } = await supabase.from('return_groups').insert({ date: form.date, supplier: form.supplier, notes: form.notes }).select()
      gId = data[0].id
    }
    await supabase.from('return_items').insert(itemBuf.map(i => ({
      return_id: gId, item_name: i.item_name, reason: i.reason,
      qty: parseFloat(i.qty) || 0, resolution: i.resolution, status: i.status || 'pending'
    })))
    setSyncStatus({ state: 'ok', msg: 'Saved ✓' })
    setModal(false); fetchAll(); toast('Return saved ✓', 'success')
  }

  async function del(id) {
    const ok = await confirm('Delete this return?'); if (!ok) return
    await supabase.from('return_groups').delete().eq('id', id)
    fetchAll(); toast('Deleted.')
  }

  async function updateItemStatus(itemId, status) {
    await supabase.from('return_items').update({ status }).eq('id', itemId)
    fetchAll()
  }

  const allItems = groups.flatMap(g => g.items || [])
  const suppOptions = [...new Set([...SUPPLIERS, ...products.map(p => p.brand).filter(Boolean)])].sort()
  const itemOptions = products.map(p => p.name)
  const rl = { damaged: 'Damaged', expired: 'Expired', wrong: 'Wrong Item', overstock: 'Overstock' }
  const resl = { 'credit-note': 'Credit Note', replacement: 'Replacement', refund: 'Refund', tbd: 'TBD' }

  let filtered = groups
  if (filters.search) filtered = filtered.filter(g => g.supplier.toLowerCase().includes(filters.search.toLowerCase()))
  if (filters.status) filtered = filtered.filter(g => g.items.some(i => i.status === filters.status))
  if (filters.from) filtered = filtered.filter(g => (g.date || '') >= filters.from)
  if (filters.to) filtered = filtered.filter(g => (g.date || '') <= filters.to)

  return (
    <div>
      <ConfirmDialog />
      <div className="stats-grid">
        <StatCard num={allItems.filter(i => i.status === 'pending').length} label="Pending Items" color="amber" />
        <StatCard num={allItems.filter(i => i.status === 'partial').length} label="Partial Items" color="blue" />
        <StatCard num={allItems.filter(i => i.status === 'resolved').length} label="Resolved Items" color="green" />
        <StatCard num={allItems.reduce((s, i) => s + (i.qty || 0), 0)} label="Units Returned" color="red" />
      </div>
      <div className="section-header">
        <h2 className="section-title">↩️ Stock Returns</h2>
        <button className="btn btn-primary" onClick={openNew}>＋ Add Return</button>
      </div>
      <div className="filter-bar">
        <input placeholder="Search supplier..." value={filters.search} onChange={e => setFilters({ ...filters, search: e.target.value })} />
        <select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}>
          <option value="">All Statuses</option><option value="pending">Pending</option><option value="partial">Partial</option><option value="resolved">Resolved</option>
        </select>
        <input type="date" style={{ maxWidth: 150 }} value={filters.from} onChange={e => setFilters({ ...filters, from: e.target.value })} />
        <input type="date" style={{ maxWidth: 150 }} value={filters.to} onChange={e => setFilters({ ...filters, to: e.target.value })} />
        <button className="btn btn-secondary btn-sm" onClick={() => setFilters({ search: '', status: '', from: '', to: '' })}>✕</button>
      </div>
      {loading ? <Loading /> : filtered.length === 0 ? (
        <div className="empty-state"><div className="empty-icon">↩️</div><p>No returns logged yet.</p></div>
      ) : filtered.map(g => {
        const items = g.items || []
        const pending = items.filter(i => i.status === 'pending').length
        const resolved = items.filter(i => i.status === 'resolved').length
        const totalQty = items.reduce((s, i) => s + (i.qty || 0), 0)
        const isOpen = expanded[g.id]
        return (
          <div key={g.id} className="group-card animate-fade">
            <div className="group-card-header" onClick={() => setExpanded(prev => ({ ...prev, [g.id]: !prev[g.id] }))}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--muted)', transform: isOpen ? 'rotate(180deg)' : 'none', display: 'inline-block', transition: 'transform .2s' }}>▼</span>
                <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--sage-dark)' }}>↩️ {g.supplier}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{fmtDate(g.date)}</span>
                {g.notes && <span style={{ fontSize: 12, color: 'var(--muted)' }}>— {g.notes}</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{items.length} items · {totalQty} units</span>
                <span className={`pill ${resolved === items.length && items.length > 0 ? 'pill-resolved' : pending > 0 ? 'pill-pending' : 'pill-partial'}`}>
                  {resolved === items.length && items.length > 0 ? 'All Resolved' : pending > 0 ? `${pending} Pending` : 'Partial'}
                </span>
                {user.role === 'manager' && <>
                  <button className="btn btn-sm" style={{ background: 'var(--sage-pale)', color: 'var(--sage-dark)' }} onClick={e => { e.stopPropagation(); openEdit(g) }}>✏️</button>
                  <button className="btn btn-sm btn-danger" onClick={e => { e.stopPropagation(); del(g.id) }}>🗑</button>
                </>}
              </div>
            </div>
            <div className={`group-card-body ${isOpen ? 'open' : ''}`}>
              {items.map(item => (
                <div key={item.id} style={{ display: 'grid', gridTemplateColumns: '1fr 100px 60px 120px 120px', alignItems: 'center', padding: '9px 14px', borderBottom: '1px solid var(--cream-dark)', fontSize: 13, gap: 8 }}>
                  <span style={{ fontWeight: 500 }}>{item.item_name}</span>
                  <span className={`pill pill-${item.reason}`}>{rl[item.reason]}</span>
                  <span style={{ textAlign: 'center', fontWeight: 600 }}>{item.qty}</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{resl[item.resolution]}</span>
                  <select value={item.status} onChange={e => updateItemStatus(item.id, e.target.value)}
                    style={{ fontSize: 11.5, padding: '3px 6px', border: '1px solid var(--cream-dark)', borderRadius: 5, background: 'var(--cream)', cursor: 'pointer' }}>
                    <option value="pending">Pending</option><option value="partial">Partial</option><option value="resolved">Resolved</option>
                  </select>
                </div>
              ))}
            </div>
          </div>
        )
      })}

      <Modal open={modal} onClose={() => setModal(false)} title="↩️ Stock Return" wide>
        <FormRow>
          <FormGroup label="Return Date *"><input className="form-input" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></FormGroup>
          <FormGroup label="Supplier *">
            <Autocomplete value={form.supplier} onChange={v => setForm({ ...form, supplier: v })} options={suppOptions} placeholder="Start typing supplier..." />
          </FormGroup>
        </FormRow>
        <FormGroup label="Notes"><input className="form-input" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="e.g. Monthly returns to Timbaktu" /></FormGroup>
        <div style={{ margin: '14px 0 8px', fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Items Returned</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10, maxHeight: 220, overflowY: 'auto' }}>
          {itemBuf.length === 0 ? <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: 16 }}>No items yet.</p> :
            itemBuf.map((item, idx) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--cream)', padding: '8px 12px', borderRadius: 'var(--rs)', fontSize: 12.5 }}>
                <span style={{ flex: 1, fontWeight: 500 }}>{item.item_name}</span>
                <span className={`pill pill-${item.reason}`}>{rl[item.reason]}</span>
                <span style={{ fontWeight: 600 }}>{item.qty}</span>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>{resl[item.resolution]}</span>
                <button onClick={() => setItemBuf(prev => prev.filter((_, i) => i !== idx))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', fontSize: 14 }}>✕</button>
              </div>
            ))}
        </div>
        <div style={{ background: 'var(--cream)', borderRadius: 'var(--rs)', padding: 12, display: 'grid', gridTemplateColumns: '1fr 90px 70px 110px auto', gap: 8, alignItems: 'flex-end' }}>
          <div><label className="form-label">Item Name</label>
            <Autocomplete value={newItem.item_name} onChange={v => setNewItem({ ...newItem, item_name: v })} options={form.supplier ? products.filter(p => !form.supplier || p.brand === form.supplier).map(p => p.name) : products.map(p => p.name)} placeholder="Start typing item..." />
          </div>
          <div><label className="form-label">Reason</label>
            <select className="form-input form-select" value={newItem.reason} onChange={e => setNewItem({ ...newItem, reason: e.target.value })}>
              <option value="damaged">Damaged</option><option value="expired">Expired</option><option value="wrong">Wrong</option><option value="overstock">Overstock</option>
            </select>
          </div>
          <div><label className="form-label">Qty</label><input className="form-input" type="number" value={newItem.qty} onChange={e => setNewItem({ ...newItem, qty: e.target.value })} placeholder="0" onKeyDown={e => e.key === 'Enter' && addItem()} /></div>
          <div><label className="form-label">Resolution</label>
            <select className="form-input form-select" value={newItem.resolution} onChange={e => setNewItem({ ...newItem, resolution: e.target.value })}>
              <option value="credit-note">Credit Note</option><option value="replacement">Replacement</option><option value="refund">Refund</option><option value="tbd">TBD</option>
            </select>
          </div>
          <button className="btn btn-primary" onClick={addItem} style={{ paddingTop: 9, paddingBottom: 9 }}>+</button>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>Save Return</button>
        </div>
      </Modal>
    </div>
  )
}

// ═══════════════════════════════════════════
// StockAudit.jsx
// ═══════════════════════════════════════════
export function StockAudit({ user, toast, setSyncStatus }) {
  const [view, setView] = useState('main') // 'main' | 'session'
  const [sessions, setSessions] = useState([])
  const [products, setProducts] = useState([])
  const [currentSession, setCurrentSession] = useState(null)
  const [sessionItems, setSessionItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [newSessModal, setNewSessModal] = useState(false)
  const [sessForm, setSessForm] = useState({ name: '', type: 'full', category_filter: '' })
  const [barcodeInput, setBarcodeInput] = useState('')
  const [scanResult, setScanResult] = useState(null)
  const [countEntry, setCountEntry] = useState({ system_qty: '', physical_qty: '', notes: '' })
  const [showAll, setShowAll] = useState(false)
  const { confirm, ConfirmDialog } = useConfirm()

  const [productModal, setProductModal] = useState(false)
  const [prodForm, setProdForm] = useState({ name: '', barcode: '', category: '', brand: '', price: '' })
  const [prodEditId, setProdEditId] = useState(null)
  const [prodFilter, setProdFilter] = useState({ search: '', cat: '' })

  useEffect(() => { fetchAll() }, [])
  useEffect(() => { if (currentSession) fetchSessionItems() }, [currentSession])

  async function fetchAll() {
    const [{ data: sess }, { data: prods }] = await Promise.all([
      supabase.from('stock_sessions').select('*').order('created_at', { ascending: false }),
      supabase.from('products').select('*').order('name')
    ])
    setSessions(sess || [])
    setProducts(prods || [])
    setLoading(false)
  }

  async function fetchSessionItems() {
    const { data } = await supabase.from('stock_items').select('*').eq('session_id', currentSession.id)
    setSessionItems(data || [])
  }

  async function startSession() {
    if (!sessForm.name) { toast('Enter session name.', 'error'); return }
    const { data } = await supabase.from('stock_sessions').insert({ name: sessForm.name, type: sessForm.type, category_filter: sessForm.category_filter, created_by: user.role === 'manager' ? 'Manager' : 'Staff', status: 'open' }).select()
    setNewSessModal(false)
    fetchAll()
    openSession(data[0])
    toast('Session started ✓', 'success')
  }

  function openSession(sess) {
    setCurrentSession(sess)
    setView('session')
    setScanResult(null)
    setBarcodeInput('')
  }

  async function closeSession() {
    const ok = await confirm('Close this session? You can still view the report after.')
    if (!ok) return
    await supabase.from('stock_sessions').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', currentSession.id)
    fetchAll()
    setCurrentSession(prev => ({ ...prev, status: 'closed' }))
    toast('Session closed and saved ✓', 'success')
  }

  function lookupBarcode(code) {
    if (!code.trim()) return
    const prod = products.find(p => p.barcode === code || p.name.toLowerCase() === code.toLowerCase())
    if (!prod) {
      setScanResult({ error: `Not found: "${code}" — add it to Product Master first.` })
      return
    }
    const existing = sessionItems.find(i => i.product_id === prod.id)
    setScanResult({ product: prod, existing })
    setCountEntry({ system_qty: existing?.system_qty || '', physical_qty: existing?.physical_qty || '', notes: existing?.notes || '' })
    setBarcodeInput('')
  }

  async function saveCount() {
    if (!scanResult?.product) return
    const prod = scanResult.product
    const sysQty = parseFloat(countEntry.system_qty) || 0
    const phyQty = parseFloat(countEntry.physical_qty) || 0
    const variance = phyQty - sysQty
    const varianceValue = variance * (prod.price || 0)
    setSyncStatus({ state: 'syncing', msg: 'Saving count...' })
    await supabase.from('stock_items').upsert({
      session_id: currentSession.id, product_id: prod.id,
      product_name: prod.name, barcode: prod.barcode || '', category: prod.category || '',
      brand: prod.brand || '', price: prod.price || 0,
      system_qty: sysQty, physical_qty: phyQty,
      variance, variance_value: varianceValue,
      notes: countEntry.notes, counted_by: user.role === 'manager' ? 'Manager' : 'Staff',
      counted_at: new Date().toISOString()
    }, { onConflict: 'session_id,product_id' })
    setSyncStatus({ state: 'ok', msg: 'Count saved ✓' })
    setScanResult({ success: `${prod.name} — Variance: ${variance >= 0 ? '+' : ''}${variance.toFixed(2)} ${prod.brand || ''}` })
    fetchSessionItems()
  }

  async function delSession(id) {
    const ok = await confirm('Delete this session and all its data?'); if (!ok) return
    await supabase.from('stock_sessions').delete().eq('id', id)
    fetchAll(); toast('Deleted.')
  }

  // Product master
  function openProdNew() { setProdEditId(null); setProdForm({ name: '', barcode: '', category: '', brand: '', price: '' }); setProductModal(true) }
  function openProdEdit(p) { setProdEditId(p.id); setProdForm({ name: p.name, barcode: p.barcode || '', category: p.category || '', brand: p.brand || '', price: p.price || '' }); setProductModal(true) }

  async function saveProd() {
    if (!prodForm.name) { toast('Product name required.', 'error'); return }
    const payload = { name: prodForm.name, barcode: prodForm.barcode, category: prodForm.category, brand: prodForm.brand, price: parseFloat(prodForm.price) || 0, updated_at: new Date().toISOString() }
    if (prodEditId) {
      await supabase.from('products').update(payload).eq('id', prodEditId)
    } else {
      await supabase.from('products').insert(payload)
    }
    setProductModal(false); fetchAll(); toast('Product saved ✓', 'success')
  }

  async function delProd(id) {
    const ok = await confirm('Delete this product?'); if (!ok) return
    await supabase.from('products').delete().eq('id', id)
    fetchAll(); toast('Deleted.')
  }

  async function handleCSV(e) {
    const file = e.target.files[0]; if (!file) return
    const text = await file.text()
    const lines = text.split('\n').filter(l => l.trim())
    if (lines.length < 2) { toast('CSV must have header + data rows.', 'error'); return }
    const hdr = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''))
    const nameI = hdr.findIndex(h => h.includes('name') || h.includes('item'))
    if (nameI < 0) { toast('CSV must have a "name" column.', 'error'); return }
    const bcI = hdr.findIndex(h => h.includes('barcode') || h.includes('ean'))
    const catI = hdr.findIndex(h => h.includes('cat'))
    const brandI = hdr.findIndex(h => h.includes('brand') || h.includes('unit'))
    const priceI = hdr.findIndex(h => h.includes('price') || h.includes('mrp'))
    const rows = lines.slice(1).map(line => {
      const cols = line.split(',').map(c => c.trim().replace(/^["']|["']$/g, ''))
      const name = cols[nameI]; if (!name) return null
      return { name, barcode: bcI >= 0 ? cols[bcI] : '', category: catI >= 0 ? cols[catI] : '', brand: brandI >= 0 ? cols[brandI] : '', price: priceI >= 0 ? parseFloat(cols[priceI]) || 0 : 0, updated_at: new Date().toISOString() }
    }).filter(Boolean)
    // Delete existing products with same names then insert fresh
    const names = rows.map(r => r.name)
    await supabase.from('products').delete().in('name', names)
    const { error } = await supabase.from('products').insert(rows)
    if (error) { toast('Upload failed: ' + error.message, 'error'); return }
    fetchAll(); toast(`${rows.length} products imported ✓`, 'success')
    e.target.value = ''
  }

  const cats = [...new Set(products.map(p => p.category).filter(Boolean))].sort()
  let filteredProds = products
  if (prodFilter.search) filteredProds = filteredProds.filter(p => p.name.toLowerCase().includes(prodFilter.search.toLowerCase()) || (p.barcode || '').includes(prodFilter.search))
  if (prodFilter.cat) filteredProds = filteredProds.filter(p => p.category === prodFilter.cat)

  const varItems = sessionItems.filter(i => Math.abs(i.variance || 0) > 0.001)
  const dispItems = showAll ? sessionItems : varItems

  if (view === 'session' && currentSession) {
    const variance_count = varItems.length
    const remaining = products.length - sessionItems.length
    return (
      <div>
        <ConfirmDialog />
        {/* Session header */}
        <div className="card" style={{ padding: '14px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 19, fontWeight: 700, color: 'var(--sage-dark)' }}>{currentSession.name}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{currentSession.date} · {currentSession.status}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary btn-sm" onClick={() => { setView('main'); setCurrentSession(null); fetchAll() }}>← Back</button>
            {currentSession.status === 'open' && <button className="btn btn-sm" style={{ background: 'var(--red)', color: 'var(--white)' }} onClick={closeSession}>✓ Close Session</button>}
          </div>
        </div>
        <div className="stats-grid">
          <StatCard num={products.length} label="Total Products" />
          <StatCard num={sessionItems.length} label="Counted" color="green" />
          <StatCard num={Math.max(0, remaining)} label="Remaining" color="amber" />
          <StatCard num={variance_count} label="Variances" color="red" />
        </div>
        {currentSession.status === 'open' && (
          <div className="card" style={{ padding: '16px 18px', marginBottom: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--sage-dark)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 10 }}>📷 Scan or Type Barcode</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input className="form-input" value={barcodeInput} onChange={e => setBarcodeInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && lookupBarcode(barcodeInput)} placeholder="Scan barcode or type product name and press Enter..." style={{ border: '2px solid var(--sage)' }} autoFocus />
              <button className="btn btn-primary" onClick={() => lookupBarcode(barcodeInput)}>Search</button>
            </div>
            {scanResult && (
              <div>
                {scanResult.error && <div style={{ background: 'var(--red-l)', color: 'var(--red)', padding: '10px 14px', borderRadius: 'var(--rs)', fontSize: 13 }}>❌ {scanResult.error}</div>}
                {scanResult.success && <div style={{ background: 'var(--green-l)', color: 'var(--green)', padding: '10px 14px', borderRadius: 'var(--rs)', fontSize: 13, fontWeight: 600 }}>✓ {scanResult.success}</div>}
                {scanResult.product && !scanResult.success && (
                  <div style={{ background: 'var(--sage-pale)', borderRadius: 'var(--r)', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>{scanResult.product.name}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{scanResult.product.category} · {scanResult.product.brand}</div>
                      {scanResult.existing && <div style={{ fontSize: 11.5, color: 'var(--amber)', marginTop: 3 }}>⚠️ Already counted — updating</div>}
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <div><label className="form-label">System Qty</label><input className="form-input" type="number" value={countEntry.system_qty} onChange={e => setCountEntry(prev => ({ ...prev, system_qty: e.target.value }))} style={{ width: 90, textAlign: 'center', fontSize: 15, fontWeight: 600 }} /></div>
                      <div><label className="form-label">Physical Qty</label><input className="form-input" type="number" value={countEntry.physical_qty} onChange={e => setCountEntry(prev => ({ ...prev, physical_qty: e.target.value }))} style={{ width: 90, textAlign: 'center', fontSize: 15, fontWeight: 600 }} autoFocus /></div>
                      <div>
                        {countEntry.system_qty !== '' && countEntry.physical_qty !== '' && (() => {
                          const v = (parseFloat(countEntry.physical_qty) || 0) - (parseFloat(countEntry.system_qty) || 0)
                          const col = Math.abs(v) < 0.001 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--amber)'
                          return <div style={{ textAlign: 'center' }}><div style={{ fontSize: 10, color: col, fontWeight: 700, textTransform: 'uppercase' }}>Variance</div><div style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, fontWeight: 700, color: col }}>{v >= 0 ? '+' : ''}{v.toFixed(2)}</div></div>
                        })()}
                      </div>
                      <div>
                        <label className="form-label">Notes</label>
                        <input className="form-input" value={countEntry.notes} onChange={e => setCountEntry(prev => ({ ...prev, notes: e.target.value }))} placeholder="Optional" style={{ width: 140 }} />
                      </div>
                      <button className="btn btn-primary" onClick={saveCount}>✓ Save Count</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--cream-dark)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--sage-dark)' }}>Count List</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} style={{ accentColor: 'var(--sage)' }} />
              Show all (including matched)
            </label>
          </div>
          <div className="table-wrap">
            <table className="data-table" style={{ minWidth: 700 }}>
              <thead><tr><th>Product</th><th>Barcode</th><th>Category</th><th>System Qty</th><th>Physical Qty</th><th>Variance</th><th>Variance Value</th><th>Counted By</th></tr></thead>
              <tbody>
                {dispItems.length === 0 ? <tr><td colSpan={8} style={{ textAlign: 'center', padding: 28, color: 'var(--muted)' }}>{showAll ? 'No items counted yet.' : 'No variances — all items match!'}</td></tr> :
                  dispItems.map(i => {
                    const v = i.variance || 0
                    const col = Math.abs(v) < 0.001 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--amber)'
                    return (
                      <tr key={i.id}>
                        <td><strong>{i.product_name}</strong></td>
                        <td><code style={{ fontSize: 11, background: 'var(--cream-dark)', padding: '1px 5px', borderRadius: 3 }}>{i.barcode || '—'}</code></td>
                        <td>{i.category || '—'}</td>
                        <td style={{ textAlign: 'center' }}>{i.system_qty}</td>
                        <td style={{ textAlign: 'center' }}>{i.physical_qty}</td>
                        <td><span style={{ fontWeight: 700, color: col }}>{v >= 0 ? '+' : ''}{v.toFixed(2)}</span></td>
                        <td style={{ color: (i.variance_value || 0) !== 0 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>{i.variance_value ? `₹${Math.abs(i.variance_value).toFixed(2)}` : '—'}</td>
                        <td><small style={{ color: 'var(--muted)' }}>{i.counted_by}</small></td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <ConfirmDialog />
      <div className="stats-grid">
        <StatCard num={products.length} label="Products" />
        <StatCard num={sessions.filter(s => s.status === 'open').length} label="Open Sessions" color="amber" />
        <StatCard num={sessions.filter(s => s.status === 'closed').length} label="Completed" color="green" />
        <StatCard num={sessions[0] ? sessions[0].name : '—'} label="Latest Session" color="blue" />
      </div>

      {/* Sessions */}
      <div className="section-header">
        <h2 className="section-title">🔍 Stock Check Sessions</h2>
        <button className="btn btn-primary" onClick={() => setNewSessModal(true)}>＋ New Stock Check</button>
      </div>
      {loading ? <Loading /> : sessions.length === 0 ? (
        <div className="empty-state" style={{ marginBottom: 24 }}><div className="empty-icon">📦</div><p>No sessions yet.</p></div>
      ) : (
        <div className="card table-wrap" style={{ marginBottom: 24 }}>
          <table className="data-table">
            <thead><tr><th>Session Name</th><th>Date</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {sessions.map(s => (
                <tr key={s.id}>
                  <td><strong>{s.name}</strong><br /><small style={{ color: 'var(--muted)' }}>{s.type} {s.category_filter ? `· ${s.category_filter}` : ''}</small></td>
                  <td>{fmtDate(s.created_at)}</td>
                  <td><span className={`pill pill-${s.status}`}>{s.status}</span></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm" style={{ background: s.status === 'open' ? 'var(--blue-l)' : 'var(--sage-pale)', color: s.status === 'open' ? 'var(--blue)' : 'var(--sage-dark)', marginRight: 4 }} onClick={() => openSession(s)}>
                      {s.status === 'open' ? '▶ Continue' : '📊 Report'}
                    </button>
                    {user.role === 'manager' && <button className="btn btn-sm btn-danger" onClick={() => delSession(s.id)}>🗑</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Product Master */}
      <div className="section-header">
        <h2 className="section-title" style={{ fontSize: 18 }}>🗂 Product Master</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="btn btn-primary btn-sm" style={{ cursor: 'pointer' }}>
            ⬆ Upload CSV <input type="file" accept=".csv" onChange={handleCSV} style={{ display: 'none' }} />
          </label>
          <button className="btn btn-secondary btn-sm" onClick={() => {
            const csv = 'name,barcode,category,brand,price\nCold Pressed Groundnut Oil 1L,8901234567890,Oils,Timbaktu,320\nFoxtail Millet 500g,8901234567891,Millets,GoDesi,85'
            const a = document.createElement('a'); a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv); a.download = 'product_sample.csv'; a.click()
          }}>⬇ Sample CSV</button>
          <button className="btn btn-primary btn-sm" onClick={openProdNew}>＋ Add Product</button>
        </div>
      </div>
      <div className="filter-bar">
        <input placeholder="Search by name or barcode..." value={prodFilter.search} onChange={e => setProdFilter({ ...prodFilter, search: e.target.value })} />
        <select value={prodFilter.cat} onChange={e => setProdFilter({ ...prodFilter, cat: e.target.value })}>
          <option value="">All Categories</option>
          {cats.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="card table-wrap">
        <table className="data-table">
          <thead><tr><th>Product Name</th><th>Barcode</th><th>Category</th><th>Brand</th><th>Price</th><th>Actions</th></tr></thead>
          <tbody>
            {filteredProds.length === 0 ? <tr><td colSpan={6} style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>No products yet. Upload CSV or add manually.</td></tr> :
              filteredProds.map(p => (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong></td>
                  <td><code style={{ fontSize: 11, background: 'var(--cream-dark)', padding: '1px 5px', borderRadius: 3 }}>{p.barcode || '—'}</code></td>
                  <td>{p.category || '—'}</td>
                  <td>{p.brand || '—'}</td>
                  <td>{p.price ? `₹${p.price}` : '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm" style={{ background: 'var(--sage-pale)', color: 'var(--sage-dark)', marginRight: 4 }} onClick={() => openProdEdit(p)}>✏️</button>
                    <button className="btn btn-sm btn-danger" onClick={() => delProd(p.id)}>🗑</button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* New Session Modal */}
      <Modal open={newSessModal} onClose={() => setNewSessModal(false)} title="📦 Start Stock Check">
        <FormGroup label="Session Name *"><input className="form-input" value={sessForm.name} onChange={e => setSessForm({ ...sessForm, name: e.target.value })} placeholder="e.g. April Full Count, Oils Check 28 Apr" /></FormGroup>
        <FormRow>
          <FormGroup label="Type">
            <select className="form-input form-select" value={sessForm.type} onChange={e => setSessForm({ ...sessForm, type: e.target.value })}>
              <option value="full">Full Store Count</option><option value="category">Category Check</option><option value="spot">Spot Check</option>
            </select>
          </FormGroup>
          <FormGroup label="Filter by Category">
            <select className="form-input form-select" value={sessForm.category_filter} onChange={e => setSessForm({ ...sessForm, category_filter: e.target.value })}>
              <option value="">All Categories</option>
              {cats.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </FormGroup>
        </FormRow>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, lineHeight: 1.6 }}>Staff will scan barcodes and enter physical vs system quantities. Session stays open until closed.</p>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setNewSessModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={startSession}>▶ Start Session</button>
        </div>
      </Modal>

      {/* Product Modal */}
      <Modal open={productModal} onClose={() => setProductModal(false)} title={prodEditId ? '✏️ Edit Product' : '📦 Add Product'}>
        <FormRow>
          <FormGroup label="Product Name *"><input className="form-input" value={prodForm.name} onChange={e => setProdForm({ ...prodForm, name: e.target.value })} placeholder="e.g. Cold Pressed Groundnut Oil 1L" /></FormGroup>
          <FormGroup label="Barcode / SKU"><input className="form-input" value={prodForm.barcode} onChange={e => setProdForm({ ...prodForm, barcode: e.target.value })} placeholder="Scan or type" /></FormGroup>
        </FormRow>
        <FormRow>
          <FormGroup label="Category"><input className="form-input" value={prodForm.category} onChange={e => setProdForm({ ...prodForm, category: e.target.value })} placeholder="e.g. Oils, Millets, Spices" /></FormGroup>
          <FormGroup label="Brand"><input className="form-input" value={prodForm.brand} onChange={e => setProdForm({ ...prodForm, brand: e.target.value })} placeholder="e.g. Timbaktu, Pure & Sure" /></FormGroup>
        </FormRow>
        <FormGroup label="Price (₹)"><input className="form-input" type="number" value={prodForm.price} onChange={e => setProdForm({ ...prodForm, price: e.target.value })} placeholder="0.00" /></FormGroup>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setProductModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={saveProd}>Save Product</button>
        </div>
      </Modal>
    </div>
  )
}

// ═══════════════════════════════════════════
// QuickLaunch.jsx
// ═══════════════════════════════════════════
export function QuickLaunch({ user, toast, setSyncStatus }) {
  const [shortcuts, setShortcuts] = useState([])
  const [modal, setModal] = useState(false)
  const [form, setForm] = useState({ name: '', icon: '', url: '', hint: '' })
  const [loading, setLoading] = useState(true)

  useEffect(() => { fetch() }, [])

  async function fetch() {
    const { data } = await supabase.from('shortcuts').select('*').order('sort_order')
    setShortcuts(data || [])
    setLoading(false)
  }

  function launch(url) {
    if (url.includes('|')) {
      const [appUrl, webUrl] = url.split('|')
      const iframe = document.createElement('iframe')
      iframe.style.display = 'none'
      document.body.appendChild(iframe)
      iframe.src = appUrl
      setTimeout(() => { document.body.removeChild(iframe); window.open(webUrl, '_blank') }, 1500)
    } else {
      window.open(url, '_blank')
    }
  }

  async function add() {
    if (!form.name || !form.icon || !form.url) { toast('Fill name, icon and URL.', 'error'); return }
    await supabase.from('shortcuts').insert({ ...form, sort_order: shortcuts.length + 1 })
    setModal(false); setForm({ name: '', icon: '', url: '', hint: '' }); fetch()
    toast('Shortcut added ✓', 'success')
  }

  async function del(id) {
    if (!confirm('Remove this shortcut?')) return
    await supabase.from('shortcuts').delete().eq('id', id)
    fetch(); toast('Removed.')
  }

  return (
    <div>
      <div className="section-header">
        <h2 className="section-title">🚀 Quick Launch</h2>
        {user.role === 'manager' && <button className="btn btn-primary" onClick={() => setModal(true)}>＋ Add Shortcut</button>}
      </div>
      {loading ? <Loading /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px,1fr))', gap: 14, marginBottom: 24 }}>
          {shortcuts.map(s => (
            <div key={s.id} className="card animate-fade" style={{ padding: '20px 16px', textAlign: 'center', cursor: 'pointer', position: 'relative', transition: 'all .2s' }}
              onClick={() => launch(s.url)}
              onMouseOver={e => e.currentTarget.style.transform = 'translateY(-2px)'}
              onMouseOut={e => e.currentTarget.style.transform = 'none'}>
              {user.role === 'manager' && (
                <button onClick={e => { e.stopPropagation(); del(s.id) }}
                  style={{ position: 'absolute', top: 7, right: 7, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red-l)', fontSize: 13 }}
                  onMouseOver={e => e.target.style.color = 'var(--red)'}
                  onMouseOut={e => e.target.style.color = 'var(--red-l)'}>✕</button>
              )}
              <div style={{ fontSize: 36, marginBottom: 8 }}>{s.icon}</div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</div>
              {s.hint && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3 }}>{s.hint}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="card" style={{ padding: '16px 20px' }}>
        <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.7 }}>💡 <strong>Tip:</strong> Tap any shortcut to open directly. On mobile, if the app is installed it opens automatically — otherwise opens in browser. Manager can add/remove shortcuts.</p>
      </div>
      <Modal open={modal} onClose={() => setModal(false)} title="🚀 Add Shortcut">
        <FormGroup label="App Name *"><input className="form-input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Vyapar" /></FormGroup>
        <FormGroup label="Icon (emoji) *"><input className="form-input" value={form.icon} onChange={e => setForm({ ...form, icon: e.target.value })} placeholder="e.g. 📦" maxLength={4} /></FormGroup>
        <FormGroup label="URL *"><input className="form-input" value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} placeholder="https://... or app://... (use | to separate app and web URL)" /></FormGroup>
        <FormGroup label="Description"><input className="form-input" value={form.hint} onChange={e => setForm({ ...form, hint: e.target.value })} placeholder="e.g. Billing & Inventory" /></FormGroup>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={add}>Add Shortcut</button>
        </div>
      </Modal>
    </div>
  )
}

// ═══════════════════════════════════════════
// Settings.jsx
// ═══════════════════════════════════════════
export function Settings({ onClose, toast }) {
  const [form, setForm] = useState({ manager_pin: '', staff_pin: '', manager_whatsapp: '', wa_token: '', wa_phone_id: '', wa_recipient: '' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    supabase.from('settings').select('key,value').then(({ data }) => {
      const s = {}
      data?.forEach(r => { s[r.key] = r.value })
      setForm({ manager_pin: s.manager_pin || '', staff_pin: s.staff_pin || '', manager_whatsapp: s.manager_whatsapp || '', wa_token: s.wa_token || '', wa_phone_id: s.wa_phone_id || '', wa_recipient: s.wa_recipient || '' })
      setLoading(false)
    })
  }, [])

  async function save() {
    setSaving(true)
    const rows = [
      { key: 'manager_pin', value: form.manager_pin },
      { key: 'staff_pin', value: form.staff_pin },
      { key: 'manager_whatsapp', value: form.manager_whatsapp },
      { key: 'wa_token', value: form.wa_token },
      { key: 'wa_phone_id', value: form.wa_phone_id },
      { key: 'wa_recipient', value: form.wa_recipient }
    ]
    const { error } = await supabase.from('settings').upsert(rows, { onConflict: 'key' })
    setSaving(false)
    if (error) { toast('Save failed: ' + error.message, 'error'); return }
    toast('Settings saved ✓', 'success')
    onClose()
  }

  return (
    <Modal open={true} onClose={onClose} title="⚙️ Settings">
      {loading ? <Loading /> : (
        <>
          <FormGroup label="Manager PIN"><input className="form-input" type="password" value={form.manager_pin} onChange={e => setForm({ ...form, manager_pin: e.target.value })} placeholder="Manager login PIN" /></FormGroup>
          <FormGroup label="Staff PIN"><input className="form-input" type="password" value={form.staff_pin} onChange={e => setForm({ ...form, staff_pin: e.target.value })} placeholder="Staff login PIN" /></FormGroup>
          <FormGroup label="Manager WhatsApp"><input className="form-input" type="tel" value={form.manager_whatsapp} onChange={e => setForm({ ...form, manager_whatsapp: e.target.value })} placeholder="+44 7700 900000" /></FormGroup>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.6 }}>PIN changes take effect immediately across all devices.</p>
          <div style={{ borderTop: '1px solid var(--cream-dark)', marginTop: 16, paddingTop: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--brown-dark)', marginBottom: 12 }}>📱 WhatsApp Notifications</div>
            <FormGroup label="Meta Access Token"><input className="form-input" type="password" value={form.wa_token} onChange={e => setForm({ ...form, wa_token: e.target.value })} placeholder="Paste your Meta access token..." /></FormGroup>
            <FormGroup label="Phone Number ID"><input className="form-input" value={form.wa_phone_id} onChange={e => setForm({ ...form, wa_phone_id: e.target.value })} placeholder="e.g. 1191865447332581" /></FormGroup>
            <FormGroup label="Recipient Number (no + or spaces)"><input className="form-input" value={form.wa_recipient} onChange={e => setForm({ ...form, wa_recipient: e.target.value })} placeholder="e.g. 919876543210" /></FormGroup>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save Settings'}</button>
          </div>
        </>
      )}
    </Modal>
  )
}
