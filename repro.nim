## repro.nim — DemoVideoScript-Playwright for reprobuild.
##
## The desktop arm for DemoVideoScript scenarios: TypeScript run by node, which
## a product stages beside its own binding (its `src/` is copied, not
## compiled). It speaks the runner's backend protocol, generated from
## DemoVideoScript's schemas, so it names DemoVideoScript here; a consumer's
## lock then pins the arm and the runner it was checked against. The
## repository's own tests run through its Justfile.
import repro_project_dsl

package demo_video_script_playwright:
  defaultToolProvisioning "path"
  uses:
    "DemoVideoScript"
  build:
    # Nothing is built here: the library is consumed as source, and the
    # repository's tests run through its Justfile. A package with no
    # `build:` block is not solved, so the lock would record nothing.
    discard
