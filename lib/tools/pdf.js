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

const { error } = require('selenium-webdriver')

const { ToolError, textResult } = require('./common')

/**
 * Where to write a PDF: a name the agent gave, resolved against the working
 * directory and kept inside it unless file access is unrestricted, or a fresh
 * file in the temp directory so nothing lands in the project unasked.
 *
 * @param {(string|undefined)} filename
 * @param {{allowFileAccess: (boolean|undefined)}} config
 * @param {string=} root
 * @return {string} an absolute path
 * @throws {ToolError}
 */
function pdfPath(filename, config, root = process.cwd()) {
  if (!filename) {
    const dir = path.join(os.tmpdir(), 'selenium-mcp')
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, `page-${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`)
  }
  const target = path.resolve(root, filename)
  // The directory must exist to be checked, and realpath sees through symlinks.
  let dir
  try {
    dir = fs.realpathSync(path.dirname(target))
  } catch {
    throw new ToolError(`No such directory: ${path.dirname(target)}`)
  }
  const realRoot = fs.realpathSync(root)
  const inside = dir === realRoot || dir.startsWith(realRoot + path.sep)
  if (!inside && !config.allowFileAccess) {
    throw new ToolError(
      `${target} is outside the working directory (${realRoot}). ` +
        'Start the server with --allow-unrestricted-file-access to write files anywhere.',
    )
  }
  return path.join(dir, path.basename(target))
}

const tools = [
  {
    name: 'browser_pdf_save',
    cap: 'pdf',
    description: 'Save the page as a PDF file',
    inputSchema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description:
            'File to save to, relative to the working directory. Defaults to a new file in the temp directory',
        },
      },
    },
    async run(ctx, { filename }) {
      const file = pdfPath(filename, ctx.config)
      const driver = await ctx.session.driver()
      await driver.switchTo().defaultContent()
      let data
      try {
        data = await driver.printPage()
      } catch (e) {
        if (e instanceof error.UnsupportedOperationError || e instanceof error.UnknownCommandError) {
          throw new ToolError(`${ctx.config.browser} cannot print this page to PDF here: ${e.message.split('\n')[0]}`)
        }
        throw e
      }
      fs.writeFileSync(file, Buffer.from(data, 'base64'))
      return textResult(`Saved the page as ${file}`)
    },
  },
]

module.exports = { tools, pdfPath }
