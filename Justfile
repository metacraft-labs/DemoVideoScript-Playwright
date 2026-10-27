## Justfile - DemoVideoScript-Playwright.
##
## DemoVideoScript (the runner, the schema, the conformance application) is
## expected at ../DemoVideoScript, or at DVS_ROOT. Build outputs go under
## BUILD_DIR.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

alias t := test
alias fmt := format

build_dir := env_var_or_default("BUILD_DIR", "build")
dvs_root := env_var_or_default("DVS_ROOT", "../DemoVideoScript")
dvs := build_dir / "bin/dvs"
pack := dvs_root / "conformance/pack/notes-app.pack.yaml"
scenarios := dvs_root / "conformance/scenarios"
arm := "node " + justfile_directory() / "src/main.ts --binding " + justfile_directory() / "conformance/notes-binding.ts"

# node_modules from the dev shell's pinned inputs (nothing is downloaded here).
setup:
    @mkdir -p node_modules/@types
    ln -sfn "$DVS_PLAYWRIGHT_CORE" node_modules/playwright-core
    rm -rf node_modules/@types/node node_modules/undici-types
    mkdir -p node_modules/@types/node node_modules/undici-types
    tar -xzf "$DVS_TYPES_NODE" -C node_modules/@types/node --strip-components=1
    tar -xzf "$DVS_UNDICI_TYPES" -C node_modules/undici-types --strip-components=1

# The runner (`dvs`) and the conformance application's web build, from the
# pinned DemoVideoScript. The tests never build these themselves.
build: setup
    @mkdir -p {{build_dir}}/bin {{build_dir}}/web
    nim c --hints:off -d:release --path:{{dvs_root}}/src --nimcache:{{build_dir}}/nimcache/dvs -o:{{dvs}} {{dvs_root}}/src/dvs.nim
    nim js --hints:off -d:release --nimcache:{{build_dir}}/nimcache/web -o:{{build_dir}}/web/notes_web.js {{dvs_root}}/conformance/app/notes_web.nim
    cp {{dvs_root}}/conformance/app/web/index.html {{build_dir}}/web/index.html

test: build test-conformance test-protocol test-arm

# §12, through the runner: fast and realistic, and every planted defect.
test-conformance:
    DVS_NOTES_WEB={{build_dir}}/web {{dvs}} conformance --pack {{pack}} --backend "cmd:{{arm}}" \
      --defect stale-read="cmd:{{arm}} --defect stale-read" \
      --defect off-by-one="cmd:{{arm}} --defect off-by-one" \
      --defect early-sync="cmd:{{arm}} --defect early-sync" \
      --defect read-side-effect="cmd:{{arm}} --defect read-side-effect" \
      {{scenarios}}/*.yaml

# Every message the arm sends and receives, against the published schema.
test-protocol:
    DVS_NOTES_WEB={{build_dir}}/web python3 {{dvs_root}}/tests/protocol_conformance.py {{dvs}} {{pack}} "cmd:{{arm}}" {{scenarios}}/archive-from-keyboard.yaml {{scenarios}}/drag-to-reorder.yaml

test-arm:
    DVS_NOTES_WEB={{build_dir}}/web DVS_BIN={{dvs}} DVS_ROOT={{dvs_root}} node --test tests/*.test.ts

lint: lint-types lint-input-rule lint-neutrality lint-nix

# The types type-check, and src/protocol.ts is what the schema generates.
lint-types: setup
    tsc -p .
    node scripts/gen-protocol-types.ts {{dvs_root}}/schemas/v1/backend-protocol.schema.json --check

lint-input-rule:
    node scripts/check-input-rule.ts
    node scripts/check-input-rule.ts --self-test

lint-neutrality:
    bash {{dvs_root}}/tests/neutrality_scan.sh $(git ls-files | grep -vE '^(flake.lock)$' | sed "s|^|$PWD/|")

lint-nix:
    nixfmt --check flake.nix

# Regenerate src/protocol.ts from the pinned schema.
generate-types:
    node scripts/gen-protocol-types.ts {{dvs_root}}/schemas/v1/backend-protocol.schema.json

format:
    nixfmt flake.nix

clean:
    rm -rf {{build_dir}} node_modules
