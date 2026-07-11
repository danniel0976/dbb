'use client'

import { useState, useRef, useEffect } from 'react'
import { BookOpen, Plus, Pencil, Trash2, Check, X, Loader2, GitMerge, ChevronDown, MoreVertical } from 'lucide-react'

function MergeModal({ source, binders, onConfirm, onClose }) {
  const targets = binders.filter(b => b.id !== source.id)
  const [targetId, setTargetId] = useState(targets[0]?.id || '')
  const [merging, setMerging] = useState(false)
  const target = binders.find(b => b.id === targetId)

  const handleConfirm = async () => {
    if (!targetId) return
    setMerging(true)
    await onConfirm(source.id, targetId)
    setMerging(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-dbb-secondary border border-gray-700 rounded-2xl w-full max-w-md p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-bold text-white">Merge binder</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <div className="space-y-4">
          <div>
            <p className="text-sm text-gray-400 mb-1">Source binder</p>
            <p className="text-white font-medium">
              {source.name} <span className="text-gray-500 font-normal">({source.card_count} card{source.card_count !== 1 ? 's' : ''})</span>
            </p>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Merge into</label>
            {targets.length === 0 ? (
              <p className="text-gray-500 text-sm">No other binders available.</p>
            ) : (
              <div className="relative">
                <select
                  value={targetId}
                  onChange={e => setTargetId(e.target.value)}
                  className="w-full appearance-none bg-dbb-primary border border-gray-600 focus:border-dbb-accent rounded-lg px-3 py-2 text-white text-sm outline-none pr-8"
                >
                  {targets.map(b => (
                    <option key={b.id} value={b.id}>{b.name} ({b.card_count} cards)</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              </div>
            )}
          </div>
          {target && (
            <div className="p-3 bg-yellow-900/20 border border-yellow-700/40 rounded-lg text-sm text-yellow-200">
              Merge <span className="font-semibold">"{source.name}"</span> ({source.card_count} cards) into <span className="font-semibold">"{target.name}"</span>? "{source.name}" will be deleted after merging.
            </div>
          )}
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-xl text-sm font-medium transition-colors">Cancel</button>
          <button
            disabled={merging || !targetId || targets.length === 0}
            onClick={handleConfirm}
            className="flex-[2] py-2.5 bg-dbb-accent hover:bg-dbb-accent/80 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2"
          >
            {merging ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitMerge className="w-4 h-4" />}
            {merging ? 'Merging…' : 'Merge & delete source'}
          </button>
        </div>
      </div>
    </div>
  )
}

function BinderItem({ binder, isSelected, onSelect, onRename, onDelete, onMerge }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(binder.name)
  const [saving, setSaving] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    if (!menuOpen) return
    function close(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  const saveRename = async () => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === binder.name) { setEditing(false); setName(binder.name); return }
    setSaving(true)
    await onRename(binder.id, trimmed)
    setSaving(false)
    setEditing(false)
  }

  const cancelEdit = () => { setName(binder.name); setEditing(false) }

  if (editing) {
    return (
      <div className="flex items-center gap-1 px-2 py-1.5 rounded-lg flex-shrink-0 md:flex-shrink md:w-full bg-dbb-accent/10">
        <input
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') cancelEdit() }}
          maxLength={60}
          className="flex-1 min-w-0 bg-dbb-primary border border-dbb-accent/50 rounded px-2 py-0.5 text-sm text-white focus:outline-none"
        />
        <button onClick={saveRename} disabled={saving} className="flex-shrink-0 text-green-400 hover:text-green-300 disabled:opacity-50">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
        </button>
        <button onClick={cancelEdit} className="flex-shrink-0 text-gray-500 hover:text-white">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    )
  }

  return (
    <div className={`group relative flex items-center rounded-lg flex-shrink-0 md:flex-shrink md:w-full transition-colors ${isSelected ? 'bg-dbb-accent/15' : 'hover:bg-white/5'}`}>
      <button
        onClick={() => onSelect(binder.id)}
        className={`flex-1 min-w-0 text-left px-3 py-1.5 md:py-2 transition-colors ${isSelected ? 'text-white' : 'text-gray-400 hover:text-white'}`}
      >
        <span className="block text-sm truncate">{binder.name}</span>
        <span className="text-xs text-gray-500">
          {binder.card_count || 0} card{binder.card_count !== 1 ? 's' : ''}
        </span>
      </button>

      <div className="relative flex-shrink-0" ref={menuRef}>
        <button
          onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}
          title="Binder actions"
          className={`p-1.5 rounded mr-1 transition-colors ${
            menuOpen ? 'text-white' : 'text-gray-600 hover:text-gray-300 opacity-0 group-hover:opacity-100 focus:opacity-100'
          }`}
        >
          <MoreVertical className="w-3.5 h-3.5" />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 w-36 bg-dbb-secondary border border-gray-700 rounded-lg shadow-xl z-50 py-1">
            <button
              onClick={() => { setMenuOpen(false); setEditing(true) }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
            >
              <Pencil className="w-3 h-3" /> Rename
            </button>
            <button
              onClick={() => { setMenuOpen(false); onMerge(binder) }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-gray-300 hover:text-blue-300 hover:bg-white/5 transition-colors"
            >
              <GitMerge className="w-3 h-3" /> Merge into…
            </button>
            <button
              onClick={() => { setMenuOpen(false); onDelete(binder) }}
              disabled={binder.is_default}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-white/5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Trash2 className="w-3 h-3" /> Delete
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function BinderRail({ initialBinders = [], selectedId, onSelect, onBindersChange }) {
  const [binders, setBinders] = useState(initialBinders)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)
  const [mergeSource, setMergeSource] = useState(null)

  useEffect(() => {
    onBindersChange?.(binders)
  }, [binders]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = async (e) => {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/binders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed') }
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
      ? `Delete "${binder.name}" and its ${count} card${count !== 1 ? 's' : ''}? This cannot be undone.`
      : `Delete binder "${binder.name}"?`
    if (!confirm(msg)) return
    try {
      const res = await fetch(`/api/binders/${binder.id}`, { method: 'DELETE' })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Failed') }
      setBinders(prev => prev.filter(b => b.id !== binder.id))
      if (selectedId === binder.id) onSelect(null)
    } catch (e) {
      setError(e.message)
    }
  }

  const handleMerge = async (sourceId, targetId) => {
    try {
      const res = await fetch('/api/binders/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_id: sourceId, target_id: targetId }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Merge failed') }
      const listRes = await fetch('/api/binders')
      if (listRes.ok) {
        const data = await listRes.json()
        setBinders(data.binders || [])
      }
      if (selectedId === sourceId) onSelect(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setMergeSource(null)
    }
  }

  return (
    <>
      {mergeSource && (
        <MergeModal
          source={mergeSource}
          binders={binders}
          onConfirm={handleMerge}
          onClose={() => setMergeSource(null)}
        />
      )}

      {error && (
        <div className="flex items-center justify-between gap-2 px-2 py-1.5 mb-1 bg-red-900/30 border border-red-800 rounded-lg text-xs text-red-400 flex-shrink-0 md:flex-shrink">
          <span className="truncate">{error}</span>
          <button onClick={() => setError(null)} className="flex-shrink-0"><X className="w-3 h-3" /></button>
        </div>
      )}

      {/* All cards */}
      <button
        onClick={() => onSelect(null)}
        className={`flex items-center gap-2 px-3 py-1.5 md:py-2 rounded-lg text-sm transition-colors flex-shrink-0 md:flex-shrink md:w-full ${
          !selectedId ? 'bg-dbb-accent/15 text-white font-medium' : 'text-gray-400 hover:bg-white/5 hover:text-white'
        }`}
      >
        <BookOpen className="w-4 h-4 flex-shrink-0" />
        <span>All cards</span>
      </button>

      {/* Binder items */}
      {binders.map(b => (
        <BinderItem
          key={b.id}
          binder={b}
          isSelected={selectedId === b.id}
          onSelect={onSelect}
          onRename={handleRename}
          onDelete={handleDelete}
          onMerge={setMergeSource}
        />
      ))}

      {/* Create form */}
      {showCreate ? (
        <form onSubmit={handleCreate} className="flex items-center gap-1 px-2 py-1 flex-shrink-0 md:flex-shrink md:w-full">
          <input
            autoFocus
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="Binder name..."
            maxLength={60}
            className="flex-1 min-w-0 bg-dbb-primary border border-gray-700 rounded px-2 py-1 text-xs text-white focus:border-dbb-accent focus:outline-none placeholder-gray-600"
          />
          <button
            type="submit"
            disabled={creating || !newName.trim()}
            className="flex-shrink-0 text-green-400 hover:text-green-300 disabled:opacity-50"
          >
            {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => { setShowCreate(false); setNewName('') }}
            className="flex-shrink-0 text-gray-500 hover:text-white"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </form>
      ) : (
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-gray-500 hover:text-dbb-accent hover:bg-white/5 transition-colors flex-shrink-0 md:flex-shrink md:w-full"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New binder</span>
        </button>
      )}
    </>
  )
}
