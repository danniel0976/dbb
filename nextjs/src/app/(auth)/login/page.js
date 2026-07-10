'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabaseClient'

export default function LoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (searchParams.get('deactivated') === '1') {
      setError('Your account has been deactivated. Contact support for assistance.')
    } else if (searchParams.get('error') === 'auth_callback_failed') {
      setError('Authentication failed. Please try again.')
    }
  }, [searchParams])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const supabase = createClient()
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password })

    if (authError) {
      setError(authError.message)
      setLoading(false)
      return
    }

    router.push('/library')
    router.refresh()
  }

  return (
    <>
      <h2 className="text-2xl font-bold text-white mb-6">Sign in</h2>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-900/40 border border-red-500/40 text-red-300 text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-dbb-primary border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-600"
            placeholder="you@example.com"
            autoComplete="email"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">Password</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-dbb-primary border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-600"
            placeholder="••••••••"
            autoComplete="current-password"
          />
        </div>

        <div className="flex justify-end">
          <Link href="/reset-password" className="text-xs text-dbb-accent hover:text-dbb-accent/80 transition-colors">
            Forgot password?
          </Link>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-dbb-accent hover:bg-dbb-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg transition-colors"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-gray-400">
        {"Don't have an account? "}
        <Link href="/register" className="text-dbb-accent hover:text-dbb-accent/80 transition-colors font-medium">
          Register
        </Link>
      </p>
    </>
  )
}
