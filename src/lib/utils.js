import { format, parseISO } from 'date-fns'
export function fmt(n) { return '₹' + (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
export function fmtDate(dateStr) { if (!dateStr) return '—'; try { const d = typeof dateStr === 'string' && dateStr.length === 10 ? parseISO(dateStr + 'T00:00:00') : new Date(dateStr); return format(d, 'd MMM yyyy') } catch { return dateStr } }
export function fmtDateTime(dateStr) { if (!dateStr) return '—'; try { return format(new Date(dateStr), 'd MMM yyyy, h:mm a') } catch { return dateStr } }
export function today() { return new Date().toISOString().slice(0, 10) }
export function thisMonth() { return new Date().toISOString().slice(0, 7) }
export function getNextDue(dueDate, recurrence) { if (!recurrence) return null; const d = new Date(dueDate); const { num, unit } = recurrence; if (unit === 'days') d.setDate(d.getDate() + num); else if (unit === 'weeks') d.setDate(d.getDate() + num * 7); else if (unit === 'months') d.setMonth(d.getMonth() + num); else if (unit === 'years') d.setFullYear(d.getFullYear() + num); return d.toISOString() }
export const SUPPLIERS = ['Adavi Sampada', 'Arogya Rahasya', 'Cast Iron', 'Dathu Naturals', 'IM Corporation', 'GCC', 'GoDesi', 'Herbal Strategi', 'Prakruthivanam', 'Pure & Sure', 'Surabhi', 'Timbaktu']
export const DENOMS = [500, 200, 100, 50, 20, 10, 5, 2, 1]
