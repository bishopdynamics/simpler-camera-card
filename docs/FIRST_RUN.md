# First Run

This project was just created from `project-template-a` and has not been initialized.
Work through this process with the user, top to bottom. When everything is done, **delete this file** and commit — the absence of this file is what marks the project as initialized.

## 1. Identity

- [ ] Ask the user for the project's name and a one-line description; fill both into the top of `CLAUDE.md`.
- [ ] Write a `README.md` for the project (name, description, how to build/run once known).

## 2. Foundational decisions

Discuss with the user and record the outcomes (they will flow into `ROOT_SPEC.md` later, but capture them now in `docs/handoff/evergreen.md`):

- [ ] **Kind of project** — CLI tool, service, web app, library, firmware, etc.
- [ ] **Language & toolchain** — one of the first decisions the user must make. The template is deliberately language-agnostic.
- [ ] **Repository structure** — define the folder layout appropriate for this kind of project.

## 3. Adjust the template to fit

The process documents are generic; tune them for this kind of project:

- [ ] Extend `.gitignore` with entries for the chosen language/toolchain (the template only covers OS junk, Python, Node, and editors).
- [ ] Adjust `CLAUDE.md` and the docs under `docs/` where this project's kind demands different process (call out anything you change to the user).
- [ ] Set up build/test scaffolding for the chosen toolchain, if the user wants it now.

## 4. Repository

- [ ] The user creates the repository on the GitLab server and adds it as `origin` (agent may help via dev-tools if asked).
- [ ] Verify `git push -u origin main` works.

## 5. Kick off

- [ ] Have the user write (or dictate) `docs/idea/initial-idea.md`.
- [ ] Delete this file, commit, and proceed to `docs/TASK_QUEUE.md` — its first task is Initial Planning.
