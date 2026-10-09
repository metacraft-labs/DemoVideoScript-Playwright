# DemoVideoScript-Playwright

DemoVideoScript backend arm that runs scenarios on web and Electron applications through Playwright.

> **Status:** ☐ Planned — design stage; no implementation yet.

A thin TypeScript process that answers the
[DemoVideoScript](https://github.com/metacraft-labs/DemoVideoScript) backend protocol
(JSON lines over stdio) using [Playwright](https://playwright.dev/): it locates and reads
page objects through the DOM and sends real pointer and keyboard input. It contains no
matching, waiting or timing logic of its own — the DemoVideoScript runner does that. Also
carries the DOM binding of the DemoVideoScript conformance application.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
