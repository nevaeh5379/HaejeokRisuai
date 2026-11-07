# optimization
The optimization standard is to ensure normal operation on older Android phones with approximately 4GB of RAM or less. Careful attention must be paid to loading local backups and saving backups.

Memory should contain no unnecessary data if possible. Only essential data should be kept.

The following platforms must be considered:

- Tauri (Linux, macOS, Windows)
- Web version
- Node version
- Android

In particular, lazy loading must be prioritized. This is because lazy loading is a double-edged sword: it is a major cause of bugs, yet it is essential for optimization.

# Guidelines for JavaScript and TypeScript
Existing JavaScript files (such as those with .mjs or .cjs extensions) are targets for refactoring into TypeScript.
Please write code in TypeScript rather than JavaScript.