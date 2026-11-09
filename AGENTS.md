<!-- Guidance for AI agents working on the Selenium MCP server -->

## Code location

- Server: `lib/`
  - `server.js`: MCP server and tool registration
  - `session.js`: browser lifecycle, options, Grid URL, console capture over BiDi
  - `snapshot.js`: the in-page accessibility walk and the ref table
  - `tools/`: one file per tool group (`navigate`, `interact`, `inspect`, `bidi`)
- CLI: `bin/selenium-mcp.js`, flags parsed in `lib/cli.js`
- Tests: `test/unit/` (no browser) and `test/e2e/` (real browser, in-memory MCP client). `test/fixtures/common/`
  holds copies of pages from the Selenium bindings' shared test pages.

## Common commands

- Install: `NODE_AUTH_TOKEN=<token with read:packages> npm install` (see `.npmrc`)
- Unit tests: `npm run test:unit`
- Browser tests: `npm run test:e2e` (needs Chrome)
- Lint: `npm run lint`; fix formatting with `npm run format`

## Rules for tools

- Match `@playwright/mcp` names, arguments and semantics wherever the operation is the same. `selenium_*` is only for
  what Selenium alone can offer.
- The tool list is sent to the agent on every turn. Keep descriptions short; `test/unit/tools_test.js` enforces the
  token budget and the exact tool set.
- Tools take refs, never selectors. Errors meant for the agent are `ToolError`s with a next step in the message
  ("Call browser_snapshot to get fresh refs").
- Actions return `actionResult(...)` so the agent gets a fresh snapshot without another call.
- Never write to stdout outside the MCP transport; logs go to stderr.

## Code conventions

Follow selenium-webdriver's
[AGENTS.md](https://github.com/SeleniumHQ/selenium/blob/trunk/javascript/selenium-webdriver/AGENTS.md) for logging (`selenium-webdriver/lib/logging`, logger names under
`selenium.mcp.`), deprecation and JSDoc.

`collectNodes` in `lib/snapshot.js` runs inside the page and is serialized with `Function#toString`: it must not use
anything from its module scope.
