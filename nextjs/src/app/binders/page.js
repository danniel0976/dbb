'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { BookOpen, Plus, Pencil, Trash2, Check, X, Loader2 } from 'lucide-react'

function BinderCard({ binder, onRename, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(binder.name)
  const [saving, setSaving] = useState(false)

  const saveRename = async () => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === binder.name) { setEditing(false); setName(binder.name); return }
    setSaving(true)
    await onRename(binder.id, trimmed)
    setSaving(false)
    setEditing(false)
  }

  const cancelEdit = () => { setName(binder.name); setEditing(false) }

  return (
    <div className="bg-dbb-secondary border border-gray-700 rounded-xl p-5 flex flex-col gap-4 hover:border-gray-600 transition-colors">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 bg-dbb-accent/10 rounded-lg flex items-center justify-center flex-shrink-0">
          <BookOpen className="w-5 h-5 text-dbb-accent" />
        </div>
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') cancelEdit() }}
                maxLength={60}
                className="flex-1 bg-dbb-primary border border-dbb-accent/50 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-dbb-accent"
              />
              <button onClick={saveRename} disabled={saving} className="text-green-400 hover:text-green-300 disabled:opacity-50">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              </button>
              <button onClick={cancelEdit} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-white truncate">{binder.name}</h3>
              {binder.is_default && (
                <span className="text-xs text-dbb-accent border border-dbb-accent/40 rounded px-1.5 py-0.5 flex-shrink-0">Default</span>
              )}
            </div>
          )}
          <p className="text-sm text-gray-500 mt-0.5">
            {binder.card_count || 0} card{binder.card_count !== 1 ? 's' : ''}
          </p>
          <p className="text-xs text-gray-600 mt-1">
            Created {new Date(binder.created_at).toLocaleDateString()}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-2 border-t border-gray-700/50">
        <Link
          href={`/binders/${binder.id}`}
          className="flex-1 text-center text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded-lg py-1.5 transition-colors"
        >
          View cards
        </Link>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            title="Rename"
            className="p-1.5 text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded-lg transition-colors"
          >
            <Pencil className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={() => onDelete(binder)}
          disabled={binder.is_default}
          title={binder.is_default ? 'Cannot delete the default binder' : 'Delete binder'}
          className="p-1.5 text-gray-400 hover:text-red-400 border border-gray-700 hover:border-red-800 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-gray-400 disabled:hover:border-gray-700"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

export default function BindersPage() {
  const [binders, setBinders] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [error, setError] = useState(null)

  const fetchBinders = useCallback(async () => {
    try {
      const res = await fetch('/api/binders')
      if (!res.ok) throw new Error('Failed to load')
      const data = await res.json()
      setBinders(data.binders || [])
    } catch (e) {
      setError('Failed to load binders')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchBinders() }, [fetchBinders])

  const handleCreate = async (e) => {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    try {
      const res = await fetch('/api/binders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error || 'Failed to create')
      }
      const data = await res.json()
      setBinders(prev => [...prev, { ...data.binder, card_count: 0 }])
      setNewName('')
      setShowCreate(false)
    } catch (e) {
      setError(e.message)
    } finally {
      setCreating(false)
    }
  }

  const handleRename = async (id, name) => {
    try {
      const res = await fetch(`/api/binders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      setBinders(prev => prev.map(b => b.id === id ? { ...b, name: data.binder.name } : b))
    } catch {
      setError('Failed to rename binder')
    }
  }

  const handleDelete = async (binder) => {
    const count = binder.card_count || 0
    const msg = count > 0
      ? `This will permanently delete "${binder.name}" and its ${count} card${count !== 1 ? 's' : ''}. Are you sure?`
      : `Delete binder "${binder.name}"?`
    if (!confirm(msg)) return
    try {
      const res = await fetch(`/api/binders/${binder.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error || 'Failed to delete')
      }
      setBinders(prev => prev.filter(b => b.id !== binder.id))
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-dbb-primary to-dbb-secondary">
      <header className="sticky top-0 z-40 bg-dbb-primary/95 backdrop-blur border-b border-dbb-accent/20">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold text-dbb-accent">DBB Library</h1>
            <nav className="hidden sm:flex items-center gap-3 text-sm text-gray-400">
              <Link href="/library" className="hover:text-white transition-colors">Library</Link>
              <Link href="/binders" className="text-white font-medium">Binders</Link>
              <Link href="/import" className="hover:text-white transition-colors">Import</Link>
              <Link href="/bazaar" className="hover:text-white transition-colors">Bazaar</Link>
              <Link href="/profile" className="hover:text-white transition-colors">Profile</Link>
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

      <main className="container mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold text-white">Binders</h2>
            {!loading && (
              <p className="text-gray-400 text-sm mt-1">
                {binders.length} binder{binders.length !== 1 ? 's' : ''}
              </p>
            )}
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2 bg-dbb-accent hover:bg-dbb-accent/90 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" /> New binder
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-900/30 border border-red-800 rounded-lg text-sm text-red-400 flex items-center justify-between">
            {error}
            <button onClick={() => setError(null)} className="text-red-500 hover:text-red-300">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Create binder form */}
        {showCreate && (
          <form onSubmit={handleCreate} className="mb-6 p-4 bg-dbb-secondary border border-dbb-accent/30 rounded-xl flex items-center gap-3">
            <BookOpen className="w-5 h-5 text-dbb-accent flex-shrink-0" />
            <input
              autoFocus
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Binder name..."
              maxLength={60}
              className="flex-1 bg-dbb-primary border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:border-dbb-accent focus:outline-none placeholder-gray-600"
            />
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="flex items-center gap-1.5 px-4 py-2 bg-dbb-accent hover:bg-dbb-accent/90 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
            >
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Create
            </button>
            <button
              type="button"
              onClick={() => { setShowCreate(false); setNewName('') }}
              className="p-2 text-gray-400 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </form>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-24 gap-3 text-gray-400">
            <Loader2 className="w-6 h-6 animate-spin" />
            <span>Loading binders...</span>
          </div>
        ) : binders.length === 0 ? (
          <div className="text-center py-24">
            <div className="text-5xl mb-4">📂</div>
            <h3 className="text-xl font-semibold text-gray-300 mb-2">No binders yet</h3>
            <p className="text-gray-500 mb-6">Create a binder to organise your collection.</p>
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-2 px-6 py-2 bg-dbb-accent hover:bg-dbb-accent/90 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" /> Create your first binder
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {binders.map(b => (
              <BinderCard
                key={b.id}
                binder={b}
                onRename={handleRename}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
