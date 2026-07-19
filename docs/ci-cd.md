# CI/CD

DBB uses GitHub Actions for continuous integration and Vercel's Git integration for deployments. GitHub protects merges, while a Vercel Deployment Check gates production-domain assignment on the post-merge CI result.

## GitHub Actions

`.github/workflows/ci.yml` runs for pull requests targeting `main`, pushes to `main`, and manual dispatches. The `build-and-test` job:

1. installs the locked dependencies with Node.js 22 and `npm ci`;
2. runs every `nextjs/scripts/phase*-test-*.mjs` regression script, failing if none are found;
3. runs the production Next.js build.

Superseded runs for the same pull request are cancelled. Push runs are not cancelled so every commit that reaches `main` retains a CI result.

Equivalent local checks from `nextjs/` are:

```bash
for test_file in scripts/phase*-test-*.mjs; do node "$test_file" || exit 1; done
npm run build
```

`perf-baseline.mjs` is intentionally excluded from CI. Its historical `--readonly` argument is not implemented, and the script includes isolated writes to the dedicated performance-test account. Run it only as an intentional manual benchmark until the script has a true read-only mode.

## Pull requests and production

The intended release path is:

1. Open a pull request targeting `main`.
2. Wait for the required `build-and-test` and `Vercel` pull-request checks to succeed.
3. Review the Preview deployment and merge the pull request.
4. Vercel builds a production-target deployment from `main` while the push-triggered `build-and-test` job runs.
5. The Vercel project check `DBB production: GitHub CI` reads that GitHub result and assigns the custom production domain only after it passes.

Pull-request previews are unaffected by the production-only gate. If post-merge CI fails, the new deployment remains staged without replacing the deployment on the production domain.

## External release controls

These controls live outside the repository and are currently enabled:

- GitHub protects `main` with required pull requests and the `build-and-test` and `Vercel` checks. Administrator bypass remains available for emergencies.
- Vercel's Production Branch is `main`.
- The production-only project check `DBB production: GitHub CI` reads the post-merge GitHub `build-and-test` result. Its backend action blocks `deployment-alias`, meaning it holds custom production-domain assignment, with a 900-second timeout.
- Vercel's **Force Promote** action is the emergency bypass for the deployment gate.

For rollback while a failed deployment is staged, keep the gate installed. First pin or restore a known-good deployment and verify the production domain, then delete the gate only if removal is deliberately required. Vercel's **Instant Rollback** disables automatic production-domain assignment; a deliberate clean promotion must restore it afterward.

Do not add Vercel tokens or deployment credentials to the repository. Store any future release-workflow credentials as scoped GitHub Actions secrets.
