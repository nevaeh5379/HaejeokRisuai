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


# Plugin API Compatibility

This project exclusively supports the Plugin V3 API. Older API versions (v2.0, v2.1, etc.) are not supported; please do not take them into account.

The objects used within this project are generally unsuitable for direct exposure via the Plugin V3 API. Therefore, you must provide "legacy objects" that remain compatible with the original resources. Dedicated utility functions should be implemented to handle the conversion into these legacy objects. The `Store` class must remain agnostic regarding legacy-related components (adhering to the principle of separation of responsibilities).

# Testing

Do not include test code that performs hash verification.

Do not use a mock database for testing. Tests must be conducted using a connection to an actual database—no exceptions.

# File Structure

The current directory structure is entirely flat; this is unintentional and does not align with the project's design goals. Please organize files into an appropriate hierarchical structure to improve readability.

# Comments

Comments should generally follow this format:

Functionality/Description
TODO
Example usage

As a general rule, do not include comments explaining the rationale behind a change or addition.