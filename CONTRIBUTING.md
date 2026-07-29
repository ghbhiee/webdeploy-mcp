# Contributing

Thanks for helping improve WebDeploy MCP.

1. Open an issue for significant behavior or security-model changes.
2. Fork the repository and create a focused branch.
3. Use Node.js 24 and pnpm 11.10.0.
4. Run `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test`.
5. Add tests for behavior changes and update relevant documentation.
6. Open a pull request describing impact, validation, and operational migration needs.

Never commit credentials, Passkey data, cookies, server addresses, private keys, environment
values, database dumps, or real deployment logs. Use example domains and generated fixtures.

Changes to authentication, authorization, path handling, command execution, archive extraction,
Nginx activation, encryption, backup/restore, or installers should include a threat-oriented review.

By contributing, you agree that your contribution is licensed under Apache-2.0.
