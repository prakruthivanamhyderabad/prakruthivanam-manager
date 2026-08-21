import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import { AuthProvider, useAuth } from './lib/auth'
import { useToast } from './lib/toast'
import Login from './pages/Login'
import App from './App'

function Root() {
  const { user, loading } = useAuth()
  const { toasts, toast } = useToast()

  if (loading) return (
    <div className="global-spinner"><div className="spinner spinner-lg" /></div>
  )

  if (!user) return <Login />
  return <App toasts={toasts} toast={toast} />
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <Root />
    </AuthProvider>
  </React.StrictMode>
)
