// Execute owned scanner components/handlers with a deterministic hook host.
// This is not a DOM/browser emulator. Camera/OCR/network seams are doubles;
// component callbacks, effects and async continuations are the real source.
import { readFileSync } from 'node:fs'
import { transform } from 'sucrase'

export function scannerComponentHarness(relativePath, dependencies = {}) {
  const slots = []
  let cursor = 0
  let effects = []
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const createElement = (type, props, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } })
  const react = {
    createElement, Fragment: 'fragment',
    useState(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [slots[index].value, next => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next }]
    },
    useRef(initial) {
      const index = cursor++
      slots[index] ||= { ref: { current: initial } }
      return slots[index].ref
    },
    useCallback(callback, deps) {
      const index = cursor++
      if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { value: callback, deps }
      return slots[index].value
    },
    useEffect(effect, deps) {
      const index = cursor++
      if (!sameDeps(slots[index]?.deps, deps)) effects.push(() => {
        slots[index]?.cleanup?.()
        slots[index] = { deps, cleanup: effect() }
      })
    },
  }
  const stub = name => Object.assign(() => null, { displayName: name })
  const require = specifier => {
    if (specifier === 'react') return react
    if (specifier === 'lucide-react') return new Proxy({}, { get: (_, name) => stub(name) })
    if (specifier in dependencies) return { __esModule: true, ...dependencies[specifier] }
    throw new Error(`Unprovided component dependency: ${specifier}`)
  }
  let source = readFileSync(new URL(`../../src/${relativePath}`, import.meta.url), 'utf8')
  // Optional dynamic engine import is a seam too: never start/download a real
  // OCR worker from these offline component tests.
  if (dependencies['tesseract.js']) source = source.replace("import('tesseract.js')", "Promise.resolve(require('tesseract.js'))")
  const { code } = transform(source, { transforms: ['jsx', 'imports'], jsxRuntime: 'classic', production: true })
  const module = { exports: {} }
  // Classic JSX expects React; production components otherwise use named hooks.
  new Function('require', 'module', 'exports', 'React', 'window', code)(require, module, module.exports, react, globalThis.window || new EventTarget())
  return {
    render(props = {}, attach = () => {}) {
      cursor = 0
      effects = []
      const tree = module.exports.default(props)
      attach(tree)
      for (const effect of effects) effect()
      return tree
    },
    unmount() { for (const slot of slots) slot?.cleanup?.() },
  }
}

export function findScannerElement(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null
  if (Array.isArray(tree)) {
    for (const child of tree) { const found = findScannerElement(child, predicate); if (found) return found }
    return null
  }
  if (predicate(tree)) return tree
  return findScannerElement(tree.props?.children, predicate)
}
export function scannerElementText(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(scannerElementText).join('')
  return tree && typeof tree === 'object' ? scannerElementText(tree.props?.children) : ''
}
