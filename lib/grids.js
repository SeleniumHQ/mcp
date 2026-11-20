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

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const logging = require('selenium-webdriver/lib/logging')

const { ToolError } = require('./tools/common')

const log_ = logging.getLogger('selenium.mcp.grids')

/** File in a project's working directory that holds its Grids. */
const PROJECT_FILE = '.selenium-mcp.json'
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const NO_GRID =
  'No Selenium Grid is set up. Ask the person which Grid to use, then call selenium_grid_use with its URL.'

/**
 * @param {string} name
 * @return {boolean} whether it can name a saved Grid
 */
function isGridName(name) {
  return NAME.test(name)
}

/**
 * Checks a Grid URL and returns it without a trailing slash.
 *
 * @param {string} value
 * @param {{allowCredentials: (boolean|undefined)}=} options
 * @return {string}
 * @throws {Error} if it is not an http(s) URL, or has credentials that are not allowed
 */
function normalizeGridUrl(value, options = {}) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Not a URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`A Grid URL must be http or https; got ${value}`)
  }
  if ((url.username || url.password) && !options.allowCredentials) {
    throw new Error('Credentials in a Grid URL are not saved. Give the URL without a user name or password.')
  }
  url.hash = ''
  url.search = ''
  return url.href.replace(/\/+$/, '')
}

/**
 * @param {string} url
 * @return {string} the URL with any user name and password removed, for showing
 */
function redact(url) {
  try {
    const u = new URL(url)
    u.username = ''
    u.password = ''
    return u.href.replace(/\/+$/, '')
  } catch {
    return url
  }
}

/**
 * Finds the config file: --config, then SELENIUM_MCP_CONFIG, then
 * .selenium-mcp.json in the working directory, then the user's own file.
 * Grids are saved back to the same file.
 *
 * @param {{configPath: (string|undefined)}} config
 * @param {{env: !Object, cwd: string, home: string}} where
 * @return {string}
 */
function configFilePath(config, where) {
  if (config.configPath) return path.resolve(where.cwd, config.configPath)
  if (where.env.SELENIUM_MCP_CONFIG) return path.resolve(where.cwd, where.env.SELENIUM_MCP_CONFIG)
  const project = path.join(where.cwd, PROJECT_FILE)
  if (fs.existsSync(project)) return project
  const base = where.env.XDG_CONFIG_HOME || path.join(where.home, '.config')
  return path.join(base, 'selenium-mcp', 'config.json')
}

/**
 * @param {string} file
 * @return {{defaultGrid: (string|undefined), grids: !Object<string, {url: string}>}}
 * @throws {Error} if the file is not a config this version understands
 */
function readConfigFile(file) {
  if (!fs.existsSync(file)) return { defaultGrid: undefined, grids: {} }
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`, { cause: e })
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} must hold a JSON object`)
  const grids = {}
  for (const [name, entry] of Object.entries(data.grids || {})) {
    if (!isGridName(name)) throw new Error(`${file}: "${name}" is not a valid Grid name`)
    if (!entry || typeof entry.url !== 'string') throw new Error(`${file}: Grid "${name}" needs a "url"`)
    const unknown = Object.keys(entry).filter((k) => k !== 'url')
    if (unknown.length) throw new Error(`${file}: Grid "${name}" has settings this version does not know: ${unknown}`)
    try {
      grids[name] = { url: normalizeGridUrl(entry.url) }
    } catch (e) {
      throw new Error(`${file}: Grid "${name}": ${e.message}`, { cause: e })
    }
  }
  const defaultGrid = data.defaultGrid
  if (defaultGrid !== undefined && !grids[defaultGrid]) {
    throw new Error(`${file}: defaultGrid "${defaultGrid}" is not one of the Grids in the file`)
  }
  return { defaultGrid, grids, rest: data }
}

/**
 * The Grids the server knows: those saved in the config file, plus one given
 * as a URL on the command line.
 */
class Grids {
  /**
   * @param {{configPath: (string|undefined), grid: (string|undefined)}} config parsed command line
   * @param {{env: (!Object|undefined), cwd: (string|undefined), home: (string|undefined)}=} where
   * @return {!Grids}
   * @throws {Error} if the config file cannot be read or --grid names an unknown Grid
   */
  static load(config, where = {}) {
    const resolved = {
      env: where.env || process.env,
      cwd: where.cwd || process.cwd(),
      home: where.home || os.homedir(),
    }
    const file = configFilePath(config, resolved)
    return new Grids(file, readConfigFile(file), config.grid)
  }

  /**
   * @param {string} file
   * @param {{defaultGrid: (string|undefined), grids: !Object, rest: (!Object|undefined)}} saved
   * @param {string|undefined} cliGrid the --grid value: a URL or a saved Grid's name
   */
  constructor(file, saved, cliGrid) {
    this.file = file
    this.saved_ = saved
    /** A Grid given by URL on the command line, which is never saved. */
    this.cliUrl_ = undefined
    /** A saved Grid chosen on the command line, which saving does not override. */
    this.cliName_ = undefined
    if (cliGrid !== undefined) {
      if (/^https?:\/\//i.test(cliGrid)) {
        this.cliUrl_ = normalizeGridUrl(cliGrid, { allowCredentials: true })
      } else if (saved.grids[cliGrid]) {
        this.cliName_ = cliGrid
      } else {
        const known = Object.keys(saved.grids)
        throw new Error(
          `--grid ${cliGrid} is not a URL or a Grid saved in ${file}` +
            (known.length ? ` (saved: ${known.join(', ')})` : ''),
        )
      }
    }
  }

  /** @return {!Array<string>} names of the saved Grids */
  names() {
    return Object.keys(this.saved_.grids)
  }

  /**
   * @return {{name: string, url: string}|undefined} the Grid browsers start
   *     on: the command line's, else the saved default
   */
  browserGrid() {
    if (this.cliUrl_) return { name: 'command line', url: this.cliUrl_ }
    const name = this.cliName_ || this.saved_.defaultGrid
    return name ? { name, url: this.saved_.grids[name].url } : undefined
  }

  /**
   * @param {string=} name a saved Grid's name; the default when omitted
   * @return {{name: string, url: string}}
   * @throws {ToolError} if there is no such Grid, or none at all
   */
  resolve(name) {
    if (name === undefined) {
      const grid = this.browserGrid()
      if (!grid) throw new ToolError(NO_GRID)
      return grid
    }
    const saved = this.saved_.grids[name]
    if (saved) return { name, url: saved.url }
    const known = this.names()
    throw new ToolError(
      known.length
        ? `No Grid is saved as "${name}". Saved Grids: ${known.join(', ')}.`
        : `No Grid is saved as "${name}". ${NO_GRID}`,
    )
  }

  /**
   * @param {string} url
   * @return {string|undefined} the name of a saved Grid at this URL
   */
  nameOf(url) {
    return this.names().find((n) => this.saved_.grids[n].url === url)
  }

  /**
   * Saves a Grid and makes it the default, so the person is not asked again.
   *
   * @param {string} name
   * @param {string} url already normalized
   */
  save(name, url) {
    const current = this.saved_.grids[name]
    if (current && current.url !== url) {
      throw new ToolError(`A Grid named "${name}" already points at ${current.url}. Choose another name.`)
    }
    const grids = { ...this.saved_.grids, [name]: { url } }
    const data = { ...(this.saved_.rest || {}), defaultGrid: name, grids }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
    fs.renameSync(tmp, this.file)
    this.saved_ = { defaultGrid: name, grids, rest: data }
    log_.info(`saved Grid "${name}" (${url}) to ${this.file} as the default`)
  }

  /**
   * @return {boolean} whether the command line fixes which Grid browsers use
   */
  get pinnedByCommandLine() {
    return this.cliUrl_ !== undefined || this.cliName_ !== undefined
  }
}

/**
 * Suggests a name for a Grid from its URL, e.g. grid.example.com -> grid-example-com.
 *
 * @param {string} url
 * @return {string}
 */
function nameFor(url) {
  const { hostname } = new URL(url)
  if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return 'local'
  return hostname
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\./g, '-')
    .slice(0, 64)
}

module.exports = { Grids, PROJECT_FILE, configFilePath, isGridName, nameFor, normalizeGridUrl, redact }
