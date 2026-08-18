# Metadata and human decisions

Read this before external TestFlight review or App Review submission. Apple
changes required fields by platform, account, app capabilities, storefront,
and submission content, so refresh the official requirements and surface every
API `409` or `422` error without hiding details.

## TestFlight

Collect and verify:

- internal or external audience and exact beta group IDs;
- localized `What to Test` text for the build;
- beta app description and feedback email for external testing;
- beta review contact name, phone, and email;
- demo username and password when login is required;
- automatic tester notification choice, defaulting to `false`;
- export-compliance answers and any declaration documents.

Use `betaBuildLocalizations`, `betaAppLocalizations`,
`betaAppReviewDetails`, `buildBetaDetails`, `appEncryptionDeclarations`, and
`betaAppReviewSubmissions`. Store demo credentials in an approved secret
manager or local secure source; put only a reference in the manifest and never
emit the value in logs.

## App Store version

Collect every supported locale and verify at least:

- description, keywords, support URL, and screenshots;
- `What's New` for an update;
- marketing URL when used;
- copyright;
- the exact processed build;
- App Review contact, notes, and demo access;
- release type and scheduled date, if any;
- phased-release choice.

Relevant API families include `appStoreVersionLocalizations`,
`appScreenshotSets`, `appScreenshots`, `appStoreReviewDetails`, and
`appStoreVersionPhasedReleases`. Asset uploads use reservation, upload
operations, an MD5 checksum commit, and processing verification. Use
`scripts/asc-screenshots.mjs` one locale/display type at a time and follow
[Apple's asset-upload workflow](https://developer.apple.com/documentation/appstoreconnectapi/uploading-assets-to-app-store-connect)
instead of inventing upload URLs or headers.
The uploader rejects alpha channels and reports image dimensions in its
approval plan. Its operation `planSha256` binds the bundle/version/localization,
display type, status-derived existing-set snapshot, and every file hash;
execution re-fetches that ownership
chain before reserving anything. Compare the dimensions with Apple's current
screenshot specification before upload.

## App-level and commercial settings

Verify before submission:

- app name/localizations, primary and secondary categories, content rights,
  age rating, and privacy-policy URL;
- price, territories, availability date, public/private distribution, and
  pre-order state if applicable;
- in-app purchases, subscriptions, events, custom product pages, Game Center,
  App Clips, and hosted assets included in the review submission;
- encryption/export compliance;
- current legal agreements, tax, and banking status.

App Store availability now uses v2 resources in current API versions; consult
the downloaded OpenAPI spec before building the request. Do not reuse old
endpoint examples from memory.

## Actions that remain human-controlled

Do not fabricate or automatically decide:

- App Privacy questionnaire answers or its Publish confirmation;
- age-rating, content-rights, or export-compliance declarations;
- tax, banking, or legal-agreement acceptance;
- review rejection replies and appeals;
- initial app-record creation or initial public/private distribution choice;
- final production release approval.

The current OpenAPI spec does not expose the complete App Privacy questionnaire.
Complete and publish it in App Store Connect. See [manage app privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/)
and [platform version information](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information).
