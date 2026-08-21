import { createClient } from '@supabase/supabase-js'
const SUPABASE_URL = 'https://jsckpivqilcdqryvhuej.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzY2twaXZxaWxjZHFyeXZodWVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0ODE2NzEsImV4cCI6MjA5MzA1NzY3MX0.Bmzj82duzyba1WYMQ_EKDrnMd5VpV6aFeikk_zMzsJA'
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// Supabase/PostgREST caps a single request at ~1000 rows by default —
// page through with .range() so large uploads don't get silently truncated.
export async function fetchAllRows(table, select, orderCol) {
  const PAGE = 1000
  let all = [], from = 0
  while (true) {
    const { data, error } = await supabase.from(table).select(select).order(orderCol).range(from, from + PAGE - 1)
    if (error || !data) break
    all = all.concat(data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return all
}
