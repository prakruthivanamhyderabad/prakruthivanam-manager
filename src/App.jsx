import { useState, useEffect } from 'react'
import { useAuth } from './lib/auth'
import { ToastContainer } from './lib/toast'
import Tasks from './pages/Tasks'
import CounterClosing from './pages/CounterClosing'
import Attendance from './pages/Attendance'
import InvoiceMismatches from './pages/InvoiceMismatches'
import StockReturns from './pages/StockReturns'
import StockAudit from './pages/StockAudit'
import Payments from './pages/Payments'
import GSTFiling from './pages/GSTFiling'
import OrderPlanning from './pages/OrderPlanning'
import Expenses from './pages/Expenses'
import BankRecon from './pages/BankRecon'
import ProfitLoss from './pages/ProfitLoss'
import QuickLaunch from './pages/QuickLaunch'
import Settings from './pages/Settings'
import { supabase } from './lib/supabase'

const TABS = [
  { id: 'launch', label: '🚀 Quick Launch', roles: ['manager', 'staff'] },
  { id: 'tasks', label: '✅ To Do List', roles: ['manager', 'staff'] },
  { id: 'closing', label: '🧾 Counter Closing', roles: ['manager', 'staff'] },
  { id: 'attendance', label: '👥 Attendance', roles: ['manager', 'staff'] },
  { id: 'mismatches', label: '⚖️ Invoice Mismatches', roles: ['manager', 'staff'] },
  { id: 'returns', label: '↩️ Stock Returns', roles: ['manager', 'staff'] },
  { id: 'audit', label: '🔍 Stock Audit', roles: ['manager', 'staff'] },
  { id: 'payments', label: '💰 Payments', roles: ['manager'] },
  { id: 'expenses', label: '💸 Expenses', roles: ['manager'] },
  { id: 'bankrecon', label: '🏦 Bank Recon', roles: ['manager'] },
  { id: 'pl', label: '📊 P&L', roles: ['manager'] },
  { id: 'gst', label: '🧾 GST Filing', roles: ['manager'] },
  { id: 'orders', label: '📦 Order Planning', roles: ['manager'] },
]

export default function App({ toasts, toast }) {
  const { user, logout } = useAuth()
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem('do_active_tab') || 'launch')
  const [syncStatus, setSyncStatus] = useState({ state: 'ok', msg: 'Connected to Supabase' })
  const [showSettings, setShowSettings] = useState(false)

  const visibleTabs = TABS.filter(t => t.roles.includes(user.role))

  // Make sure active tab is valid for this role
  useEffect(() => {
    const valid = visibleTabs.find(t => t.id === activeTab)
    if (!valid) setActiveTab('launch')
  }, [user.role])

  function switchTab(id) {
    setActiveTab(id)
    localStorage.setItem('do_active_tab', id)
  }

  const tabProps = { user, toast, setSyncStatus }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      {/* Top bar */}
      <div style={{
        background: 'var(--white)',
        borderBottom: '1px solid var(--cream-dark)',
        padding: '0 24px',
        height: 58,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'sticky', top: 0, zIndex: 100,
        boxShadow: '0 2px 12px rgba(90,122,90,.06)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: 19, fontWeight: 700,
            color: 'var(--sage-dark)'
          }}>🌿 Prakruthivanam <span style={{ color: 'var(--gold-mid)', fontSize: 14, fontWeight: 400 }}>DailyOps</span></span>
          <span style={{
            background: 'var(--sage-pale)', color: 'var(--sage-dark)',
            padding: '3px 12px', borderRadius: 20,
            fontSize: 11, fontWeight: 600, textTransform: 'uppercase'
          }}>{user.role === 'manager' ? '👑 Manager' : '🧑‍💼 Staff'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {user.role === 'manager' && (
            <button className="btn btn-ghost btn-icon" onClick={() => setShowSettings(true)} title="Settings">⚙️</button>
          )}
          <button className="btn btn-secondary" style={{ fontSize: 12.5, padding: '7px 14px', background: 'transparent', border: '1px solid rgba(245,200,66,.3)', color: 'var(--gold-mid)' }} onClick={logout}>Sign Out</button>
        </div>
      </div>

      {/* Sync bar */}
      <div style={{
        background: 'var(--sage-pale)',
        borderBottom: '1px solid var(--cream-dark)',
        padding: '4px 24px',
        display: 'flex', alignItems: 'center', gap: 7,
        fontSize: 11.5, color: 'var(--sage-dark)'
      }}>
        <span className={`sync-dot ${syncStatus.state === 'syncing' ? 'syncing' : syncStatus.state === 'error' ? 'error' : ''}`} />
        <span>{syncStatus.msg}</span>
      </div>

      {/* Tab nav */}
      <div style={{
        background: 'var(--white)',
        borderBottom: '1px solid var(--cream-dark)',
        padding: '0 24px',
        display: 'flex',
        overflowX: 'auto',
        gap: 0
      }}>
        {visibleTabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => switchTab(tab.id)}
            style={{
              padding: '13px 16px',
              border: 'none',
              background: 'none',
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 12.5,
              fontWeight: activeTab === tab.id ? 600 : 500,
              color: activeTab === tab.id ? 'var(--brown-dark)' : 'var(--muted)',
              cursor: 'pointer',
              borderBottom: `3px solid ${activeTab === tab.id ? 'var(--gold)' : 'transparent'}`,
              whiteSpace: 'nowrap',
              transition: 'all .2s'
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, maxWidth: 1200, margin: '0 auto', padding: 22, width: '100%', overflowX: 'hidden' }}>
        {activeTab === 'launch' && <QuickLaunch {...tabProps} />}
        {activeTab === 'tasks' && <Tasks {...tabProps} />}
        {activeTab === 'closing' && <CounterClosing {...tabProps} />}
        {activeTab === 'attendance' && <Attendance {...tabProps} />}
        {activeTab === 'mismatches' && <InvoiceMismatches {...tabProps} />}
        {activeTab === 'returns' && <StockReturns {...tabProps} />}
        {activeTab === 'audit' && <StockAudit {...tabProps} />}
        {activeTab === 'payments' && <Payments {...tabProps} />}
        {activeTab === 'expenses' && <Expenses {...tabProps} />}
        {activeTab === 'bankrecon' && <BankRecon {...tabProps} />}
        {activeTab === 'pl' && <ProfitLoss {...tabProps} />}
        {activeTab === 'gst' && <GSTFiling {...tabProps} />}
        {activeTab === 'orders' && <OrderPlanning {...tabProps} />}
      </div>

      {showSettings && <Settings onClose={() => setShowSettings(false)} toast={toast} />}
      <ToastContainer toasts={toasts} />
    </div>
  )
}
