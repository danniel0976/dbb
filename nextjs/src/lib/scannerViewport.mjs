// Keep the scanner inside the *visible* viewport (mobile toolbar/keyboard).
// The tray owns its own scroll; these dimensions only change on viewport events.
export function revealScannerNotice(shell) {
  const tray = shell?.querySelector('[data-scanner-tray]')
  if (tray) tray.scrollTop = 0
  shell?.querySelector('[data-scanner-notice]')?.querySelector('button')?.focus({ preventScroll: true })
}

export function attachScannerViewport(element, win = window) {
  const viewport = win.visualViewport
  const names = ['--scanner-height', '--scanner-width', '--scanner-top', '--scanner-left']
  const previous = names.map(name => element.style.getPropertyValue(name))
  const update = () => {
    const values = [viewport?.height ?? win.innerHeight, viewport?.width ?? win.innerWidth, viewport?.offsetTop ?? 0, viewport?.offsetLeft ?? 0]
    names.forEach((name, index) => element.style.setProperty(name, `${values[index]}px`))
  }
  update()
  win.addEventListener('resize', update)
  viewport?.addEventListener('resize', update)
  viewport?.addEventListener('scroll', update)
  return () => {
    win.removeEventListener('resize', update)
    viewport?.removeEventListener('resize', update)
    viewport?.removeEventListener('scroll', update)
    names.forEach((name, index) => previous[index] ? element.style.setProperty(name, previous[index]) : element.style.removeProperty(name))
  }
}
