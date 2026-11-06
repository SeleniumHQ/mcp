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

const { error } = require('selenium-webdriver')

const { ToolError, textResult } = require('./common')

const SAME_SITE = ['Strict', 'Lax', 'None']

/**
 * @param {!Object} cookie as WebDriver returns it
 * @return {string} one line: name=value, then its attributes
 */
function formatCookie(cookie) {
  const attributes = [`domain=${cookie.domain}`, `path=${cookie.path}`]
  if (cookie.expiry !== undefined) attributes.push(`expires=${cookie.expiry}`)
  if (cookie.httpOnly) attributes.push('httpOnly')
  if (cookie.secure) attributes.push('secure')
  if (cookie.sameSite) attributes.push(`sameSite=${cookie.sameSite}`)
  return `${cookie.name}=${cookie.value} (${attributes.join(', ')})`
}

/**
 * @param {string} cookieDomain e.g. .example.com
 * @param {string} wanted e.g. example.com
 * @return {boolean}
 */
function domainMatches(cookieDomain, wanted) {
  const strip = (d) => String(d).toLowerCase().replace(/^\./, '')
  return strip(cookieDomain) === strip(wanted)
}

async function topDocument(ctx) {
  const driver = await ctx.session.driver()
  await driver.switchTo().defaultContent()
  return driver
}

const cookieTools = [
  {
    name: 'browser_cookie_list',
    description: 'List the cookies the current page can see, optionally filtered by domain or path',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Only cookies on this domain' },
        path: { type: 'string', description: 'Only cookies on this path' },
      },
    },
    async run(ctx, { domain, path }) {
      const driver = await topDocument(ctx)
      const cookies = (await driver.manage().getCookies()).filter(
        (c) => (domain === undefined || domainMatches(c.domain, domain)) && (path === undefined || c.path === path),
      )
      if (!cookies.length) return textResult('No cookies.')
      return textResult(cookies.map(formatCookie).join('\n'))
    },
  },
  {
    name: 'browser_cookie_get',
    description: 'Get a cookie by name',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Cookie name' } },
      required: ['name'],
    },
    async run(ctx, { name }) {
      const driver = await topDocument(ctx)
      let cookie
      try {
        cookie = await driver.manage().getCookie(name)
      } catch (e) {
        if (!(e instanceof error.NoSuchCookieError)) throw e
      }
      return textResult(cookie ? formatCookie(cookie) : `No cookie named ${JSON.stringify(name)}.`)
    },
  },
  {
    name: 'browser_cookie_set',
    description: 'Set a cookie for the current page',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Cookie name' },
        value: { type: 'string', description: 'Cookie value' },
        domain: { type: 'string', description: 'Cookie domain; defaults to the page host' },
        path: { type: 'string', description: 'Cookie path; defaults to /' },
        expires: { type: 'number', description: 'Expiry as a Unix timestamp in seconds' },
        httpOnly: { type: 'boolean' },
        secure: { type: 'boolean' },
        sameSite: { type: 'string', enum: SAME_SITE },
      },
      required: ['name', 'value'],
    },
    async run(ctx, { name, value, domain, path, expires, httpOnly, secure, sameSite }) {
      const driver = await topDocument(ctx)
      const cookie = { name, value }
      if (domain !== undefined) cookie.domain = domain
      if (path !== undefined) cookie.path = path
      if (expires !== undefined) cookie.expiry = Math.floor(expires)
      if (httpOnly !== undefined) cookie.httpOnly = httpOnly
      if (secure !== undefined) cookie.secure = secure
      if (sameSite !== undefined) cookie.sameSite = sameSite
      try {
        await driver.manage().addCookie(cookie)
      } catch (e) {
        if (e instanceof error.InvalidCookieDomainError || e instanceof error.UnableToSetCookieError) {
          throw new ToolError(`Could not set the cookie: ${e.message.split('\n')[0]}`)
        }
        throw e
      }
      return textResult(`Set cookie ${name}`)
    },
  },
  {
    name: 'browser_cookie_delete',
    description: 'Delete a cookie, optionally only if it is on a given domain or path',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Cookie name' },
        domain: { type: 'string', description: 'Only delete it on this domain' },
        path: { type: 'string', description: 'Only delete it on this path' },
      },
      required: ['name'],
    },
    async run(ctx, { name, domain, path }) {
      const driver = await topDocument(ctx)
      const matching = (await driver.manage().getCookies()).filter(
        (c) =>
          c.name === name &&
          (domain === undefined || domainMatches(c.domain, domain)) &&
          (path === undefined || c.path === path),
      )
      if (!matching.length) return textResult(`No cookie named ${JSON.stringify(name)} matched.`)
      // WebDriver deletes by name alone, so refuse rather than delete a
      // same-named cookie the filter was meant to spare.
      const all = (await driver.manage().getCookies()).filter((c) => c.name === name)
      if (all.length > matching.length) {
        throw new ToolError(
          `Other cookies are also named ${JSON.stringify(name)}, and WebDriver can only delete them all together.`,
        )
      }
      await driver.manage().deleteCookie(name)
      return textResult(`Deleted cookie ${name}`)
    },
  },
  {
    name: 'browser_cookie_clear',
    description: 'Delete all the cookies the current page can see',
    inputSchema: { type: 'object', properties: {} },
    async run(ctx) {
      const driver = await topDocument(ctx)
      await driver.manage().deleteAllCookies()
      return textResult('Cleared cookies')
    },
  },
]

/**
 * Runs `script` against the page's Web Storage area. Reading the area on a
 * page without storage (about:blank, data:) throws, and drivers report that
 * differently, so the script catches it and the error becomes advice.
 */
async function withStorage(ctx, area, script, ...args) {
  const driver = await topDocument(ctx)
  const result = await driver.executeScript(
    `let store
     try {
       store = window.${area}
     } catch (e) {
       return { unavailable: String(e.message || e) }
     }
     return { value: (() => { ${script} })() }`,
    ...args,
  )
  if (result.unavailable !== undefined) {
    throw new ToolError(`${area} is not available on this page: ${result.unavailable}`)
  }
  return result.value
}

/**
 * The five tools for one Web Storage area, named as @playwright/mcp names them.
 *
 * @param {string} prefix localstorage or sessionstorage
 * @param {string} area localStorage or sessionStorage
 * @return {!Array<!Object>}
 */
function storageTools(prefix, area) {
  const KEY = { type: 'string', description: 'Item key' }
  return [
    {
      name: `browser_${prefix}_list`,
      description: `List all ${area} items of the current page`,
      inputSchema: { type: 'object', properties: {} },
      async run(ctx) {
        const items = await withStorage(ctx, area, 'return Object.entries(store)')
        if (!items.length) return textResult(`${area} is empty.`)
        return textResult(items.map(([k, v]) => `${k}=${v}`).join('\n'))
      },
    },
    {
      name: `browser_${prefix}_get`,
      description: `Get a ${area} item by key`,
      inputSchema: { type: 'object', properties: { key: KEY }, required: ['key'] },
      async run(ctx, { key }) {
        const value = await withStorage(ctx, area, 'return store.getItem(arguments[0])', key)
        return textResult(value === null ? `No ${area} item ${JSON.stringify(key)}.` : `${key}=${value}`)
      },
    },
    {
      name: `browser_${prefix}_set`,
      description: `Set a ${area} item`,
      inputSchema: {
        type: 'object',
        properties: { key: KEY, value: { type: 'string', description: 'Item value' } },
        required: ['key', 'value'],
      },
      async run(ctx, { key, value }) {
        await withStorage(ctx, area, 'store.setItem(arguments[0], arguments[1])', key, value)
        return textResult(`Set ${area} item ${key}`)
      },
    },
    {
      name: `browser_${prefix}_delete`,
      description: `Delete a ${area} item`,
      inputSchema: { type: 'object', properties: { key: KEY }, required: ['key'] },
      async run(ctx, { key }) {
        await withStorage(ctx, area, 'store.removeItem(arguments[0])', key)
        return textResult(`Deleted ${area} item ${key}`)
      },
    },
    {
      name: `browser_${prefix}_clear`,
      description: `Delete all ${area} items of the current page`,
      inputSchema: { type: 'object', properties: {} },
      async run(ctx) {
        await withStorage(ctx, area, 'store.clear()')
        return textResult(`Cleared ${area}`)
      },
    },
  ]
}

const tools = [
  ...cookieTools,
  ...storageTools('localstorage', 'localStorage'),
  ...storageTools('sessionstorage', 'sessionStorage'),
].map((tool) => ({ ...tool, cap: 'storage' }))

module.exports = { tools, domainMatches, formatCookie }
