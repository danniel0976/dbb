import { createClient } from '@/lib/supabaseServer'
import { redirect } from 'next/navigation'

export default async function LibraryPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <main style={{ padding: '2rem', color: 'white', background: '#0d0d0d', minHeight: '100vh' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#e94560' }}>Your Library</h1>
      <p style={{ marginTop: '0.5rem', color: '#ccc' }}>Welcome, {user.email}</p>
      <p style={{ color: '#888', marginTop: '1rem' }}>Library coming in Phase 2.</p>
      <form action="/api/auth/signout" method="POST">
        <button
          type="submit"
          style={{
            marginTop: '2rem',
            color: '#aaa',
            background: 'none',
            border: '1px solid #444',
            borderRadius: '6px',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
          }}
        >
          Sign out
        </button>
      </form>
    </main>
  )
}
