# DemoVideoScript-Playwright

The [DemoVideoScript](https://github.com/metacraft-labs/DemoVideoScript) scenario arm for
web and Electron applications, through Playwright. It is a small TypeScript process that
answers DemoVideoScript's backend protocol (JSON lines on stdio): the runner sends it
`locate`, `read`, `send`, `await`, `record` and `hit`, and it answers through a real
browser. All matching, waiting and timing is the runner's; the arm only observes and
delivers input.

A project supplies a **binding**, a TypeScript module whose default export is a
`Binding` (`src/arm.ts`): its stages (which open the application), how its page objects
are read from the page, the conditions it can detect, and its binding resolver. A
project's existing page objects become its binding.

**Input is input.** The arm sends pointer and keyboard events through Playwright's mouse
and keyboard; it never injects scripts to change the application. `just lint` refuses
script injection on the send path. Stages may inject scripts (they run before the steps),
and reads may introspect the page but not change it — the runner reads twice and
compares.

Recordings are WebM videos (from when the application was opened) and a PNG still per
step. Message types (`src/protocol.ts`) are generated from DemoVideoScript's published
schema and checked against it.

```sh
dvs run scenario.yaml --pack my-app.pack.yaml \
  --backend "cmd:node src/main.ts --binding my-binding.ts"
```

`conformance/notes-binding.ts` binds DemoVideoScript's conformance application and is
the worked example.

## Developing

DemoVideoScript is expected at `../DemoVideoScript` (or `DVS_ROOT`). Node, TypeScript,
Playwright and its browsers come from the dev shell; nothing is installed with npm.

| Recipe | Does |
|---|---|
| `just build` | links Playwright and the type declarations into `node_modules`, and builds the runner and the conformance application's web build |
| `just test` | the conformance suite through the runner (fast and realistic, with every planted defect), the protocol check, and the arm suite |
| `just lint` | the type check, the generated types against the schema, the input rule, the neutrality scan, `nixfmt` |
| `python3 tests/mutation/run-dvs4-mutations.py` | every planted defect in the arm must turn the tests red |

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
