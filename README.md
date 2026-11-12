# Device Replacement Automation

Zoom Contact Center call logs for Replacement device follow-up in Slack. This repository is the source for this feature. It does not deploy or modify the separate LWBR reporting service.

**Status: prepared and tested locally; not deployed or enabled.** Existing tracking and Pylon outreach remain in service. No live Zoom call lookup has succeeded for this feature yet.

## Behavior

- Process Replacement rows 1000 onward in the configured inventory tab.
- Read the assigned support engineer from column S without changing S.
- Keep the existing column-N tracking, column-Q status updates, and Pylon outreach.
- Add Accept to a delivered shipment's Slack message. Confirm acceptance with customer details in the same thread; suppress unaccepted reminders after acceptance.
- Look up historical Zoom voice engagements using the customer's exact normalized phone number. Hold ambiguous matches when multiple open cases share that phone number.
- Include agent, start/end time, direction, talk duration, engagement ID and result. A completed call with positive talk duration and an identified agent is treated as connected. Do not equate an unanswered attempt with reaching the customer.
- Post connected-call metadata to the case thread and include matching calls in daily reports. Provider failures are reported as unavailable, not as no calls.
- Send the same full EOD report to both configured managers: accepted cases, missed/unaccepted cases and associated call logs.
- Intended schedule: delivery reminders at 8 AM America/Chicago; EOD reports at 11 PM America/Chicago. The user requested EOD; 11 PM is a stated assumption awaiting live activation.
- Run in Cloudflare and Google Apps Script, independent of the user's computer. The supplied screenshot is a design reference only.

## Components

`src/worker.mjs` authenticates to Zoom using encrypted Worker secrets. `src/zoom-calls.mjs` provides `POST /replacement-delivery/calls`, authenticated against the configured Slack bot identity. It returns metadata only. There are no recording, transcript, or R2 operations.

`apps-script/ReplacementDeliveryActions.gs` is a staged module for the existing Win-Onb Apps Script. It relies on the existing `rpConfig_` and `rpVerifiedPayload_` helpers and is disabled by default. Do not replace the existing onboarding handler or Pylon routines. Add a call to `rdRoute_(e)` at the start of the existing `doPost`, returning its result only if it is non-null, and preserve all existing routes.

## Secure configuration

Do not commit credentials, customer records, real call logs, operational user mappings, or local private configuration to this public repository.

Configure these as encrypted Cloudflare Worker secrets:

- `ZOOM_ACCOUNT_ID`
- `ZOOM_CLIENT_ID`
- `ZOOM_CLIENT_SECRET`

Configure `SLACK_TEAM_ID` and `SLACK_BOT_USER_ID` as Worker variables. They must identify the existing authorized Win-Onb bot and workspace. The bot token remains in its existing secure Apps Script property; it is not stored in this repository.

The Zoom app must be activated for Server-to-Server OAuth and permit `GET /v2/contact_center/engagements`, using granular scope `contact_center:read:list_engagements:admin` or classic scope `contact_center_report:read:admin`. A successful token grant alone does not verify the account's API role permissions. See [Zoom Contact Center API documentation](https://developers.zoom.us/docs/api/contact-center/).

Configure these private Apps Script properties:

| Property | Purpose |
| --- | --- |
| `RD_SHEET_ID`, `RD_TAB_ID` | Inventory spreadsheet and tab |
| `RD_SLACK_CHANNEL_ID`, `RD_SLACK_TEAM_ID`, `RD_SLACK_APP_ID` | Existing Slack destination and application |
| `RD_MANAGER_USER_IDS` | JSON array of the two authorized report recipients |
| `RD_AGENT_USER_IDS` | JSON object mapping the support names in S to verified Slack user IDs |
| `RD_ZOOM_BRIDGE_URL` | Deployed HTTPS Worker URL ending `/replacement-delivery/calls` |
| `RD_V2_LIVE_TEST_VERIFIED` | Set to `true` only after real acceptance, call lookup and DM tests pass |

Keep the existing `SLACK_BOT_TOKEN` and `REPLACEMENT_SLACK_VERIFICATION_TOKEN` properties in their existing secure location. Do not copy them to GitHub.

## Verification notes — November 13, 2026

The referenced conversation is **Create API Access Register**. Its latest notes distinguish supplied credentials from working integrations:

- Pylon's SwiftSku account connection was verified in that conversation.
- Cloudflare's account API token was verified active in that conversation; that did not verify Worker deployment or R2 access.
- Zoom authentication, app activation, API permissions and webhook setup remained untested there.
- R2 access remained untested, and its bucket name was unspecified. R2 is not required for metadata-only call logs.
- No permanent Zoom or Cloudflare credential connection had been configured by that conversation.

This chat separately observed encrypted Zoom secret binding names on an existing reporting Worker. Their presence does not prove they use the latest registered app or have engagement-read access. The reporting Worker is not the deployment target of this repository.

Automatic approval review blocked a verification attempt that would copy pasted register secrets into executable tool code. Use securely configured credentials for live verification. Automatic approval review also previously blocked a production release without explicit deploy approval. Neither action is being bypassed.

## Remaining before live use

1. Configure the latest registered Zoom application securely on the intended Worker; provide a configured Cloudflare deployment connection with permission for this Worker.
2. Verify a live Zoom token grant and the historical-engagement read API scope and role permissions. Do not silently add OAuth permissions.
3. Deploy this repository's Worker and save its exact URL in the existing Win-Onb Apps Script.
4. Install the staged module beside the existing handler and set its private configuration. Validate state retention, throttling recovery and send-outcome review before enabling scheduled operation.
5. Use a real authorized click on an approved test message, check the same-thread confirmation, verify one real customer's call match, and verify the identical report reaches both intended recipients.
6. After explicit production-release approval and successful live checks, enable the new timer and hand off only the old Slack notification step. Preserve existing tracking and Pylon outreach, and avoid running both notifiers concurrently.

## Local checks

Run `npm test`. Tests use synthetic customers, credentials and Slack identities. Fourteen checks cover matching, pagination, authentication failures, acceptance authorization and retries, identical daily reports, duplicate-send protection, and Central dates.
