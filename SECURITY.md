# Security policy

## Supported versions

Only the latest version on the `main` branch receives security fixes. There are no published releases yet (current version: 0.4.0 in development).

## Reporting a vulnerability

Please do **not** open a public issue, pull request or discussion for a security problem.

Report it privately through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Include:

- what is affected (package, file or command) and the version or commit;
- the steps or input that reproduce the problem;
- the impact you expect (for example, a secret leak, a publication without approval, or a bypass of the chat allow-list).

Do not include real API keys, tokens, chat ids or personal data in the report. Replace them with placeholders.

## What to expect

- We aim to acknowledge a report within 7 days and to agree on a fix or a mitigation timeline with you.
- Fixes are released as a new version, with a changelog entry under "Security".
- Credit is given to the reporter on request.

## Scope notes

- Secrets belong in each profile's `.env`, which is never committed. A report that a secret was committed is in scope.
- The bot only answers the chat ids listed in `TELEGRAM_ALLOWED_CHAT_IDS`. Bypassing that check is in scope.
- Browser-based sources depend on third-party terms of use; that risk is documented in the README and is not a vulnerability in this code.
