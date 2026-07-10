'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabaseClient'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [message, setMessage] = useState(null)
  const [hasSession, setHasSession] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) setHasSession(true)
    })
  }, [])

  const handleRequestReset = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const supabase = createClient()
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    })

    if (resetError) {
      setError(resetError.message)
    } else {
      setMessage('Check your email for a password reset link.')
    }
    setLoading(false)
  }

  const handleUpdatePassword = async (e) => {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    const supabase = createClient()
    const { error: updateError } = await supabase.auth.updateUser({ password })

    if (updateError) {
      setError(updateError.message)
      setLoading(false)
      return
    }

    router.push('/library')
  }

  if (hasSession) {
    return (
      <>
        <h2 className="text-2xl font-bold text-white mb-6">Choose new password</h2>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-900/40 border border-red-500/40 text-red-300 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleUpdatePassword} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">New Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-dbb-primary border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-600"
              placeholder="Min. 8 characters"
              autoComplete="new-password"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Confirm New Password</label>
            <input
              type="password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full bg-dbb-primary border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:border-dbb-accent focus:outline-none placeholder-gray-600"
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-dbb-accent hover:bg-dbb-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg transition-colors"
          >
            {loading ? 'Updating…' : 'Update password'}
          </button>
        </form>
      </>
    )
  }

  return (
    <>
      <h2 className="text-2xl font-bold text-white mb-2">Reset password</h2>
      <p className="text-gray-400 text-sm mb-6">{"Enter your email and we'll send you a reset link."}</p>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-900/40 border border-red-500/40 text-red-300 text-sm">
          {error}
        </div>
      )}

      {message ? (
        <div className="p-3 rounded-lg bg-green-900/40 border border-green-500/40 text-green-300 text-sm mb-4">
          {message}
        </div>
      ) : (
        <form onSubmit={handleRequestReset} className="space-y-4">
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

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-dbb-accent hover:bg-dbb-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg transition-colors"
          >
            {loading ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}

      <p className="mt-6 text-center text-sm text-gray-400">
        <Link href="/login" className="text-dbb-accent hover:text-dbb-accent/80 transition-colors">
          Back to sign in
        </Link>
      </p>
    </>
  )
}
