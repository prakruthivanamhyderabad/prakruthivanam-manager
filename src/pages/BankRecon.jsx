import { useState, useEffect } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { Modal, FormGroup, StatCard, Loading } from '../components/ui'
import { fmt, fmtDate, thisMonth } from '../lib/utils'

// Equitas statement classification rules
function classifyTransaction(narration, withdrawal, deposit) {
  const n = (narration || '').toUpperCase()
  if (deposit > 0) {
    if (n.includes('PAYTM PAYMENTS')) return { category: 'paytm', label: 'Paytm Settlement', is_business: true }
    if (n.includes('MERCHANT SETTLEMENT')) return { category: 'card', label: 'Card Settlement', is_business: true }
    if (n.includes('SHIPROCKET')) return { category: 'shiprocket', label: 'Shiprocket COD', is_business: true }
    if (n.includes('TENSOR LOGISTICS')) return { category: 'shipmozo', label: 'Shipmozo COD', is_business: true }
    if (n.includes('ATM CASH DEPOSIT')) return { category: 'cash_deposit', label: 'Cash Deposit', is_business: true }
    if (n.includes('UPI REF')) return { category: 'upi_in', label: 'UPI Receipt', is_business: true }
    if (n.includes('RTGS CR') || n.includes('NEFT CR')) return { category: 'other_in', label: 'Other Credit', is_business: false }
    return { category: 'unclassified', label: 'Unclassified Credit', is_business: false }
  }
  if (withdrawal > 0) {
    if (n.includes('SALARY') || n.includes('BALU') || n.includes('KALAMATA')) return { category: 'salary', label: 'Salary Payment', is_business: true }
    if (n.includes('BBPS') || n.includes('TGSPDCL')) return { category: 'electricity', label: 'Electricity Bill', is_business: true }
    if (n.includes('SMS ALRT') || n.includes('CHGS+GST')) return { category: 'bank_charges', label: 'Bank Charges', is_business: true }
    // Known suppliers
    const suppliers = ['AROGYA RAHASYA', 'TIMBAKTU', 'SURABHI', 'GODESI', 'CAST IRON', 'DATHU', 'ADAVI', 'HERBAL STRATEGI', 'PURE', 'GCC', 'SRUJANA', 'GOWADHAR', 'CREDENTIAL', 'DOTPE', 'PADMASHREE']
    if (suppliers.some(s => n.includes(s))) return { category: 'supplier', label: 'Supplier Payment', is_business: true }
    if (n.includes('NEFT DR') || n.includes('IMP P2A') || n.includes('RIB')) return { category: 'unclassified', label: 'Unclassified Debit', is_business: false }
    return { category: 'unclassified', label: 'Unclassified', is_business: false }
  }
  return { category: 'unclassified', label: 'Unclassified', is_business: false }
}

function parseEquitasXLSX(data) {
  console.log('Parser: total rows =', data.length)
  if (data.length > 18) console.log('Parser: row 18 (expected header):', data[18])
  if (data.length > 19) console.log('Parser: row 19 (expected first data):', data[19])

  // Find header row by looking for 'Narration' anywhere
  let headerRow = -1
  let narrationCol = -1
  let dateCol = -1
  let refCol = -1
  let withdrawalCol = -1
  let depositCol = -1
  let balanceCol = -1

  for (let i = 0; i < Math.min(data.length, 30); i++) {
    const row = data[i] || []
    for (let j = 0; j < row.length; j++) {
      const v = String(row[j] || '').trim()
      if (v === 'Narration') { headerRow = i; narrationCol = j }
      if (v === 'Date') dateCol = j
      if (v === 'Reference No. / Cheque No.' || v.startsWith('Reference')) refCol = j
      if (v.startsWith('Withdrawal')) withdrawalCol = j
      if (v.startsWith('Deposit')) depositCol = j
      if (v.startsWith('ClosingBalance') || v.startsWith('Closing')) balanceCol = j
    }
    if (headerRow >= 0 && narrationCol >= 0 && dateCol >= 0) break
  }

  console.log('Parser: header row =', headerRow, 'cols:', { dateCol, narrationCol, withdrawalCol, depositCol, balanceCol })

  if (headerRow < 0 || narrationCol < 0 || dateCol < 0) {
    console.error('Parser: could not find header row')
    return []
  }

  const txns = []
  for (let i = headerRow + 1; i < data.length; i++) {
    const row = data[i] || []
    const dateVal = row[dateCol]
    const narration = String(row[narrationCol] || '').trim()

    if (!dateVal && !narration) continue
    if (String(narration).includes('End of') || String(dateVal || '').includes('End of')) break

    const refNo = String(row[refCol] || '').trim()
    const withdrawal = parseFloat(String(row[withdrawalCol] || '').replace(/,/g, '')) || 0
    const deposit = parseFloat(String(row[depositCol] || '').replace(/,/g, '')) || 0
    const balance = parseFloat(String(row[balanceCol] || '').replace(/,/g, '')) || 0

    if (!narration && !withdrawal && !deposit) continue

    // Parse date - handle Date object, string '01-Apr-2026', or '01/04/2026'
    let dateStr = ''
    if (dateVal instanceof Date) {
      dateStr = dateVal.toISOString().slice(0, 10)
    } else {
      const s = String(dateVal).trim()
      // Format: 01-Apr-2026
      const m1 = s.match(/^(\d{1,2})[-/]([A-Za-z]{3})[-/](\d{4})$/)
      if (m1) {
        const months = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' }
        const mo = months[m1[2].slice(0,1).toUpperCase() + m1[2].slice(1).toLowerCase()]
        if (mo) dateStr = `${m1[3]}-${mo}-${m1[1].padStart(2,'0')}`
      }
      // Format: 01-04-2026 or 01/04/2026
      if (!dateStr) {
        const m2 = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/)
        if (m2) dateStr = `${m2[3]}-${m2[2].padStart(2,'0')}-${m2[1].padStart(2,'0')}`
      }
      // Format: 2026-04-01
      if (!dateStr) {
        const m3 = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
        if (m3) dateStr = `${m3[1]}-${m3[2]}-${m3[3]}`
      }
    }
    if (!dateStr) {
      console.log('Skipped row, bad date:', dateVal, 'row:', row)
      continue
    }

    const { category, label, is_business } = classifyTransaction(narration, withdrawal, deposit)
    txns.push({ dateStr, refNo, narration, withdrawal, deposit, balance, category, label, is_business })
  }

  console.log('Parser: parsed', txns.length, 'transactions')
  return txns
}

const CAT_LABELS = {
  paytm: { label: 'Paytm Settlement', color: 'var(--blue)', bg: 'var(--blue-l)', icon: '💙' },
  card: { label: 'Card Settlement', color: 'var(--purple)', bg: 'var(--purple-l)', icon: '💳' },
  shiprocket: { label: 'Shiprocket COD', color: 'var(--green)', bg: 'var(--green-l)', icon: '🚀' },
  shipmozo: { label: 'Shipmozo COD', color: 'var(--green)', bg: 'var(--green-l)', icon: '📦' },
  cash_deposit: { label: 'Cash Deposit', color: 'var(--amber)', bg: 'var(--amber-l)', icon: '💵' },
  upi_in: { label: 'UPI Receipt', color: 'var(--blue)', bg: 'var(--blue-l)', icon: '📱' },
  salary: { label: 'Salary', color: 'var(--red)', bg: 'var(--red-l)', icon: '👥' },
  electricity: { label: 'Electricity', color: 'var(--amber)', bg: 'var(--amber-l)', icon: '⚡' },
  bank_charges: { label: 'Bank Charges', color: 'var(--muted)', bg: 'var(--cream)', icon: '🏦' },
  supplier: { label: 'Supplier Payment', color: 'var(--red)', bg: 'var(--red-l)', icon: '🏪' },
  other_in: { label: 'Other Credit', color: 'var(--muted)', bg: 'var(--cream)', icon: '↙️' },
  unclassified: { label: 'Unclassified', color: 'var(--red)', bg: 'var(--red-l)', icon: '❓' },
}

export default function BankRecon({ user, toast, setSyncStatus }) {
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [month, setMonth] = useState(thisMonth())
  const [activeTab, setActiveTab] = useState('summary') // 'summary' | 'all' | 'unclassified'
  const [editModal, setEditModal] = useState(null)
  const [editForm, setEditForm] = useState({ category: '', is_business: true, notes: '' })

  useEffect(() => { fetchTransactions() }, [month])

  async function fetchTransactions() {
    setLoading(true)
    const { data } = await supabase.from('bank_transactions').select('*').eq('month', month).order('date', { ascending: true })
    setTransactions(data || [])
    setLoading(false)
  }

  async function handleUpload(e) {
    const file = e.target.files[0]; if (!file) return
    setUploading(true)
    setSyncStatus({ state: 'syncing', msg: 'Parsing bank statement...' })

    try {
      // Read xlsx using SheetJS
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })

      const txns = parseEquitasXLSX(data)
      if (!txns.length) { toast('No transactions found. Check file format.', 'error'); setUploading(false); return }

      // Determine month from first transaction
      const stmtMonth = txns[0].dateStr.slice(0, 7)

      // Delete existing for this month and re-insert
      await supabase.from('bank_transactions').delete().eq('month', stmtMonth)

      const rows = txns.map(t => ({
        month: stmtMonth,
        date: t.dateStr,
        narration: t.narration,
        ref_no: t.refNo,
        withdrawal: t.withdrawal,
        deposit: t.deposit,
        closing_balance: t.balance,
        category: t.category,
        sub_category: t.label,
        is_business: t.is_business,
      }))

      const { error } = await supabase.from('bank_transactions').insert(rows)
      if (error) { toast('Upload failed: ' + error.message, 'error'); setUploading(false); return }

      setMonth(stmtMonth)
      setSyncStatus({ state: 'ok', msg: 'Statement uploaded ✓' })
      toast(`${rows.length} transactions imported for ${stmtMonth} ✓`, 'success')
      fetchTransactions()
    } catch (err) {
      toast('Parse error: ' + err.message, 'error')
      setSyncStatus({ state: 'error', msg: 'Upload failed' })
    }
    setUploading(false)
    e.target.value = ''
  }

  async function saveEdit() {
    await supabase.from('bank_transactions').update({
      category: editForm.category,
      is_business: editForm.is_business,
      notes: editForm.notes
    }).eq('id', editModal.id)
    setEditModal(null)
    fetchTransactions()
    toast('Updated ✓', 'success')
  }

  async function autoCreateExpenses() {
    // Auto-create expense entries from salary, electricity, bank charge transactions
    const expensible = transactions.filter(t => ['salary', 'electricity', 'bank_charges'].includes(t.category) && t.is_business && t.withdrawal > 0)
    if (!expensible.length) { toast('No auto-classifiable expenses found.', 'error'); return }

    const catMap = { salary: 'staff', electricity: 'utilities', bank_charges: 'admin' }
    const rows = expensible.map(t => ({
      date: t.date,
      description: t.sub_category + ' — ' + t.narration.slice(0, 60),
      category: catMap[t.category],
      amount: t.withdrawal,
      payment_mode: 'Bank Transfer',
      paid_by: 'business',
      bank_txn_id: t.id,
    }))

    await supabase.from('expenses').insert(rows)
    toast(`${rows.length} expenses auto-created ✓`, 'success')
  }

  const monthTxns = transactions
  const business = monthTxns.filter(t => t.is_business)
  const unclassified = monthTxns.filter(t => t.category === 'unclassified')

  // Income summary
  const incomeByCategory = ['paytm', 'card', 'shiprocket', 'shipmozo', 'cash_deposit', 'upi_in', 'other_in'].map(cat => ({
    cat,
    total: business.filter(t => t.category === cat).reduce((s, t) => s + (t.deposit || 0), 0)
  })).filter(x => x.total > 0)

  // Expense summary
  const expenseByCategory = ['salary', 'electricity', 'bank_charges', 'supplier'].map(cat => ({
    cat,
    total: business.filter(t => t.category === cat).reduce((s, t) => s + (t.withdrawal || 0), 0)
  })).filter(x => x.total > 0)

  const totalIn = business.reduce((s, t) => s + (t.deposit || 0), 0)
  const totalOut = business.reduce((s, t) => s + (t.withdrawal || 0), 0)

  const displayTxns = activeTab === 'unclassified' ? unclassified : activeTab === 'all' ? monthTxns : monthTxns

  return (
    <div>
      {/* Upload bar */}
      <div className="card" style={{ padding: '16px 20px', marginBottom: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--brown-dark)' }}>🏦 Bank Statement — Equitas</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Upload your monthly XLSX statement to auto-classify transactions</div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="month" value={month} onChange={e => setMonth(e.target.value)}
            style={{ padding: '7px 10px', border: '1.5px solid var(--cream-dark)', borderRadius: 8, fontFamily: 'inherit', fontSize: 13, background: 'var(--white)', outline: 'none' }} />
          <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
            {uploading ? '⏳ Uploading...' : '⬆ Upload Statement'}
            <input type="file" accept=".xlsx,.xls" onChange={handleUpload} style={{ display: 'none' }} disabled={uploading} />
          </label>
          {transactions.length > 0 && (
            <button className="btn btn-secondary btn-sm" onClick={autoCreateExpenses}>⚡ Auto-create Expenses</button>
          )}
        </div>
      </div>

      {loading ? <Loading /> : transactions.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🏦</div>
          <p>No statement uploaded for {month}.<br />Upload your Equitas XLSX statement above.</p>
        </div>
      ) : (
        <>
          {/* Stats */}
          <div className="stats-grid" style={{ marginBottom: 18 }}>
            <div className="stat-card green"><div className="stat-num" style={{ fontSize: 20 }}>{fmt(totalIn)}</div><div className="stat-label">Total In</div></div>
            <div className="stat-card red"><div className="stat-num" style={{ fontSize: 20 }}>{fmt(totalOut)}</div><div className="stat-label">Total Out</div></div>
            <StatCard num={monthTxns.length} label="Transactions" />
            <StatCard num={unclassified.length} label="Need Review" color={unclassified.length > 0 ? 'red' : 'green'} />
          </div>

          {/* Unclassified alert */}
          {unclassified.length > 0 && (
            <div style={{ background: 'var(--red-l)', border: '1.5px solid var(--red)', borderRadius: 'var(--r)', padding: '11px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--red)', fontWeight: 600, fontSize: 13 }}>❓ {unclassified.length} unclassified transactions need review</span>
              <button onClick={() => setActiveTab('unclassified')} style={{ background: 'var(--red)', color: 'var(--white)', border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Review Now</button>
            </div>
          )}

          {/* Summary cards */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
            <div className="card" style={{ padding: '16px 18px' }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--green)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 12 }}>↙️ Income Received</div>
              {incomeByCategory.map(({ cat, total }) => {
                const info = CAT_LABELS[cat]
                return (
                  <div key={cat} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, padding: '6px 10px', background: info.bg, borderRadius: 8 }}>
                    <span style={{ fontSize: 13, color: info.color, fontWeight: 500 }}>{info.icon} {info.label}</span>
                    <span style={{ fontWeight: 700, color: info.color }}>{fmt(total)}</span>
                  </div>
                )
              })}
            </div>
            <div className="card" style={{ padding: '16px 18px' }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 12 }}>↗️ Business Outflows</div>
              {expenseByCategory.map(({ cat, total }) => {
                const info = CAT_LABELS[cat]
                return (
                  <div key={cat} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, padding: '6px 10px', background: info.bg, borderRadius: 8 }}>
                    <span style={{ fontSize: 13, color: info.color, fontWeight: 500 }}>{info.icon} {info.label}</span>
                    <span style={{ fontWeight: 700, color: info.color }}>{fmt(total)}</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Transaction tabs */}
          <div style={{ display: 'flex', gap: 0, marginBottom: 14, background: 'var(--white)', borderRadius: 'var(--r)', overflow: 'hidden', boxShadow: 'var(--shadow)' }}>
            {[['summary', 'Business Only'], ['all', 'All Transactions'], ['unclassified', `❓ Unclassified (${unclassified.length})`]].map(([tab, label]) => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{
                flex: 1, padding: '11px 14px', border: 'none', fontFamily: 'inherit', fontSize: 12.5,
                fontWeight: activeTab === tab ? 700 : 500, cursor: 'pointer',
                background: activeTab === tab ? 'var(--brown-dark)' : 'var(--white)',
                color: activeTab === tab ? 'var(--gold)' : 'var(--muted)',
                borderBottom: activeTab === tab ? '3px solid var(--gold)' : '3px solid transparent',
                transition: 'all .2s'
              }}>{label}</button>
            ))}
          </div>

          <div className="card table-wrap">
            <table className="data-table" style={{ minWidth: 800 }}>
              <thead>
                <tr><th>Date</th><th>Narration</th><th>Category</th><th>Withdrawal</th><th>Deposit</th><th>Balance</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {(activeTab === 'summary' ? business : activeTab === 'unclassified' ? unclassified : monthTxns).map(t => {
                  const info = CAT_LABELS[t.category] || CAT_LABELS.unclassified
                  return (
                    <tr key={t.id} style={{ opacity: !t.is_business && activeTab !== 'unclassified' ? 0.5 : 1 }}>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(t.date)}</td>
                      <td style={{ maxWidth: 320 }}>
                        <div style={{ fontSize: 12.5, color: 'var(--text)' }}>{t.narration?.slice(0, 80)}</div>
                        {t.notes && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{t.notes}</div>}
                      </td>
                      <td>
                        <span style={{ background: info.bg, color: info.color, padding: '3px 9px', borderRadius: 10, fontSize: 11, fontWeight: 700 }}>
                          {info.icon} {info.label}
                        </span>
                      </td>
                      <td style={{ color: 'var(--red)', fontWeight: 600, textAlign: 'right' }}>{t.withdrawal > 0 ? fmt(t.withdrawal) : '—'}</td>
                      <td style={{ color: 'var(--green)', fontWeight: 600, textAlign: 'right' }}>{t.deposit > 0 ? fmt(t.deposit) : '—'}</td>
                      <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--muted)' }}>{fmt(t.closing_balance)}</td>
                      <td>
                        <button className="btn btn-sm" style={{ background: 'var(--cream-warm)', color: 'var(--brown-dark)' }}
                          onClick={() => { setEditModal(t); setEditForm({ category: t.category, is_business: t.is_business, notes: t.notes || '' }) }}>✏️</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Edit category modal */}
      {editModal && (
        <Modal open={!!editModal} onClose={() => setEditModal(null)} title="✏️ Reclassify Transaction">
          <div style={{ background: 'var(--cream)', borderRadius: 'var(--rs)', padding: '10px 14px', marginBottom: 14, fontSize: 12.5, color: 'var(--muted)' }}>
            {editModal.narration}
          </div>
          <FormGroup label="Category">
            <select className="form-input form-select" value={editForm.category} onChange={e => setEditForm({ ...editForm, category: e.target.value })}>
              {Object.entries(CAT_LABELS).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
            </select>
          </FormGroup>
          <FormGroup label="Is Business Transaction?">
            <select className="form-input form-select" value={editForm.is_business ? 'yes' : 'no'} onChange={e => setEditForm({ ...editForm, is_business: e.target.value === 'yes' })}>
              <option value="yes">Yes — Business</option>
              <option value="no">No — Personal / Ignore</option>
            </select>
          </FormGroup>
          <FormGroup label="Notes">
            <input className="form-input" value={editForm.notes} onChange={e => setEditForm({ ...editForm, notes: e.target.value })} placeholder="Optional note..." />
          </FormGroup>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setEditModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveEdit}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
