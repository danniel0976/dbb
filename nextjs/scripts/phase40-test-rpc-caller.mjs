import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const read = name => readFileSync(new URL(`../src/app/api/${name}/route.js`, import.meta.url), 'utf8')
const user = { id: 'd0000000-0000-4000-8000-000000000001' }
const cardId = 'd3000000-0000-4000-8000-000000000001'
const targetId = 'd1000000-0000-4000-8000-000000000002'

async function invoke(name, method, body, { signedIn = true, binderExists = true, rpcError = null } = {}) {
  const calls = []
  const builder = (client, table) => {
    const query = { client, table, filters: [] }
    calls.push(query)
    const chain = {
      select() { return chain }, delete() { query.deleted = true; return chain },
      eq(key, value) { query.filters.push([key, value]); return chain },
      async single() { return { data: binderExists ? { id: targetId } : null } },
      async limit() { return { data: [{ id: cardId }], error: null } },
      then(resolve) { return Promise.resolve({ error: null }).then(resolve) },
    }
    return chain
  }
  const cookie = {
    auth: { async getUser() { calls.push({ auth: true }); return { data: { user: signedIn ? user : null } } } },
    from: table => builder('cookie', table),
    async rpc(name, args) { calls.push({ client: 'cookie', rpc: name, args }); return { data: 1, error: rpcError } },
  }
  const service = {
    from: table => builder('service', table),
    async rpc(name, args) { calls.push({ client: 'service', rpc: name, args }); return { data: 1, error: rpcError } },
  }
  const context = vm.createContext({
    createClient: async () => cookie,
    createServiceClient: (url, key) => {
      assert.equal(url, 'local-test-url'); assert.equal(key, 'service-test-only')
      calls.push({ serviceCreated: true }); return service
    },
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'local-test-url', SUPABASE_SERVICE_ROLE_KEY: 'service-test-only' } },
    NextResponse: { json: (data, options) => ({ data, status: options?.status ?? 200 }) },
    console: { error() {} },
  })
  const code = read(name).replace(/^import .*$/gm, '').replace(/export async function /g, 'async function ')
  const handler = vm.runInContext(`${code}\n${method}`, context)
  const response = await handler({ async json() { calls.push({ bodyRead: true }); return body } })
  return { response: JSON.parse(JSON.stringify(response)), calls: JSON.parse(JSON.stringify(calls)) }
}

for (const [name, method] of [['library/bulk', 'PATCH'], ['binders/merge', 'POST']]) {
  const body = name === 'library/bulk'
    ? { ids: [cardId], action: 'move', binder_id: targetId, user_id: 'attacker-supplied' }
    : { source_id: 'source', target_id: targetId, user_id: 'attacker-supplied' }
  const denied = await invoke(name, method, body, { signedIn: false })
  assert.equal(denied.response.status, 401)
  assert.ok(!denied.calls.some(call => call.rpc || call.serviceCreated || call.bodyRead))
  const missing = await invoke(name, method, body, { binderExists: false })
  assert.equal(missing.response.status, 404)
  assert.ok(!missing.calls.some(call => call.rpc || call.serviceCreated))
  const ok = await invoke(name, method, body)
  assert.deepEqual(ok.response, { status: 200, data: { success: true, moved: 1 } })
  const rpc = ok.calls.find(call => call.rpc)
  assert.equal(rpc.client, 'service', `${name}: move RPC must use service client`)
  assert.equal(rpc.args.p_user_id, user.id)
  assert.equal(rpc.args.p_target_binder_id, targetId)
  assert.deepEqual(rpc.args.p_ids, [cardId])
  assert.ok(ok.calls.filter(call => call.table === 'binders').every(call => call.filters.some(([key, value]) => key === 'user_id' && value === user.id)))
  const failed = await invoke(name, method, body, { rpcError: { message: 'test failure' } })
  assert.equal(failed.response.status, 500)
  assert.equal(failed.response.data.error, name === 'library/bulk' ? 'test failure' : 'Failed to move cards: test failure')
}
console.log('RPC_CALLER_PASS: bulk/merge session identity, owner checks, service RPC, 401 and error shapes')
