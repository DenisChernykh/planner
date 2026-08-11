# Migrator boundary

The migrator is the one-shot `prisma migrate deploy` command exposed as
`pnpm start:migrate`. The API process never imports or invokes it.
