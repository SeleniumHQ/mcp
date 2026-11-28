# Selenium MCP server

`@selenium/mcp` is the official [Model Context Protocol](https://modelcontextprotocol.io) server from the Selenium
project. It lets a coding agent drive a real browser through Selenium: the agent reads the page as an accessibility
snapshot with element refs, and acts on those refs. It never has to write or guess a selector.

It is the Selenium bindings exposed as tools, not a test runner. Selenium Manager comes with the bindings, so there is
no driver to install.

> **Status: v1 in progress.** Chrome, Edge or Firefox, headless by default, over stdio, one browser per server. See
> [What it covers](#what-it-covers).

## Setup

You need Node.js `^22.23.4 || ^24.22.1 || >= 26.12.1` and Chrome, Edge or Firefox. Then add the server to your agent:

**Claude Code**

```sh
claude mcp add selenium -- npx @selenium/mcp@latest
```

**Codex**

```sh
codex mcp add selenium -- npx @selenium/mcp@latest
```

**Cursor**: add to `.cursor/mcp.json` (or `~/.cursor/mcp.json`):

```json
{ "mcpServers": { "selenium": { "command": "npx", "args": ["@selenium/mcp@latest"] } } }
```

**VS Code**: add to `.vscode/mcp.json`:

```json
{ "servers": { "selenium": { "command": "npx", "args": ["@selenium/mcp@latest"] } } }
```

Any other MCP client: run `npx @selenium/mcp@latest` as a stdio server.

## Options

| Flag                       | Meaning                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `--browser <name>`         | `chrome` (default), `edge` or `firefox`.                                |
| `--headless` / `--headed`  | Run headless (the default) or show the window.                          |
| `--grid <url\|name>`       | Run the browser on a Selenium Grid instead of locally: a URL, or a Grid saved in the config file. |
| `--config <path>`          | Config file of saved Grids (see [Selenium Grid](#selenium-grid)).      |
| `--allowed-origins <list>` | Semicolon-separated origins or hosts (`*.example.com`) the browser may navigate to. |
| `--blocked-origins <list>` | Semicolon-separated origins or hosts it may not navigate to.            |
| `--allow-unrestricted-file-access` | Let `browser_navigate` open `file://` URLs, and `browser_file_upload` send files from outside the working directory (both blocked by default). |
| `--allow-evaluate`         | Offer `browser_evaluate`, which runs JavaScript the agent writes in the page. |
| `--caps <list>`            | Comma-separated optional tool groups: `vision`, `pdf`, `storage`. See [Optional tools](#optional-tools). |
| `--log-level <level>`      | Log to stderr: `severe`, `warning` (default), `info`, `fine`, `all`. `all` includes raw WebDriver traffic, so typed text such as passwords. |

Flag names match `@playwright/mcp` wherever they mean the same thing.

## Tools

Tool names and arguments match `@playwright/mcp` wherever the operation is the same, so habits and skills files carry
over.

| Tool                       | What it does                                                         |
| -------------------------- | -------------------------------------------------------------------- |
| `browser_snapshot`         | The page as an accessibility tree with refs. `all: true` adds text and structure. |
| `browser_navigate`         | Go to a URL.                                                         |
| `browser_navigate_back`    | Go back.                                                             |
| `browser_click`            | Click a ref (optionally double or right click).                      |
| `browser_type`             | Replace the text in a ref, optionally pressing Enter.                |
| `browser_fill_form`        | Fill several textboxes, checkboxes, radios and selects at once.       |
| `browser_select_option`    | Choose options in a `<select>` by value or label.                    |
| `browser_press_key`        | Press a key or chord (`Enter`, `Control+a`).                         |
| `browser_hover`            | Move the mouse over a ref.                                           |
| `browser_drag`             | Drag one ref and drop it on another.                                 |
| `browser_file_upload`      | Choose files for a file input, or for the button that opens a hidden one. |
| `browser_wait_for`         | Wait for text to appear or go, or for some seconds.                  |
| `browser_handle_dialog`    | Accept or dismiss an alert, confirm or prompt.                       |
| `browser_take_screenshot`  | PNG of the viewport or of one ref.                                   |
| `browser_console_messages` | Console messages and uncaught errors, collected over WebDriver BiDi. |
| `browser_network_requests` | Requests since the page loaded, with status, over WebDriver BiDi.    |
| `browser_resize`           | Resize the browser window.                                           |
| `browser_tabs`             | List, open, select or close tabs.                                    |
| `browser_close`            | Close the browser; the next call starts a new one.                   |
| `browser_evaluate`         | Run a JavaScript function on the page or a ref. Only with `--allow-evaluate`. |

Every action returns the page's URL, title and a fresh snapshot, so the agent rarely needs to ask for one.

These read a Selenium Grid (see [Selenium Grid](#selenium-grid)):

| Tool                       | What it does                                                         |
| -------------------------- | -------------------------------------------------------------------- |
| `selenium_grid_use`        | Save a Grid by URL, or pick a saved one, as the default.             |
| `selenium_grid_status`     | Readiness, nodes and free slots per browser; one node in detail.     |
| `selenium_grid_sessions`   | Running sessions, longest first, with links to them in the Grid UI.  |
| `selenium_grid_queue`      | Waiting session requests, with a hint at why each waits.             |
| `selenium_grid_bug_report` | A summary to paste into an issue, without URLs or ids.               |

### Optional tools

Each group is listed only when `--caps` names it, since every agent pays for every listed tool on every turn. The
default list stays at 25 tools or fewer; these groups and `browser_evaluate` are opt-in, so they do not count toward
that cap.

| Group     | Tools                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------- |
| `vision`  | `browser_mouse_move_xy`, `browser_mouse_click_xy`, `browser_mouse_drag_xy`, `browser_mouse_down`, `browser_mouse_up`, `browser_mouse_wheel`: the mouse by viewport coordinates, as read from a screenshot. |
| `pdf`     | `browser_pdf_save`: save the page as a PDF. Without a file name it goes to a new file in the temp directory; a name must be inside the working directory unless `--allow-unrestricted-file-access` is given. |
| `storage` | `browser_cookie_*`, `browser_localstorage_*` and `browser_sessionstorage_*`, each with `list`, `get`, `set`, `delete` and `clear`, for the current page. |

### Snapshots and refs

```
[e1] heading "Login" [level=1]
[e2] textbox "Username"
[e3] textbox "Password"
[e4] button "Login"
[e5] iframe "Help"
  [f5e1] link "Forgot password?"
```

- Roles, names and states come from the bindings' `getAccessibilitySnapshot()`, which computes them in the page
  following WAI-ARIA, html-aam and accname, in a sandbox that page scripts cannot reach. Open shadow roots are included.
- By default a snapshot lists interactive elements, headings, live regions (`alert`, `status`) and frames.
  `browser_snapshot` with `all: true` adds the rest of the visible content.
- A ref stays the same for the same element across snapshots; `browser_navigate` starts over.
- Content inside an iframe gets refs prefixed with the frame's own ref (`f5e1`), and tools act on them directly.
- Password values are never shown.

## Selenium Grid

The server can run its browser on a [Selenium Grid](https://www.selenium.dev/documentation/grid/) and tell an agent
what a Grid is doing. When the person names a Grid, the agent calls `selenium_grid_use`, which checks the Grid answers
and saves it as the default, so nobody is asked again. Browsers then start on that Grid, and the `selenium_grid_*`
tools read it. `--grid` on the command line still decides where browsers start for that run.

Saved Grids live in the first of these that applies, and are saved back to it:

1. `--config <path>`
2. the `SELENIUM_MCP_CONFIG` environment variable
3. `.selenium-mcp.json` in the working directory, if it exists
4. `~/.config/selenium-mcp/config.json` (or under `$XDG_CONFIG_HOME`)

```json
{
  "defaultGrid": "staging",
  "grids": {
    "local": { "url": "http://localhost:4444" },
    "staging": { "url": "https://grid.staging.example.com" }
  }
}
```

The Grid tools only read. Ending sessions, draining or removing nodes and clearing the queue are left to the person,
on their Grid; `selenium_grid_sessions` gives each session's link in the Grid UI. The server assumes a Grid is
protected by its own network or auth: it saves no credentials, and refuses a URL with a user name or password in it
(one given to `--grid` is used for that run only). Browsers it starts on a Grid are named `selenium-mcp` (`se:name`),
so people can tell them apart in the Grid UI.

## What it covers

Chrome, Edge and Firefox, headless, stdio, and the tools above; every tool is tested against all three browsers. Not
yet: request interception (`--caps network`), HTTP transport, more than one session, and `selenium_doctor`. Those come
in later releases.

## Security

- No tool runs JavaScript the agent writes unless the server is started with `--allow-evaluate`.
- `browser_file_upload` sends only files inside the server's working directory unless started with
  `--allow-unrestricted-file-access`, since an upload hands the file to whatever page is open.
- `browser_navigate` opens only http(s), `about:blank` and `data:` URLs; `file://` needs
  `--allow-unrestricted-file-access`, and `data:` is refused when `--allowed-origins` is set.
- `--allowed-origins` and `--blocked-origins` restrict where `browser_navigate` can go. They do not stop links,
  redirects or scripts on a page from going elsewhere, so they are not a browser-wide security boundary.
- Snapshots, screenshots, console messages and request URLs and statuses are the only page data returned by default.
  `--caps storage` also returns cookie and Web Storage values, which can include session tokens.

## Development

The server depends on `getAccessibilitySnapshot()`, which first ships in `selenium-webdriver` 4.53.0. Until that is on
npm, the dependency points at the nightly build in GitHub Packages, so installing needs a GitHub token with
`read:packages`:

```sh
NODE_AUTH_TOKEN=<token> npm install
npm run test:unit   # unit tests, no browser
npm run test:e2e    # every tool against real Chrome
SELENIUM_BROWSER=firefox npm run test:e2e   # or edge
npm run lint        # eslint and prettier
```

See [AGENTS.md](AGENTS.md) for conventions and [CONTRIBUTING.md](CONTRIBUTING.md) for how to send a change.

## Credits

The community Python Selenium MCP server is the reference this design grew from, and its command coverage is the
checklist for v1.
