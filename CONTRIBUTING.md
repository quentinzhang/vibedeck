# Contributing

Thanks for your interest in contributing to Rushdeck.

## Development setup

1. Fork and clone the repository.
2. Install dependencies:

```bash
npm install
```

3. Run local checks:

```bash
npm run test
npm run build
```

4. Run the dashboard locally when needed:

```bash
npm run dev
```

## Contribution workflow

- Keep PRs focused and small.
- Add or update tests for behavior changes.
- Keep CLI and README examples aligned.
- Avoid committing local workspace data (`projects/`, `STATUS.md`, `public/status.json`).

## Commit and PR guidelines

- Use clear commit messages.
- Describe the problem and solution in the PR.
- Include validation steps (commands run, screenshots if UI changes).
- Link related issues or cards when applicable.

## Areas that help most

- CLI ergonomics
- Dashboard usability
- Worker supervisor reliability (`roll` / `autopilot` compatibility)
- Documentation and examples
