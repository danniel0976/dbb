'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { User, Mail, Calendar, BookOpen, Layers, Star, DollarSign, Pencil, Check, X, Loader2, AlertTriangle } from 'lucide-react'

export default function ProfilePage() {
  const router = useRouter()
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Display name edit state
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [nameError, setNameError] = useState(null)

  // Password change state
  const [changingPassword, setChangingPassword] = useState(false)

  // Collection value state
  const [value, setValue] = useState(null)
  const [valueLoading, setValueLoading] = useState(false)
  const [valueFetched, setValueFetched] = useState(false)

  // Deactivate state
  const [showDeactivate, setShowDeactivate] = useState(false)
  const [deactivating, setDeactivating] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  useEffect(() => {
    fetch('/api/profile')
      .then(r => {
        if (!r.ok) throw new Error('Failed to load profile')
        return r.json()
      })
      .then(data => {
        setProfile(data)
        setNameInput(data.display_name || '')
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const fetchValue = async () => {
    if (valueFetched || valueLoading) return
    setValueLoading(true)
    try {
      const res = await fetch('/api/profile/value')
      if (!res.ok) throw new Error('Failed')
      const data = await res.json()
      setValue(data)
      setValueFetched(true)
    } catch {
      setValue(null)
    } finally {
      setValueLoading(false)
    }
  }

  // Lazy-load value once profile is loaded
  useEffect(() => {
    if (profile) fetchValue()
  }, [profile]) // eslint-disable-line react-hooks/exhaustive-deps

  const saveName = async () => {
    setSavingName(true)
    setNameError(null)
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: nameInput }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to save')
      setProfile(prev => ({ ...prev, display_name: data.display_name }))
      setEditingName(false)
    } catch (e) {
      setNameError(e.message)
    } finally {
      setSavingName(false)
    }
  }

  const cancelName = () => {
    setNameInput(profile?.display_name || '')
    setNameError(null)
    setEditingName(false)
  }

  const handleChangePassword = async () => {
    setChangingPassword(true)
    try {
      const res = await fetch('/auth/callback', { method: 'GET' })
    } catch {}
    // Redirect to reset password page
    router.push('/reset-password')
  }

  const handleDeactivate = async () => {
    if (confirmText !== 'deactivate') return
    setDeactivating(true)
    try {
      const res = await fetch('/api/profile/deactivate', { method: 'POST' })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error || 'Failed to deactivate')
      }
      router.push('/login?deactivated=1')
    } catch (e) {
      alert(e.message)
      setDeactivating(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-dbb-primary to-dbb-secondary flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-dbb-accent animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-dbb-primary to-dbb-secondary flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-4">{error}</p>
          <Link href="/library" className="text-dbb-accent hover:underline">Back to library</Link>
        </div>
      </div>
    )
  }

  const { email, created_at, display_name, stats } = profile || {}
  const memberSince = created_at ? new Date(created_at).toLocaleDateString('en-MY', { year: 'numeric', month: 'long', day: 'numeric' }) : '—'

  return (
    <div className="min-h-screen bg-gradient-to-br from-dbb-primary to-dbb-secondary">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-dbb-primary/95 backdrop-blur border-b border-dbb-accent/20">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold text-dbb-accent">DBB Library</h1>
            <nav className="hidden sm:flex items-center gap-3 text-sm text-gray-400">
              <Link href="/library" className="hover:text-white transition-colors">Library</Link>
              <Link href="/binders" className="hover:text-white transition-colors">Binders</Link>
              <Link href="/import" className="hover:text-white transition-colors">Import</Link>
              <Link href="/bazaar" className="hover:text-white transition-colors">Bazaar</Link>
              <Link href="/profile" className="text-white font-medium">Profile</Link>
            </nav>
          </div>
          <form action="/api/auth/signout" method="POST">
            <button
              type="submit"
              className="text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded-lg px-3 py-1.5 transition-colors"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-3xl">
        <h2 className="text-2xl font-bold text-white mb-6">Profile</h2>

        {/* Account info card */}
        <div className="bg-dbb-secondary border border-gray-700 rounded-xl p-6 mb-6">
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Account</h3>

          {/* Display name */}
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 bg-dbb-accent/10 rounded-lg flex items-center justify-center flex-shrink-0">
              <User className="w-4 h-4 text-dbb-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-gray-500 mb-0.5">Display name</p>
              {editingName ? (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') cancelName() }}
                    maxLength={60}
                    placeholder="Enter display name…"
                    className="flex-1 bg-dbb-primary border border-dbb-accent/50 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-dbb-accent min-w-0"
                  />
                  <button onClick={saveName} disabled={savingName} className="text-green-400 hover:text-green-300 flex-shrink-0">
                    {savingName ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  </button>
                  <button onClick={cancelName} className="text-gray-400 hover:text-white flex-shrink-0">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-white">{display_name || <span className="text-gray-500 italic">Not set</span>}</span>
                  <button
                    onClick={() => setEditingName(true)}
                    className="text-gray-500 hover:text-dbb-accent transition-colors"
                    title="Edit display name"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              {nameError && <p className="text-xs text-red-400 mt-1">{nameError}</p>}
            </div>
          </div>

          {/* Email */}
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 bg-dbb-accent/10 rounded-lg flex items-center justify-center flex-shrink-0">
              <Mail className="w-4 h-4 text-dbb-accent" />
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Email</p>
              <p className="text-sm text-white">{email}</p>
            </div>
          </div>

          {/* Member since */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-dbb-accent/10 rounded-lg flex items-center justify-center flex-shrink-0">
              <Calendar className="w-4 h-4 text-dbb-accent" />
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Member since</p>
              <p className="text-sm text-white">{memberSince}</p>
            </div>
          </div>
        </div>

        {/* Collection stats */}
        <div className="bg-dbb-secondary border border-gray-700 rounded-xl p-6 mb-6">
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Collection</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatTile
              icon={<Layers className="w-5 h-5 text-dbb-accent" />}
              label="Total cards"
              value={(stats?.total_cards || 0).toLocaleString()}
            />
            <StatTile
              icon={<Star className="w-5 h-5 text-dbb-accent" />}
              label="Unique cards"
              value={(stats?.unique_cards || 0).toLocaleString()}
            />
            <StatTile
              icon={<BookOpen className="w-5 h-5 text-dbb-accent" />}
              label="Binders"
              value={(stats?.binder_count || 0).toLocaleString()}
            />
            <StatTile
              icon={<DollarSign className="w-5 h-5 text-dbb-accent" />}
              label="Est. value (USD)"
              value={
                valueLoading
                  ? <span className="inline-flex items-center gap-1 text-gray-400"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</span>
                  : value != null
                    ? `$${value.total_usd.toFixed(2)}`
                    : '—'
              }
            />
          </div>
          {value && (
            <p className="text-xs text-gray-600 mt-3">
              Based on CardKingdom prices for {value.priced_count.toLocaleString()} of {value.total_count.toLocaleString()} unique card rows.
            </p>
          )}
        </div>

        {/* Security */}
        <div className="bg-dbb-secondary border border-gray-700 rounded-xl p-6 mb-6">
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Security</h3>
          <Link
            href="/reset-password"
            className="inline-flex items-center gap-2 px-4 py-2 text-sm text-gray-300 border border-gray-700 hover:border-gray-500 hover:text-white rounded-lg transition-colors"
          >
            Change password
          </Link>
        </div>

        {/* Danger zone */}
        <div className="bg-dbb-secondary border border-red-900/40 rounded-xl p-6">
          <h3 className="text-sm font-semibold text-red-400 uppercase tracking-wider mb-4">Danger zone</h3>

          {!showDeactivate ? (
            <div className="flex items-start gap-4">
              <div className="flex-1">
                <p className="text-sm text-white font-medium mb-1">Deactivate account</p>
                <p className="text-xs text-gray-500">Disables your account. You can contact Dan to restore it.</p>
              </div>
              <button
                onClick={() => setShowDeactivate(true)}
                className="flex-shrink-0 px-4 py-2 text-sm text-red-400 border border-red-800 hover:bg-red-900/20 rounded-lg transition-colors"
              >
                Deactivate
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start gap-2 p-3 bg-red-900/20 border border-red-800 rounded-lg">
                <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-300">
                  This will immediately lock your account. Your data is kept — contact Dan to reactivate.
                </p>
              </div>
              <p className="text-xs text-gray-500">Type <span className="text-gray-300 font-mono">deactivate</span> to confirm:</p>
              <input
                autoFocus
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="deactivate"
                className="w-full bg-dbb-primary border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:border-red-500 focus:outline-none placeholder-gray-600"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleDeactivate}
                  disabled={confirmText !== 'deactivate' || deactivating}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                >
                  {deactivating ? <Loader2 className="w-4 h-4 animate-spin" /> : <AlertTriangle className="w-4 h-4" />}
                  Confirm deactivate
                </button>
                <button
                  onClick={() => { setShowDeactivate(false); setConfirmText('') }}
                  disabled={deactivating}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded-lg transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

function StatTile({ icon, label, value }) {
  return (
    <div className="bg-dbb-primary/50 rounded-lg p-4 flex flex-col gap-2">
      <div className="w-8 h-8 bg-dbb-accent/10 rounded-lg flex items-center justify-center">
        {icon}
      </div>
      <div>
        <p className="text-xs text-gray-500 mb-0.5">{label}</p>
        <p className="text-lg font-semibold text-white">{value}</p>
      </div>
    </div>
  )
}
