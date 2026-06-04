# loaf-cli — domain glossary

A shared vocabulary for the loaf feature-lifecycle protocol kernel. Terms only —
no implementation details. Resolved during design grilling; extend as language
sharpens.

## Configuration scope

- **Project config** — configuration that describes the whole repository and is
  shared by every feature: which files are protected from writes, which modules
  are stable-core, the path layout, the build/test commands, the SDD policy
  defaults, the locale. It is **per-project, never per-feature**. Lives at the
  project root, not inside any feature's state.

- **Feature journal** — the per-feature, append-only record of everything that
  happened to one feature. This is where per-feature state lives. A feature's
  journal is distinct from, and runs *under*, the project config.

- **Kernel-owned config / skill-owned config** — the project config spans two
  reader layers. The **kernel-owned** sections (write protection, stable-core
  boundary, path classification, locale) are read and enforced by loaf-cli.
  The **skill-owned** sections (project commands, SDD constitution) are read by
  the sibling loaf-skill layer to tune its workflow; loaf-cli serializes their
  defaults but never interprets them.

## User config vs project config

- **User config** — per-user, per-machine presentation preference (currently:
  language). Lives in the user's home, not in any repository. Distinct from
  **project config**, which is per-repository and committed with the project.
