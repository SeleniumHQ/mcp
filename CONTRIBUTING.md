# Contributing

Selenium MCP is part of the Selenium project, so the
[Selenium contribution guide](https://github.com/SeleniumHQ/selenium/blob/trunk/CONTRIBUTING.md) applies here too,
including its code of conduct and its rules for AI-assisted contributions. What differs is the build: this repository
is a plain npm package, with no Bazel.

## Sending a change

1. Fork the repository and branch from `trunk`.
2. Install and check your change:

   ```sh
   NODE_AUTH_TOKEN=<GitHub token with read:packages> npm install
   npm run lint
   npm run test:unit
   npm run test:e2e
   ```

3. Commit. Keep the subject to 50 characters or fewer, leave the second line blank, and wrap the body at 72 columns.
   Say why the change is needed, and add `Fixes #N` when it fixes an issue. Do not add `Co-Authored-By` or other
   trailers for AI tools; say how AI helped in the pull request description instead.
4. Rebase on `trunk` and open a pull request.

Pull requests are squashed when they merge, so each one should do one thing.
