# Security policy

Perspectica is a proof of concept. Do not use it to process credentials, personal data, or
other material you cannot safely send to a local research tool.

## Reporting a vulnerability

Please do not publish suspected vulnerabilities, session material, credentials, or reproducible
exploit details in a public issue. Use GitHub private vulnerability reporting when it is enabled
for the repository; otherwise contact the repository owner through their GitHub profile.

Include affected version, setup details, reproduction steps, expected impact, and any mitigation
you have identified. Reports are handled on a best-effort basis for this project.

## Deployment expectations

The API must run behind HTTPS in a deployed environment, with a strong
`PERSPECTICA_SESSION_SECRET`, persistent private storage, and an exact
`PERSPECTICA_EXTENSION_ORIGIN`. Do not expose an API configured for one extension origin to
arbitrary extension builds.

The ChatGPT device flow is provided by a community proof-of-concept package. It is not OpenAI's
public Sign in with ChatGPT identity product and should not be presented as one.
