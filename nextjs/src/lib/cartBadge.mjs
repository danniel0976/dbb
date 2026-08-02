export function notifyCartChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('dbb-cart-updated'))
}
