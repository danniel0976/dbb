# CI/CD

DBB uses GitHub Actions for continuous integration and Vercel's Git integration for deployments. They report separate commit statuses and do not gate each other by default.

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
2. Wait for `build-and-test` and the Vercel Preview deployment to succeed.
3. Review the Preview deployment and merge the pull request.
4. Vercel creates a Production deployment from the configured production branch.
5. The push-triggered GitHub Actions run records the post-merge CI result.

Vercel's Git integration can deploy a `main` commit independently of the push-triggered CI result. Repository YAML alone cannot make that external production promotion wait for GitHub Actions.

## External settings

These controls live in GitHub or Vercel and must be configured there:

- Protect `main` and require pull requests.
- Require the unique `build-and-test` status check, preferably with the branch up to date before merge.
- Require the Vercel status/deployment for pull requests if Preview deployments are consistently enabled.
- Confirm that Vercel's Production Branch is `main` and that its GitHub deployment statuses are enabled.
- If production must wait for the post-merge GitHub Actions run, configure Vercel Deployment Checks or move deployment into an explicitly approved GitHub Actions release workflow. Either option is an external release-policy change and may require Vercel plan features or repository secrets.

Do not add Vercel tokens or deployment credentials to the repository. Store any future release-workflow credentials as scoped GitHub Actions secrets.
