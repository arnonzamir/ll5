---
name: vault-login
description: Log into a portal through the vault MCP (list_login_sites, browser_login, login_status) without ever seeing a password, handle approval_required, and drive vault onboarding (vault_status, provision_vault, confirm_vault_membership). Invoke whenever a portal session is expired or a site needs a login. CLAUDE.md keeps the standing rules; this skill is the procedure.
---

# Vault logins (browser)

When a portal session is expired or a site needs a login, use the **vault MCP** —
you never see or handle a password:

1. `list_login_sites` → the site names you're allowed to use (names + domains only).
2. `browser_login({site})` → the credential is filled **server-side** in your shared
   browser session. On `success`, your normal browser tools are already inside the
   authenticated session; `login_status({site})` checks a session without logging in.
3. `approval_required` → the site isn't on the user's approved list yet. An approval
   push was already sent — **tell the user and wait**. Never retry in a loop, never
   work around it (no manual navigation to the login page to "help").

Once inside, fetch same-origin files through the authenticated browser, not curl —
the document flow is in the `media` skill.

## Vault onboarding is yours to drive

If vault tools report "not provisioned" and the user wants vault-backed logins, walk
them through it in chat (`vault_status` tells you which step is next):

1. `provision_vault({user_email})` with their email — their private vault org is
   created and the vault server emails them an invite.
2. Tell them: open the invite email, create a vault **master password** (theirs
   alone — you never learn it), and accept the invite. Then run
   `confirm_vault_membership` — if it says `invited`, they haven't accepted yet;
   ask and retry later, don't poll in a loop.
3. Once confirmed, guide them to add login items to their org's **agent**
   collection (web vault / Bitwarden app). The item's **URL matters**: a
   credential only ever fills on that exact domain.
4. First login to each site returns `approval_required` → the approval push goes
   out, the user approves, and `browser_login` works from then on.

## Hard rules

- **Never ask the user for a password in chat** — not their master password, not
  any site password, at any step of onboarding or login. Passwords go into the
  vault (web vault / Bitwarden app), never through the conversation. If a site
  isn't in the vault, ask the user to add it there.
- A credential only ever fills on its own domain — if `browser_login` fails with a
  domain mismatch, that's the protection working; report it, don't fight it.
- **Payments and bank transactions stay human** — logins for reading/checking are
  fine where approved; moving money is never yours.
