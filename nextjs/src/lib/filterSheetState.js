// Pure state-transition logic for the mobile bottom filter sheet used by both
// Bazaar and Library (Phase 41 in-scope feature #1). The sheet holds a local
// "draft" copy of filters that is edited freely while open; nothing is
// committed to the surface's real applied-filter state / URL until Apply.
//
// This is deliberately framework-free so it can be unit tested without
// mounting React, and so both surfaces share the exact same staging
// semantics rather than reimplementing them twice.
//
// State shape: { open: boolean, draft: <filters object> }
// The "applied" filters always live outside this reducer (in the surface's
// own filters state) — OPEN copies them in as the starting draft, and both
// CLOSE and APPLY simply close the sheet. The caller is responsible for
// reading `state.draft` and committing it *only* on APPLY; on CLOSE the
// caller must not touch its applied state at all, which is what makes an
// accidental dismiss a no-op discard instead of a partial-apply.

export function initFilterSheetState(applied) {
  return { open: false, draft: { ...applied } }
}

export function filterSheetReducer(state, action) {
  switch (action.type) {
    case 'OPEN':
      // Always restart the draft from whatever is currently applied, so a
      // stale/discarded previous draft can never leak back in on reopen.
      return { open: true, draft: { ...action.applied } }
    case 'EDIT':
      return { ...state, draft: { ...state.draft, ...action.patch } }
    case 'REPLACE_DRAFT':
      return { ...state, draft: { ...action.draft } }
    case 'CLOSE':
      // Discard: intentionally does not touch draft's destination (applied
      // state) — caller must not read state.draft after this action.
      return { ...state, open: false }
    case 'APPLY':
      // Caller must read state.draft *before* dispatching APPLY and commit
      // it to applied state itself; this reducer only closes the sheet.
      return { ...state, open: false }
    default:
      return state
  }
}
