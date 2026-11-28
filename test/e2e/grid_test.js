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
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')

const { startMcp } = require('./harness')

/**
 * Runs the selenium_grid_* tools against a real Grid: a hub and two nodes
 * started from the server jar in SELENIUM_MCP_TEST_SERVER_JAR (not SELENIUM_SERVER_JAR,
 * which makes selenium-webdriver start its own server). Skipped without it.
 * SELENIUM_MCP_TEST_NODE_ARGS adds node flags, e.g. "--selenium-manager true".
 */
const JAR = process.env.SELENIUM_MCP_TEST_SERVER_JAR
const NODE_ARGS = (process.env.SELENIUM_MCP_TEST_NODE_ARGS || '').split(' ').filter(Boolean)

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

function startJava(args, log) {
  const out = fs.openSync(log, 'w')
  return spawn('java', ['-jar', JAR, ...args], { stdio: ['ignore', out, out] })
}

async function waitForNodes(url, count, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const { value } = await (await fetch(`${url}/status`)).json()
      if (value.nodes && value.nodes.filter((n) => n.availability === 'UP').length >= count) return
    } catch {
      // The hub is still starting.
    }
    if (Date.now() > deadline) throw new Error(`Grid at ${url} did not get ${count} nodes`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

describe('selenium_grid_* tools on a real Grid', function () {
  this.timeout(180000)
  const processes = []
  let url
  let mcp

  before(async function () {
    if (!JAR) this.skip()
    const hubPort = await freePort()
    url = `http://127.0.0.1:${hubPort}`
    const logs = fs.mkdtempSync(`${require('node:os').tmpdir()}/selenium-mcp-grid-`)
    processes.push(startJava(['hub', '--host', '127.0.0.1', '--port', String(hubPort)], `${logs}/hub.log`))
    for (const name of ['node1', 'node2']) {
      const args = ['node', '--host', '127.0.0.1', '--port', String(await freePort()), '--hub', url]
      processes.push(startJava([...args, '--max-sessions', '1', ...NODE_ARGS], `${logs}/${name}.log`))
    }
    await waitForNodes(url, 2)
    mcp = await startMcp()
  })

  after(async function () {
    if (mcp) await mcp.close()
    for (const p of processes) p.kill()
  })

  async function ok(name, args) {
    const result = await mcp.call(name, args)
    assert.ok(!result.isError, `${name} failed: ${result.text}`)
    return result.text
  }

  it('asks for a Grid until one is saved', async function () {
    const result = await mcp.call('selenium_grid_status')
    assert.ok(result.isError)
    assert.match(result.text, /Ask the person which Grid to use/)
  })

  it('saves the Grid the person names, so it is not asked for again', async function () {
    const text = await ok('selenium_grid_use', { grid: url, name: 'test' })
    assert.match(text, /Saved Grid "test"/)
    const saved = JSON.parse(fs.readFileSync(mcp.grids.file, 'utf8'))
    assert.deepStrictEqual(saved, { defaultGrid: 'test', grids: { test: { url } } })
  })

  it('shows the hub and both nodes', async function () {
    const text = await ok('selenium_grid_status')
    assert.match(text, /- Nodes: 2 \(2 up\)/)
    const nodeId = text.match(/### Nodes\n- (\S+)/)[1]
    assert.match(await ok('selenium_grid_status', { node: nodeId }), new RegExp(`### Node ${nodeId}`))
    const wrong = await mcp.call('selenium_grid_status', { node: 'nope' })
    assert.ok(wrong.isError)
    assert.match(wrong.text, /No node nope/)
  })

  it('starts the browser on the saved Grid and lists its session', async function () {
    await ok('browser_console_messages')
    const text = await ok('selenium_grid_sessions')
    // The browserName the Grid reports, which for Edge is not the --browser name.
    const reported = { chrome: 'chrome', edge: 'MicrosoftEdge', firefox: 'firefox' }[mcp.session.config.browser]
    assert.match(text, new RegExp(`: 1\\n- [0-9a-f-]+ "selenium-mcp": ${reported} `))
    assert.ok(text.includes(`${url}/ui/#/session/`))
  })

  it('shows an empty queue and a bug report without URLs', async function () {
    assert.match(await ok('selenium_grid_queue'), /0 waiting/)
    const report = await ok('selenium_grid_bug_report')
    assert.match(report, /- Nodes: 2/)
    assert.ok(!report.includes('127.0.0.1'))
  })
})
