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

const { Button, Origin } = require('selenium-webdriver')

const { ToolError, actionResult } = require('./common')

const BUTTONS = { left: Button.LEFT, middle: Button.MIDDLE, right: Button.RIGHT }
const BUTTON = { type: 'string', enum: Object.keys(BUTTONS), description: 'Mouse button, defaults to left' }
const X = { type: 'number', description: 'X coordinate in CSS pixels from the left of the viewport' }
const Y = { type: 'number', description: 'Y coordinate in CSS pixels from the top of the viewport' }

/**
 * @param {number} value
 * @param {string} name
 * @return {number} the value as a whole pixel
 * @throws {ToolError} for a negative coordinate
 */
function pixel(value, name) {
  if (!(value >= 0)) throw new ToolError(`${name} must be 0 or more.`)
  return Math.round(value)
}

/**
 * Coordinates are the top document's, as a screenshot shows them, so actions
 * start from the top document whichever frame the last tool acted in.
 */
async function topDocument(ctx) {
  const driver = await ctx.session.driver()
  await driver.switchTo().defaultContent()
  return driver
}

const tools = [
  {
    name: 'browser_mouse_move_xy',
    cap: 'vision',
    description: 'Move the mouse to a position in the viewport',
    inputSchema: { type: 'object', properties: { x: X, y: Y }, required: ['x', 'y'] },
    async run(ctx, { x, y }) {
      const driver = await topDocument(ctx)
      const point = { x: pixel(x, 'x'), y: pixel(y, 'y') }
      await driver
        .actions()
        .move({ ...point, origin: Origin.VIEWPORT })
        .perform()
      ctx.session.pointer = point
      return actionResult(ctx, `Moved the mouse to ${point.x},${point.y}`)
    },
  },
  {
    name: 'browser_mouse_click_xy',
    cap: 'vision',
    description: 'Click at a position in the viewport',
    inputSchema: {
      type: 'object',
      properties: {
        x: X,
        y: Y,
        button: BUTTON,
        clickCount: { type: 'number', description: 'Number of clicks, defaults to 1' },
        delay: { type: 'number', description: 'Milliseconds between press and release, defaults to 0' },
      },
      required: ['x', 'y'],
    },
    async run(ctx, { x, y, button = 'left', clickCount = 1, delay = 0 }) {
      if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3) {
        throw new ToolError('clickCount must be 1, 2 or 3.')
      }
      const driver = await topDocument(ctx)
      const point = { x: pixel(x, 'x'), y: pixel(y, 'y') }
      let actions = driver.actions().move({ ...point, origin: Origin.VIEWPORT })
      for (let i = 0; i < clickCount; i++) {
        actions = actions.press(BUTTONS[button])
        if (delay > 0) actions = actions.pause(Math.round(delay))
        actions = actions.release(BUTTONS[button])
      }
      await actions.perform()
      ctx.session.pointer = point
      return actionResult(
        ctx,
        `Clicked ${button} at ${point.x},${point.y}${clickCount > 1 ? ` ${clickCount} times` : ''}`,
      )
    },
  },
  {
    name: 'browser_mouse_drag_xy',
    cap: 'vision',
    description: 'Drag with the left mouse button from one position in the viewport to another',
    inputSchema: {
      type: 'object',
      properties: { startX: X, startY: Y, endX: X, endY: Y },
      required: ['startX', 'startY', 'endX', 'endY'],
    },
    async run(ctx, { startX, startY, endX, endY }) {
      const driver = await topDocument(ctx)
      const start = { x: pixel(startX, 'startX'), y: pixel(startY, 'startY') }
      const end = { x: pixel(endX, 'endX'), y: pixel(endY, 'endY') }
      await driver
        .actions()
        .move({ ...start, origin: Origin.VIEWPORT })
        .press(Button.LEFT)
        .move({ ...end, origin: Origin.VIEWPORT })
        .release(Button.LEFT)
        .perform()
      ctx.session.pointer = end
      return actionResult(ctx, `Dragged from ${start.x},${start.y} to ${end.x},${end.y}`)
    },
  },
  {
    name: 'browser_mouse_down',
    cap: 'vision',
    description: 'Press a mouse button where the mouse is',
    inputSchema: { type: 'object', properties: { button: BUTTON } },
    async run(ctx, { button = 'left' }) {
      const driver = await topDocument(ctx)
      await driver.actions().press(BUTTONS[button]).perform()
      return actionResult(ctx, `Pressed ${button} mouse button`)
    },
  },
  {
    name: 'browser_mouse_up',
    cap: 'vision',
    description: 'Release a mouse button where the mouse is',
    inputSchema: { type: 'object', properties: { button: BUTTON } },
    async run(ctx, { button = 'left' }) {
      const driver = await topDocument(ctx)
      await driver.actions().release(BUTTONS[button]).perform()
      return actionResult(ctx, `Released ${button} mouse button`)
    },
  },
  {
    name: 'browser_mouse_wheel',
    cap: 'vision',
    description: 'Scroll the mouse wheel where the mouse is',
    inputSchema: {
      type: 'object',
      properties: {
        deltaX: { type: 'number', description: 'Pixels to scroll right; negative scrolls left' },
        deltaY: { type: 'number', description: 'Pixels to scroll down; negative scrolls up' },
      },
      required: ['deltaX', 'deltaY'],
    },
    async run(ctx, { deltaX, deltaY }) {
      const driver = await topDocument(ctx)
      const { x, y } = ctx.session.pointer || { x: 0, y: 0 }
      await driver.actions().scroll(x, y, Math.round(deltaX), Math.round(deltaY), Origin.VIEWPORT).perform()
      return actionResult(ctx, `Scrolled by ${Math.round(deltaX)},${Math.round(deltaY)}`)
    },
  },
]

module.exports = { tools }
