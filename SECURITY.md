# Security

KakeiMatch handles personal financial information and receipt images. Security and privacy take priority over convenience when the two conflict.

## Data model requirement

MVPでは各ユーザーは自分の家計簿だけを閲覧・操作できます。

Every endpoint that reads or writes user data must enforce authorization on the server side.

Protected data includes:

- transactions
- receipts and receipt images
- imported statements
- reconciliation results
- category history
- user correction history
- mappings to Actual Budget

## Secrets

Never commit:

- API keys
- passwords
- production environment files
- Actual Budget credentials
- authentication secrets
- real card statements
- real receipt images

Use environment variables or an appropriate secret store.

## Uploaded files

Receipt images and imported statement files are untrusted input.

At minimum:

- validate file size
- validate supported content type/format
- generate server-side filenames
- prevent path traversal
- store outside public static directories
- require authorization when serving files
- avoid logging raw financial data

## External AI

Receipt data sent to Gemini leaves the self-hosted environment.

Only send data required for the requested processing. Do not send authentication data, unrelated transaction history, or other users' information.

## Test data

Use synthetic or thoroughly anonymized fixtures. Do not commit family financial records for tests.

## Deployment

Before exposing the service outside the home network:

- enable HTTPS
- require authentication
- use strong secrets
- ensure receipt files are not publicly addressable
- restrict Actual Budget administrative access
- establish backups
- verify restoration procedures
- review logs for accidental personal-data leakage

## Reporting

This is currently a personal project. Security issues should be reported privately to the repository owner rather than posted with sensitive reproduction data in a public issue.
