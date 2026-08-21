import { useState, useCallback } from 'react'
let toastId = 0
export function useToast() { const [toasts, setToasts] = useState([]); const toast = useCallback((message, type = '') => { const id = ++toastId; setToasts(prev => [...prev, { id, message, type }]); setTimeout(() => { setToasts(prev => prev.filter(t => t.id !== id)) }, type === 'error' ? 5000 : 3500) }, []); return { toasts, toast } }
export function ToastContainer({ toasts }) { return (<div className="toast-container">{toasts.map(t => (<div key={t.id} className={`toast ${t.type}`}>{t.message}</div>))}</div>) }
