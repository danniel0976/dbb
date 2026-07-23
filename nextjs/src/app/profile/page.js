'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { User, Mail, Calendar, BookOpen, Layers, Star, Pencil, Check, X, Loader2, AlertTriangle } from 'lucide-react'
import DBBNav from '@/components/DBBNav'
import FollowingSection from '@/components/FollowingSection'
import MerchantProfileForm from '@/components/MerchantProfileForm'

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
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-dbb-accent animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-4">{error}</p>
          <Link href="/library" className="btn btn-outline btn-md">Back to library</Link>
        </div>
      </div>
    )
  }

  const { email, created_at, display_name, stats } = profile || {}
  const memberSince = created_at ? new Date(created_at).toLocaleDateString('en-MY', { year: 'numeric', month: 'long', day: 'numeric' }) : '—'

  return (
    <div className="min-h-screen">
      <DBBNav />

      <main className="container mx-auto px-4 py-8 max-w-3xl">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">Profile</h1>

        {/* Account info card */}
        <div className="bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-6">
          <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">Account</h3>

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
                    className="flex-1 bg-gray-50 dark:bg-dbb-primary border border-dbb-accent/50 rounded px-2 py-1 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-dbb-accent min-w-0"
                  />
                  <button onClick={saveName} disabled={savingName} className="text-green-600 dark:text-green-400 hover:text-green-500 flex-shrink-0">
                    {savingName ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  </button>
                  <button onClick={cancelName} className="text-gray-400 hover:text-gray-700 dark:hover:text-white flex-shrink-0">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-900 dark:text-white">{display_name || <span className="text-gray-400 italic">Not set</span>}</span>
                  <button
                    onClick={() => setEditingName(true)}
                    className="text-gray-400 hover:text-dbb-accent transition-colors"
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
              <p className="text-sm text-gray-900 dark:text-white">{email}</p>
            </div>
          </div>

          {/* Member since */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-dbb-accent/10 rounded-lg flex items-center justify-center flex-shrink-0">
              <Calendar className="w-4 h-4 text-dbb-accent" />
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Member since</p>
              <p className="text-sm text-gray-900 dark:text-white">{memberSince}</p>
            </div>
          </div>
        </div>

        {/* Collection stats */}
        <div className="bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-6">
          <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">Collection</h3>
          <div className="grid grid-cols-3 gap-4">
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
          </div>
        </div>

        <MerchantProfileForm />

        {/* Following */}
        <FollowingSection />

        {/* Security */}
        <div className="bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-6">
          <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">Security</h3>
          <Link
            href="/reset-password"
            className="btn btn-outline btn-md inline-flex items-center gap-2"
          >
            Change password
          </Link>
        </div>

        {/* Danger zone */}
        <div className="bg-white dark:bg-dbb-secondary border border-red-200 dark:border-red-900/40 rounded-xl p-6">
          <h3 className="text-sm font-semibold text-red-500 dark:text-red-400 uppercase tracking-wider mb-4">Danger zone</h3>

          {!showDeactivate ? (
            <div className="flex items-start gap-4">
              <div className="flex-1">
                <p className="text-sm text-gray-900 dark:text-white font-medium mb-1">Deactivate account</p>
                <p className="text-xs text-gray-500">Disables your account. Contact support to restore it.</p>
              </div>
              <button
                onClick={() => setShowDeactivate(true)}
                className="flex-shrink-0 btn btn-danger btn-md"
              >
                Deactivate
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <AlertTriangle className="w-4 h-4 text-red-500 dark:text-red-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-600 dark:text-red-300">
                  This will immediately lock your account. Your data is kept — contact support to reactivate.
                </p>
              </div>
              <p className="text-xs text-gray-500">Type <span className="text-gray-700 dark:text-gray-300 font-mono">deactivate</span> to confirm:</p>
              <input
                autoFocus
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="deactivate"
                className="w-full bg-gray-50 dark:bg-dbb-primary border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white focus:border-red-500 focus:outline-none placeholder-gray-400 dark:placeholder-gray-600"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleDeactivate}
                  disabled={confirmText !== 'deactivate' || deactivating}
                  className="btn btn-danger btn-md disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {deactivating ? <Loader2 className="w-4 h-4 animate-spin" /> : <AlertTriangle className="w-4 h-4" />}
                  Confirm deactivate
                </button>
                <button
                  onClick={() => { setShowDeactivate(false); setConfirmText('') }}
                  disabled={deactivating}
                  className="btn btn-secondary btn-md"
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
    <div className="bg-gray-50 dark:bg-dbb-primary/50 rounded-lg p-4 flex flex-col gap-2">
      <div className="w-8 h-8 bg-dbb-accent/10 rounded-lg flex items-center justify-center">
        {icon}
      </div>
      <div>
        <p className="text-xs text-gray-500 mb-0.5">{label}</p>
        <p className="text-lg font-semibold text-gray-900 dark:text-white">{value}</p>
      </div>
    </div>
  )
}
