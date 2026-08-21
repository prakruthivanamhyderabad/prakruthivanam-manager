import { createContext, useContext, useState, useEffect } from 'react'
import { supabase } from './supabase'
const AuthContext = createContext(null)
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => { try { const saved = JSON.parse(localStorage.getItem('do_session') || 'null'); if (saved?.role) setUser(saved) } catch {}; setLoading(false) }, [])
  async function login(pin) {
    const { data } = await supabase.from('settings').select('key, value').in('key', ['manager_pin', 'staff_pin'])
    const settings = {}; data?.forEach(row => { settings[row.key] = row.value })
    if (pin === settings.manager_pin) { const u = { name: 'Manager', role: 'manager' }; setUser(u); localStorage.setItem('do_session', JSON.stringify(u)); return { success: true } }
    if (pin === settings.staff_pin) { const u = { name: 'Staff', role: 'staff' }; setUser(u); localStorage.setItem('do_session', JSON.stringify(u)); return { success: true } }
    return { success: false, error: 'Incorrect PIN' }
  }
  function logout() { setUser(null); localStorage.removeItem('do_session'); localStorage.removeItem('do_active_tab') }
  return (<AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>)
}
export function useAuth() { return useContext(AuthContext) }
