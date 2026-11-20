// Licensed to the Software Freedom Conservancy (SFC) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The SFC licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

'use strict'

const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const { GridApi } = require('../../lib/grid_api')
const { Grids, configFilePath, nameFor, normalizeGridUrl } = require('../../lib/grids')
const { ToolError } = require('../../lib/tools/common')
const {
  capacityByBrowser,
  formatBugReport,
  formatQueue,
  formatSessions,
  formatStatus,
  queueHint,
} = require('../../lib/tools/grid')

/** Answers captured from a Selenium Grid 4.52 hub with two nodes, four sessions and two queued requests. */
const status = require('../fixtures/grid/status.json').value
const queue = require('../fixtures/grid/queue.json').value
const graphql = require('../fixtures/grid/graphql.json').data

describe('grids', function () {
  let dir

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-grids-'))
  })

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function where(env = {}) {
    return { env, cwd: path.join(dir, 'project'), home: path.join(dir, 'home') }
  }

  function write(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data))
  }

  describe('configFilePath', function () {
    it('prefers --config, then the environment, then the project, then the user file', function () {
      const w = where({ SELENIUM_MCP_CONFIG: 'env.json' })
      assert.strictEqual(configFilePath({ configPath: 'flag.json' }, w), path.join(w.cwd, 'flag.json'))
      assert.strictEqual(configFilePath({}, w), path.join(w.cwd, 'env.json'))
      const user = path.join(w.home, '.config', 'selenium-mcp', 'config.json')
      assert.strictEqual(configFilePath({}, where()), user)
      write(path.join(w.cwd, '.selenium-mcp.json'), {})
      assert.strictEqual(configFilePath({}, where()), path.join(w.cwd, '.selenium-mcp.json'))
    })

    it('honours XDG_CONFIG_HOME for the user file', function () {
      const w = where({ XDG_CONFIG_HOME: path.join(dir, 'xdg') })
      assert.strictEqual(configFilePath({}, w), path.join(dir, 'xdg', 'selenium-mcp', 'config.json'))
    })
  })

  it('has no Grid until one is saved, and tells the agent to ask the person', function () {
    const grids = Grids.load({}, where())
    assert.strictEqual(grids.browserGrid(), undefined)
    assert.throws(
      () => grids.resolve(),
      (e) => e instanceof ToolError && /Ask the person/.test(e.message),
    )
  })

  it('saves a Grid as the default and finds it again on the next start', function () {
    Grids.load({}, where()).save('local', 'http://localhost:4444')
    const again = Grids.load({}, where())
    assert.deepStrictEqual(again.browserGrid(), { name: 'local', url: 'http://localhost:4444' })
    assert.deepStrictEqual(again.resolve('local'), { name: 'local', url: 'http://localhost:4444' })
    assert.deepStrictEqual(again.names(), ['local'])
  })

  it('keeps other settings in the file when saving', function () {
    const file = path.join(dir, 'grids.json')
    write(file, { defaultGrid: 'a', grids: { a: { url: 'http://a:4444' } }, future: true })
    Grids.load({ configPath: file }, where()).save('b', 'http://b:4444')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.strictEqual(data.future, true)
    assert.strictEqual(data.defaultGrid, 'b')
    assert.deepStrictEqual(Object.keys(data.grids), ['a', 'b'])
  })

  it('refuses to point a saved name at a different URL', function () {
    const grids = Grids.load({}, where())
    grids.save('ci', 'http://ci:4444')
    assert.throws(() => grids.save('ci', 'http://other:4444'), /already points at http:\/\/ci:4444/)
  })

  it('lets the command line choose the browser Grid, by URL or by saved name', function () {
    Grids.load({}, where()).save('ci', 'http://ci:4444')
    const byName = Grids.load({ grid: 'ci' }, where())
    assert.strictEqual(byName.browserGrid().url, 'http://ci:4444')
    assert.ok(byName.pinnedByCommandLine)
    const byUrl = Grids.load({ grid: 'http://user:pw@other:4444/' }, where())
    assert.deepStrictEqual(byUrl.browserGrid(), { name: 'command line', url: 'http://user:pw@other:4444' })
    assert.throws(() => Grids.load({ grid: 'nope' }, where()), /not a URL or a Grid saved in .*\(saved: ci\)/)
  })

  it('rejects config files it does not understand', function () {
    const file = path.join(dir, 'bad.json')
    const load = () => Grids.load({ configPath: file }, where())
    fs.writeFileSync(file, '{')
    assert.throws(load, /not valid JSON/)
    write(file, { grids: { a: { url: 'ftp://a' } } })
    assert.throws(load, /must be http or https/)
    write(file, { grids: { a: { url: 'http://a', password: 'x' } } })
    assert.throws(load, /settings this version does not know: password/)
    write(file, { grids: { a: { url: 'http://u:p@a' } } })
    assert.throws(load, /Credentials in a Grid URL are not saved/)
    write(file, { defaultGrid: 'b', grids: { a: { url: 'http://a' } } })
    assert.throws(load, /defaultGrid "b" is not one of the Grids/)
  })

  it('normalizes URLs and suggests names', function () {
    assert.strictEqual(normalizeGridUrl('http://grid:4444/sub/?x=1#y'), 'http://grid:4444/sub')
    assert.strictEqual(nameFor('http://localhost:4444'), 'local')
    assert.strictEqual(nameFor('https://grid.staging.example.com'), 'grid-staging-example-com')
  })
})

describe('grid tools', function () {
  const api = new GridApi({ name: 'local', url: 'http://localhost:4444/' })

  it('counts free slots per browser within each node session limit', function () {
    const capacity = capacityByBrowser(status.nodes)
    assert.deepStrictEqual(capacity.get('chrome'), { free: 0, total: 4 })
    const idle = status.nodes.map((n) => ({ ...n, slots: n.slots.map((s) => ({ ...s, session: null })) }))
    assert.deepStrictEqual(capacityByBrowser(idle).get('chrome'), { free: 4, total: 4 })
    const down = idle.map((n) => ({ ...n, availability: 'DOWN' }))
    assert.deepStrictEqual(capacityByBrowser(down).get('chrome'), { free: 0, total: 4 })
  })

  it('summarizes the Grid with its nodes and other saved Grids', function () {
    const text = formatStatus(api, status, ['staging'])
    assert.match(text, /### Grid "local" \(http:\/\/localhost:4444\)/)
    assert.match(text, /- Nodes: 2 \(2 up\), version 4\.52\.0/)
    assert.match(text, /- chrome: 0 of 4/)
    assert.match(text, /Other saved Grids: staging/)
  })

  it('lists sessions longest first with Grid UI links, and filters them', function () {
    const sessions = graphql.sessionsInfo.sessions
    const text = formatSessions(api, sessions, {})
    const first = sessions.find((s) => s.capabilities.includes('"probe"'))
    assert.match(text, /### Sessions on Grid "local": 4\n/)
    assert.match(text.split('\n')[1], new RegExp(`^- ${first.id} "probe": chrome`))
    assert.ok(text.includes(`http://localhost:4444/ui/#/session/${first.id}`))
    assert.match(text, /for the person to do/)
    assert.match(formatSessions(api, sessions, { node: first.nodeId }), /: 2 of 4\n/)
    assert.match(formatSessions(api, sessions, { browser: 'firefox' }), /: 0 of 4\n/)
    assert.match(formatSessions(api, sessions, { olderThanMinutes: 1e6 }), /: 0 of 4\n/)
  })

  it('explains queued requests by the browsers nodes offer', function () {
    const text = formatQueue(api, queue, status.nodes)
    assert.match(text, /2 waiting/)
    assert.match(text, /every chrome slot is busy/)
    assert.match(text, /no node offers safari/)
    const idle = status.nodes.map((n) => ({ ...n, slots: n.slots.map((s) => ({ ...s, session: null })) }))
    assert.match(queueHint({ browserName: 'Chrome' }, idle), /4 Chrome slot\(s\) look free/)
  })

  it('writes a bug report without URLs or ids', function () {
    const text = formatBugReport(status, graphql, { version: '0.1.0', browser: 'chrome', headless: true })
    assert.match(text, /Grid version: 4\.52\.0/)
    assert.match(text, /\| 1 \| 4\.52\.0 \| Linux amd64 \| UP \| 2 \| 300s \|/)
    assert.doesNotMatch(text, /http|192\.0\.2|[0-9a-f]{8}-[0-9a-f]{4}/)
  })
})

describe('GridApi', function () {
  let server
  let url
  let handler

  before(async function () {
    server = http.createServer((req, res) => handler(req, res))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${server.address().port}`
  })

  after(function () {
    server.close()
  })

  it('sends basic credentials from the URL as a header, and keeps them out of links', async function () {
    let seen
    handler = (req, res) => {
      seen = req.headers.authorization
      res.end(JSON.stringify({ value: { ready: true } }))
    }
    const api = new GridApi({ name: 'g', url: url.replace('http://', 'http://me:s%40cret@') })
    assert.deepStrictEqual(await api.status(), { ready: true })
    assert.strictEqual(seen, `Basic ${Buffer.from('me:s@cret').toString('base64')}`)
    assert.ok(!api.sessionLink('x').includes('cret'))
  })

  it('sends GraphQL with the charset the Grid insists on', async function () {
    let type
    handler = (req, res) => {
      type = req.headers['content-type']
      res.end(JSON.stringify({ data: { grid: {} } }))
    }
    await new GridApi({ name: 'g', url }).gridData()
    assert.strictEqual(type, 'application/json; charset=utf-8')
  })

  it('turns failures into advice for the agent', async function () {
    handler = (_req, res) => res.writeHead(401).end('{}')
    await assert.rejects(new GridApi({ name: 'g', url }).status(), /refused the request \(HTTP 401\)/)
    handler = (_req, res) => res.end('<html>')
    await assert.rejects(new GridApi({ name: 'g', url }).status(), /Is .* a Selenium Grid\?/)
    handler = () => {}
    await assert.rejects(new GridApi({ name: 'g', url }, { timeoutMs: 200 }).status(), /no answer within 0.2s/)
    await assert.rejects(new GridApi({ name: 'g', url: 'http://127.0.0.1:1' }).status(), /Could not reach the Grid "g"/)
  })
})
