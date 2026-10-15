// Render a real client component to markup from a plain `node scripts/...` run.
//
// The repo has no jsdom/testing-library, so scanner UI claims used to be checked
// by grepping the component source. That cannot tell whether a field actually
// reaches the DOM. This harness resolves what Next resolves (the `@/` alias and
// extensionless relative imports), transforms JSX with the sucrase already in the
// tree, and renders through react-dom/server.
//
// Limitation worth knowing before writing a test against it: this is a static
// server render. `useState` initial values and `useRef` work; `useEffect` never
// runs and there are no events, so only prop-driven markup is observable here.
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { transform } from 'sucrase'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const SRC_URL = new URL('../../src/', import.meta.url)

function resolveSrcAlias(specifier, context, nextResolve) {
  const spec = specifier.startsWith('@/')
    ? new URL(specifier.slice(2), SRC_URL).href
    : specifier
  try {
    return nextResolve(spec, context)
  } catch (err) {
    // Node ESM requires file extensions; Next does not. Only retry for paths.
    if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('file:')) throw err
    const base = context?.parentURL ? new URL(spec, context.parentURL) : new URL(spec)
    for (const ext of ['.js', '.mjs', '/index.js']) {
      const candidate = `${base.href}${ext}`
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate, context)
    }
    throw err
  }
}

function loadWithJsx(url, context, nextLoad) {
  if (!url.startsWith(SRC_URL.href) || !url.endsWith('.js')) return nextLoad(url, context)
  const path = fileURLToPath(url)
  const { code } = transform(readFileSync(path, 'utf8'), {
    transforms: ['jsx'],
    jsxRuntime: 'automatic',
    production: true,
    filePath: path,
  })
  return { format: 'module', shortCircuit: true, source: code }
}

registerHooks({ resolve: resolveSrcAlias, load: loadWithJsx })

/** Import a module under `src/` by path relative to `src/`, JSX and alias included. */
export function importSrc(relativePath) {
  return import(new URL(relativePath, SRC_URL).href)
}

/** Static markup for one component + props, as the browser would receive it. */
export function renderMarkup(Component, props = {}) {
  return renderToStaticMarkup(createElement(Component, props))
}

/** Rendered markup with tags (and inline icon SVGs) removed, for text assertions. */
export function visibleText(markup) {
  return markup
    .replace(/<svg\b[\s\S]*?<\/svg>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&middot;|&#xB7;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}
