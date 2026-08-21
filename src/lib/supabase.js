import { createClient } from '@supabase/supabase-js'
const SUPABASE_URL = 'https://jsckpivqilcdqryvhuej.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzY2twaXZxaWxjZHFyeXZodWVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0ODE2NzEsImV4cCI6MjA5MzA1NzY3MX0.Bmzj82duzyba1WYMQ_EKDrnMd5VpV6aFeikk_zMzsJA'
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
