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

const logging = require('selenium-webdriver/lib/logging')

const { ToolError } = require('./tools/common')
const { redact } = require('./grids')

const log_ = logging.getLogger('selenium.mcp.grid')

const TIMEOUT_MS = 10000

/** What the Grid tools read over GraphQL, in one request. */
const GRID_QUERY = `{
  grid { version sessionCount sessionQueueSize }
  sessionsInfo {
    sessions { id capabilities startTime nodeId sessionDurationMillis }
  }
}`

/**
 * Reads a Selenium Grid's state over its HTTP API: /status, /graphql and the
 * session queue. It only reads; nothing here changes the Grid.
 */
class GridApi {
  /**
   * @param {{name: string, url: string}} grid
   * @param {{fetch: (function|undefined), timeoutMs: (number|undefined)}=} options
   */
  constructor(grid, options = {}) {
    this.name = grid.name
    const url = new URL(grid.url)
    this.headers_ = {}
    if (url.username || url.password) {
      const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
      this.headers_.authorization = `Basic ${Buffer.from(credentials).toString('base64')}`
      url.username = ''
      url.password = ''
    }
    /** The Grid's URL as given, without credentials and trailing slash. */
    this.url = url.href.replace(/\/+$/, '')
    this.fetch_ = options.fetch || globalThis.fetch
    this.timeoutMs_ = options.timeoutMs || TIMEOUT_MS
  }

  /** @return {!Promise<!Object>} the `value` of GET /status */
  async status() {
    return (await this.request_('GET', '/status')).value
  }

  /** @return {!Promise<!Array<{requestId: string, capabilities: !Array<!Object>}>>} waiting requests */
  async queue() {
    return (await this.request_('GET', '/se/grid/newsessionqueue/queue')).value || []
  }

  /** @return {!Promise<!Object>} the `data` of GRID_QUERY */
  async gridData() {
    const body = await this.request_('POST', '/graphql', { query: GRID_QUERY })
    if (body.errors && body.errors.length) {
      throw new ToolError(`The Grid "${this.name}" rejected the query: ${body.errors[0].message}`)
    }
    return body.data
  }

  /**
   * @param {string} id
   * @return {string} where a person can watch, or end, the session in the Grid UI
   */
  sessionLink(id) {
    return `${this.url}/ui/#/session/${id}`
  }

  async request_(method, path, body) {
    const where = `${this.url}${path}`
    log_.fine(`${method} ${where}`)
    let response
    try {
      response = await this.fetch_(where, {
        method,
        headers: {
          ...this.headers_,
          accept: 'application/json',
          // The Grid refuses a JSON body unless the charset is spelled out.
          ...(body ? { 'content-type': 'application/json; charset=utf-8' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs_),
      })
    } catch (e) {
      const reason = e.name === 'TimeoutError' ? `no answer within ${this.timeoutMs_ / 1000}s` : causeOf(e)
      log_.warning(`${method} ${redact(where)} failed: ${reason}`)
      throw new ToolError(
        `Could not reach the Grid "${this.name}" at ${this.url}: ${reason}. ` +
          'Check the URL with the person; selenium_grid_use saves a corrected one.',
      )
    }
    if (response.status === 401 || response.status === 403) {
      throw new ToolError(
        `The Grid "${this.name}" at ${this.url} refused the request (HTTP ${response.status}); it needs credentials ` +
          'this server does not have.',
      )
    }
    const text = await response.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new ToolError(
        `${this.url}${path} answered HTTP ${response.status} without JSON. Is ${this.url} a Selenium Grid?`,
      )
    }
    if (!response.ok && !json.data) {
      const message = (json.value && json.value.message) || `HTTP ${response.status}`
      throw new ToolError(`The Grid "${this.name}" answered ${path} with an error: ${firstLine(message)}`)
    }
    return json
  }
}

function causeOf(e) {
  const cause = e.cause || e
  return cause.code || cause.message || String(cause)
}

function firstLine(message) {
  return String(message).split('\n')[0]
}

module.exports = { GRID_QUERY, GridApi }
