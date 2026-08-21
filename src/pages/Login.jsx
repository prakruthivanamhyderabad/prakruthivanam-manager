import { useState } from 'react'
import { useAuth } from '../lib/auth'

export default function Login() {
  const { login } = useAuth()
  const [role, setRole] = useState('manager')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleLogin() {
    if (!pin) return
    setLoading(true)
    setError('')
    const result = await login(pin)
    if (!result.success) {
      setError('Incorrect PIN. Try again.')
    }
    setLoading(false)
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(145deg, #1a0e08, #2c1810 50%, #3d2415)'
    }}>
      <div style={{
        background: 'var(--white)',
        borderRadius: 24,
        padding: '48px 40px',
        width: 380,
        boxShadow: '0 32px 80px rgba(0,0,0,.25)',
        animation: 'scaleIn .3s ease'
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 72, height: 72,
            borderRadius: '50%',
            border: '2px solid rgba(245,200,66,.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 12px',
            fontSize: 34
          }}>🌿</div>
          <h1 style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: 24, fontWeight: 700,
            color: 'var(--gold)',
            letterSpacing: '-0.5px'
          }}>Prakruthivanam</h1>
          <p style={{ fontSize: 12, color: 'var(--gold-mid)', marginTop: 4, letterSpacing: '.8px', fontWeight: 500 }}>
            DailyOps &nbsp;·&nbsp; ప్రకృతివనం
          </p>
        </div>

        {/* Role selector */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
          {['manager', 'staff'].map(r => (
            <button
              key={r}
              onClick={() => { setRole(r); setPin(''); setError('') }}
              style={{
                padding: '14px 12px',
                border: `2px solid ${role === r ? 'var(--gold-mid)' : 'var(--cream-dark)'}`,
                borderRadius: 'var(--rs)',
                background: role === r ? 'var(--cream-warm)' : 'var(--cream)',
                cursor: 'pointer',
                textAlign: 'center',
                transition: 'all .2s',
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 13, fontWeight: 500,
                color: role === r ? 'var(--brown-dark)' : 'var(--muted)'
              }}
            >
              <span style={{ fontSize: 22, display: 'block', marginBottom: 4 }}>
                {r === 'manager' ? '👑' : '🧑‍💼'}
              </span>
              {r === 'manager' ? 'Manager' : 'Staff'}
            </button>
          ))}
        </div>

        {/* PIN input */}
        <input
          type="password"
          value={pin}
          onChange={e => { setPin(e.target.value); setError('') }}
          onKeyDown={e => e.key === 'Enter' && handleLogin()}
          placeholder="Enter PIN..."
          style={{
            width: '100%',
            padding: '13px 16px',
            border: `2px solid ${error ? 'var(--red)' : 'var(--cream-dark)'}`,
            borderRadius: 'var(--rs)',
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 15,
            color: 'var(--text)',
            background: 'var(--cream)',
            outline: 'none',
            marginBottom: 14,
            transition: 'border-color .2s'
          }}
          onFocus={e => { e.target.style.borderColor = 'var(--gold-mid)'; e.target.style.background = 'var(--white)' }}
          onBlur={e => { e.target.style.borderColor = error ? 'var(--red)' : 'var(--cream-dark)'; e.target.style.background = 'var(--cream)' }}
        />

        <button
          onClick={handleLogin}
          disabled={loading || !pin}
          style={{
            width: '100%',
            padding: 14,
            background: 'var(--brown-dark)',
            color: 'var(--white)',
            border: 'none',
            borderRadius: 'var(--rs)',
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 15, fontWeight: 600,
            cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading || !pin ? .65 : 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            transition: 'background .2s'
          }}
        >
          {loading ? <><div className="spinner" style={{ borderTopColor: 'white' }} /> Signing in...</> : 'Sign In →'}
        </button>

        {error && (
          <p style={{ color: 'var(--red)', fontSize: 13, textAlign: 'center', marginTop: 10 }}>{error}</p>
        )}
      </div>
    </div>
  )
}
