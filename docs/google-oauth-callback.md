# Google BYO OAuth callback

Momoan Sync uses only your own Google OAuth client and the drive.file scope.
Enable the Google Drive API and Google Picker API for that client project. For a
Web application OAuth client, register this exact authorized redirect URI:

https://momoan01.github.io/momoan-sync/oauth-callback/

Enter the public Client ID in Momoan Sync settings and select the Client secret
from Obsidian SecretStorage. Leave Redirect URI blank to use the address above,
or explicitly enter the same registered address. Each device authorizes separately.
Authorization and direct token exchange use the same resolved redirect URI.

Google returns code, state, and, for the top-level folder Picker, picked_file_ids.
The Momoan static page forwards only code, state, picked_file_ids, scope, and error
to obsidian://momoan-sync-auth. Unknown fields (including tokens) are dropped.
The page has no external script, network client, storage, analytics, or secret
display. It clears the query from browser history and offers an Open Obsidian link
if automatic navigation is blocked.

The plugin validates pending state and exchanges the code directly with Google
using its SecretStorage PKCE S256 verifier and client secret. The static page
never exchanges codes or receives the verifier/client secret. Tokens stay in the
device SecretStorage. The selected ID is checked against the Drive folder MIME type
with the resulting access token before binding the folder.

## Deployment

The Momoan OAuth callback Pages workflow deploys only site/ through GitHub Pages.
Repository Settings > Pages must select GitHub Actions as the source. No central
server, token relay, or additional backend is required.

## Verification

Unit tests cover relay allowlisting/encoding, CSP, BYO credentials, redirect
consistency, Picker flags, and pending proof cleanup. The credential-free Picker
oracle runs with npm run test:e2e:google-picker:oracle.

For the opt-in interactive probe, configure AIRSYNC_E2E_GOOGLE_CLIENT_ID and
AIRSYNC_E2E_GOOGLE_CLIENT_SECRET for the Web client registered above, plus the
Chrome/profile variables documented in e2e-testing.md. Run
npm run test:e2e:google-picker. It observes the HTTPS-to-Momoan protocol navigation,
exchanges the observed code directly with its original PKCE verifier, and validates
the chosen folder through Drive. Passing unit/oracle gates does not prove a live
interactive Google flow; report that separately.
