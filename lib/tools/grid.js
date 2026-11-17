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

const { GridApi } = require('../grid_api')
const { isGridName, nameFor, normalizeGridUrl } = require('../grids')
const { ToolError, textResult } = require('./common')

/**
 * Tools that read a Selenium Grid's state. None of them changes the Grid:
 * ending sessions, draining or removing nodes and clearing the queue are left
 * to the person, so no agent can do them by mistake.
 */

const GRID = { type: 'string', description: 'Saved Grid name; the default Grid if omitted' }
const LEAVE_TO_PERSON =
  'Ending sessions, draining or removing nodes and clearing the queue are for the person to do on their Grid.'

/**
 * @param {!Object} ctx
 * @param {string=} name
 * @return {!GridApi}
 */
function apiFor(ctx, name) {
  return new GridApi(ctx.grids.resolve(name))
}

/**
 * @param {!Object} stereotype
 * @return {string} e.g. "chrome 141" or "firefox"
 */
function browserOf(stereotype) {
  const name = stereotype.browserName || 'any browser'
  return stereotype.browserVersion ? `${name} ${stereotype.browserVersion}` : name
}

function sameBrowser(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase()
}

/**
 * Free and total capacity per browser. A node runs at most maxSessions at
 * once whatever its slots, so both are capped by it.
 *
 * @param {!Array<!Object>} nodes the `nodes` of /status
 * @return {!Map<string, {free: number, total: number}>}
 */
function capacityByBrowser(nodes) {
  const result = new Map()
  for (const node of nodes) {
    const running = node.slots.filter((s) => s.session).length
    const room = node.availability === 'UP' ? Math.max(0, node.maxSessions - running) : 0
    const byBrowser = new Map()
    for (const slot of node.slots) {
      const key = browserOf(slot.stereotype)
      const entry = byBrowser.get(key) || { slots: 0, idle: 0 }
      entry.slots++
      if (!slot.session) entry.idle++
      byBrowser.set(key, entry)
    }
    for (const [key, { slots, idle }] of byBrowser) {
      const total = result.get(key) || { free: 0, total: 0 }
      total.total += Math.min(node.maxSessions, slots)
      total.free += Math.min(room, idle)
      result.set(key, total)
    }
  }
  return result
}

/**
 * @param {!Object} node a node from /status
 * @return {!Array<string>} lines describing it
 */
function describeNode(node) {
  const os = node.osInfo ? `${node.osInfo.name} ${node.osInfo.version} (${node.osInfo.arch})` : 'unknown'
  const running = node.slots.filter((s) => s.session)
  const lines = [
    `### Node ${node.id}`,
    `- URI: ${node.uri}`,
    `- Status: ${node.availability}`,
    `- Version: ${node.version}`,
    `- OS: ${os}`,
    `- Sessions: ${running.length} of at most ${node.maxSessions}`,
    `- Idle session timeout: ${Math.round(node.sessionTimeout / 1000)}s`,
    '',
    '### Slots',
  ]
  const counts = new Map()
  for (const slot of node.slots) {
    const key = `${browserOf(slot.stereotype)}${slot.stereotype.platformName ? ` on ${slot.stereotype.platformName}` : ''}`
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  for (const [key, n] of counts) lines.push(`- ${key}: ${n}`)
  if (running.length) {
    lines.push('', '### Running sessions')
    for (const slot of running) lines.push(`- ${slot.session.sessionId} (${browserOf(slot.stereotype)})`)
  }
  return lines
}

/**
 * @param {!GridApi} api
 * @param {!Object} status the value of /status
 * @param {!Array<string>} otherGrids
 * @return {string}
 */
function formatStatus(api, status, otherGrids) {
  const nodes = status.nodes || []
  const up = nodes.filter((n) => n.availability === 'UP').length
  const running = nodes.reduce((sum, n) => sum + n.slots.filter((s) => s.session).length, 0)
  const versions = [...new Set(nodes.map((n) => String(n.version).split(' ')[0]))]
  const lines = [
    `### Grid "${api.name}" (${api.url})`,
    `- Ready: ${status.ready ? 'yes' : 'no'} (${status.message})`,
    `- Nodes: ${nodes.length} (${up} up)` + (versions.length ? `, version ${versions.join(', ')}` : ''),
    `- Running sessions: ${running}`,
  ]
  const capacity = capacityByBrowser(nodes)
  if (capacity.size) {
    lines.push('', '### Free slots by browser (browsers on a node share its session limit)')
    for (const [browser, { free, total }] of [...capacity].sort()) lines.push(`- ${browser}: ${free} of ${total}`)
  }
  if (nodes.length) {
    lines.push('', '### Nodes')
    for (const n of nodes) {
      const busy = n.slots.filter((s) => s.session).length
      lines.push(`- ${n.id} ${n.availability}, ${busy}/${n.maxSessions} sessions, ${n.uri}`)
    }
  }
  if (otherGrids.length) lines.push('', `Other saved Grids: ${otherGrids.join(', ')}`)
  return lines.join('\n')
}

/**
 * @param {string} json a session's capabilities as GraphQL returns them
 * @return {!Object}
 */
function parseCapabilities(json) {
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

/**
 * @param {!GridApi} api
 * @param {!Array<!Object>} sessions from GraphQL
 * @param {{browser: (string|undefined), node: (string|undefined), olderThanMinutes: (number|undefined)}} filter
 * @return {string}
 */
function formatSessions(api, sessions, filter) {
  const rows = sessions
    .map((s) => ({ ...s, caps: parseCapabilities(s.capabilities), minutes: Number(s.sessionDurationMillis) / 60000 }))
    .filter((s) => filter.browser === undefined || sameBrowser(s.caps.browserName, filter.browser))
    .filter((s) => filter.node === undefined || s.nodeId === filter.node)
    .filter((s) => filter.olderThanMinutes === undefined || s.minutes >= filter.olderThanMinutes)
    .sort((a, b) => b.minutes - a.minutes)
  const lines = [
    `### Sessions on Grid "${api.name}": ${rows.length}` +
      (rows.length < sessions.length ? ` of ${sessions.length}` : ''),
  ]
  for (const s of rows) {
    const name = s.caps['se:name'] ? ` "${s.caps['se:name']}"` : ''
    lines.push(
      `- ${s.id}${name}: ${browserOf(s.caps)}, ${Math.floor(s.minutes)} min, started ${s.startTime}, ` +
        `node ${s.nodeId}, ${api.sessionLink(s.id)}`,
    )
  }
  lines.push('', `${LEAVE_TO_PERSON} A session's link opens it in the Grid UI.`)
  return lines.join('\n')
}

/**
 * A rough reading of why a request waits, from the browsers nodes offer. It
 * is not the Grid's own matching, which looks at every capability.
 *
 * @param {!Object} capabilities one alternative of a queued request
 * @param {!Array<!Object>} nodes from /status
 * @return {string}
 */
function queueHint(capabilities, nodes) {
  const wanted = capabilities.browserName
  const slots = nodes.flatMap((n) => n.slots.map((s) => ({ node: n, slot: s })))
  const offered = wanted === undefined ? slots : slots.filter((x) => sameBrowser(x.slot.stereotype.browserName, wanted))
  if (!offered.length)
    return `no node offers ${wanted}, so it waits until a node that does joins or the request times out`
  const freeCount = [...capacityByBrowser(nodes)]
    .filter(([browser]) => wanted === undefined || sameBrowser(browser.split(' ')[0], wanted))
    .reduce((sum, [, c]) => sum + c.free, 0)
  const what = wanted === undefined ? 'slot' : `${wanted} slot`
  return freeCount
    ? `${freeCount} ${what}(s) look free, so another capability may not match any node`
    : `every ${what} is busy, so it starts when one frees up`
}

/**
 * @param {!GridApi} api
 * @param {!Array<!Object>} queue from the session queue
 * @param {!Array<!Object>} nodes from /status
 * @return {string}
 */
function formatQueue(api, queue, nodes) {
  const lines = [`### Session queue on Grid "${api.name}": ${queue.length} waiting`]
  for (const request of queue) {
    lines.push(`- ${request.requestId}`)
    for (const caps of request.capabilities || []) {
      const { 'goog:chromeOptions': _c, 'moz:firefoxOptions': _f, 'ms:edgeOptions': _e, ...shown } = caps
      lines.push(`  - asks for ${JSON.stringify(shown)}`, `    hint: ${queueHint(caps, nodes)}`)
    }
  }
  if (queue.length) lines.push('', 'Hints compare browser names only; the Grid matches on every capability.')
  return lines.join('\n')
}

/**
 * A summary to paste into a GitHub issue. It leaves out URLs, ids and
 * hostnames, which can be private.
 *
 * @param {!Object} status the value of /status
 * @param {!Object} data GraphQL data
 * @param {{version: string, browser: string, headless: boolean}} about this server
 * @return {string}
 */
function formatBugReport(status, data, about) {
  const nodes = status.nodes || []
  const lines = [
    '**Selenium Grid**',
    '',
    `- Grid version: ${String(data.grid.version).split(' ')[0]}`,
    `- Ready: ${status.ready ? 'yes' : 'no'}`,
    `- Nodes: ${nodes.length}`,
    `- Running sessions: ${data.grid.sessionCount}, waiting in the queue: ${data.grid.sessionQueueSize}`,
    `- selenium-mcp: ${about.version}, ${about.browser}${about.headless ? ' (headless)' : ''}`,
    '',
    '| Node | Version | OS | Status | Max sessions | Idle timeout | Slots |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  nodes.forEach((node, i) => {
    const counts = new Map()
    for (const slot of node.slots) {
      const key = browserOf(slot.stereotype)
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    const slots = [...counts].map(([b, n]) => `${b} x${n}`).join(', ')
    const os = node.osInfo ? `${node.osInfo.name} ${node.osInfo.arch}` : 'unknown'
    lines.push(
      `| ${i + 1} | ${String(node.version).split(' ')[0]} | ${os} | ${node.availability} | ${node.maxSessions} | ` +
        `${Math.round(node.sessionTimeout / 1000)}s | ${slots} |`,
    )
  })
  return lines.join('\n')
}

const tools = [
  {
    name: 'selenium_grid_use',
    description: 'Save a Selenium Grid by URL, or pick a saved one, as the default. Use when the person names a Grid',
    inputSchema: {
      type: 'object',
      properties: {
        grid: { type: 'string', description: "The Grid's URL, or a saved Grid's name" },
        name: { type: 'string', description: 'Name to save a new Grid under' },
      },
      required: ['grid'],
    },
    async run(ctx, { grid, name }) {
      let url
      if (!/^https?:\/\//i.test(grid)) {
        url = ctx.grids.resolve(grid).url
        name = grid
      } else {
        try {
          url = normalizeGridUrl(grid)
        } catch (e) {
          throw new ToolError(e.message)
        }
        name = name || ctx.grids.nameOf(url) || nameFor(url)
        if (!isGridName(name)) {
          throw new ToolError(`"${name}" cannot name a Grid: use letters, digits, dot, dash or underscore.`)
        }
      }
      const api = new GridApi({ name, url })
      const status = await api.status()
      ctx.grids.save(name, url)
      const lines = [
        `Saved Grid "${name}" (${url}) in ${ctx.grids.file} as the default, so the person won't be asked again.`,
        `- Ready: ${status.ready ? 'yes' : 'no'} (${status.message})`,
      ]
      const browserGrid = ctx.grids.browserGrid()
      if (ctx.grids.pinnedByCommandLine) {
        lines.push(`- Browsers still start on "${browserGrid.name}", which the command line chose.`)
      } else {
        ctx.config.grid = browserGrid.url
        lines.push(
          ctx.session.isOpen
            ? '- The open browser stays where it is; the next one starts on this Grid.'
            : '- Browsers start on this Grid.',
        )
      }
      return textResult(lines.join('\n'))
    },
  },
  {
    name: 'selenium_grid_status',
    description: 'Show a Selenium Grid: readiness, nodes, free slots per browser. Give a node id for its details',
    inputSchema: {
      type: 'object',
      properties: { grid: GRID, node: { type: 'string', description: 'Node id or URI' } },
    },
    async run(ctx, { grid, node }) {
      const api = apiFor(ctx, grid)
      const status = await api.status()
      if (node === undefined) {
        return textResult(
          formatStatus(
            api,
            status,
            ctx.grids.names().filter((n) => n !== api.name),
          ),
        )
      }
      const match = (status.nodes || []).find((n) => n.id === node || n.uri === node)
      if (!match) {
        const ids = (status.nodes || []).map((n) => n.id)
        throw new ToolError(`No node ${node} on Grid "${api.name}". Nodes: ${ids.join(', ') || 'none'}.`)
      }
      return textResult(describeNode(match).join('\n'))
    },
  },
  {
    name: 'selenium_grid_sessions',
    description: 'List sessions running on a Selenium Grid, longest first, with links to them in the Grid UI',
    inputSchema: {
      type: 'object',
      properties: {
        grid: GRID,
        browser: { type: 'string', description: 'Only this browser, e.g. chrome' },
        node: { type: 'string', description: 'Only this node id' },
        olderThanMinutes: { type: 'number', description: 'Only sessions running at least this long' },
      },
    },
    async run(ctx, { grid, ...filter }) {
      const api = apiFor(ctx, grid)
      const data = await api.gridData()
      return textResult(formatSessions(api, data.sessionsInfo.sessions || [], filter))
    },
  },
  {
    name: 'selenium_grid_queue',
    description: 'List session requests waiting on a Selenium Grid, with a hint at why each waits',
    inputSchema: { type: 'object', properties: { grid: GRID } },
    async run(ctx, { grid }) {
      const api = apiFor(ctx, grid)
      const [queue, status] = await Promise.all([api.queue(), api.status()])
      return textResult(formatQueue(api, queue, status.nodes || []))
    },
  },
  {
    name: 'selenium_grid_bug_report',
    description: 'Summarize a Selenium Grid for a bug report, without URLs or ids',
    inputSchema: { type: 'object', properties: { grid: GRID } },
    async run(ctx, { grid }) {
      const api = apiFor(ctx, grid)
      const [status, data] = await Promise.all([api.status(), api.gridData()])
      const { packageVersion } = require('../server')
      const about = { version: packageVersion(), browser: ctx.config.browser, headless: ctx.config.headless }
      return textResult(formatBugReport(status, data, about))
    },
  },
]

module.exports = {
  LEAVE_TO_PERSON,
  capacityByBrowser,
  formatBugReport,
  formatQueue,
  formatSessions,
  formatStatus,
  queueHint,
  tools,
}
