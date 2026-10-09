# DemoVideoScript-Playwright — agent guide

## Branches

- `dev` is the mainline. It changes only through pull requests.
- `agents` is the landing branch for agent and feature work. Push completed work there;
  it reaches `dev` through a periodic stabilisation branch, not through a pull request per
  change.
- `main` and `master` must not exist.

## This repository is public

- Never reference, link to or cite a private repository — not in files, commit subjects,
  commit bodies, issues or pull requests. Design documents and plans are kept outside this
  repository.
- Commit messages are user-facing and describe outcomes.

## Neutrality

This repository is project-neutral. It must not contain any one application's page
objects, selectors, scenarios or vocabulary; those belong to the application's own
repository.
