# Threat model

## Assets

- ChatGPT refresh tokens and Exa API keys.
- Article text, URLs, research questions, source notes, and local report history.
- The integrity of the packaged extension and release artifacts.

## Trust boundaries

1. The side panel is an untrusted presentation client and can request only validated operations.
2. The background service worker owns host access, authentication, storage, and run tokens.
3. The offscreen runtime performs provider calls and emits sanitized events.
4. The active page is untrusted input; article text and page instructions are never treated as
   executable policy.
5. OpenAI/ChatGPT and Exa are external processors selected by the reader.

## Main threats and controls

| Threat                                          | Control                                                                                                    | Residual risk                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A page injects instructions into analysis       | Bounded extraction, schema validation, prompt boundaries, exact URL/excerpt checks                         | A provider can still return incorrect or unsafe analysis; readers must verify sources. |
| Token leakage through UI, logs, or page scripts | Background-owned vault, session-only access tokens, redacted messages and telemetry                        | An unlocked or compromised browser profile can inspect live extension state.           |
| Overbroad page access                           | `<all_urls>` is optional and requested only after explanation and a user gesture; extraction is on demand  | A reader may grant access to a sensitive active page.                                  |
| Release tampering or ZIP path traversal         | Named SHA-256 manifest, provenance attestations, size/path/symlink checks, recoverable staging             | Checksums share GitHub-release trust; helper code signing is pending.                  |
| ChatGPT/session policy or provider changes      | Experimental-provider notice, explicit capability checks, provenance-preserving Free/article-only fallback | A provider can revoke access or change terms between releases.                         |
| Cross-site tracking                             | No analytics service, persistent content script, ads, or Perspectica backend                               | Provider requests are visible to those providers under their policies.                 |

## Out of scope

Hardware-backed secret storage, malware on the host, compromised browser profiles, provider-side
breaches, and whether a political claim is substantively true are not solved by the extension.
Report a suspected vulnerability privately as described in [`SECURITY.md`](../SECURITY.md).
