# D365 Who Has Access: Privacy Policy

Last updated: 19 September 2026

D365 Who Has Access is a Chrome extension that shows which Dynamics 365 finance and
operations security roles and users have access to a form or menu item.

## What the extension reads

When you open the side panel on a Dynamics 365 finance and operations page, the extension:

- reads the address of the current tab to find the environment, company and menu item;
- calls that environment's own OData endpoint (for example `/data/SecurityPermissions`,
  `/data/SecurityUserRoleAssociations` and `/data/SystemUsers`) using the sign-in you
  already have in your browser.

The data returned can include security roles, duties, privileges, user IDs, user names
and email addresses from your Dynamics 365 environment. You only see data your own
Dynamics 365 account is allowed to read.

## Where the data goes

- The data is displayed in the side panel and kept in memory while the panel is open.
- The only thing stored is the list of environment names and addresses you choose to save
  for cross-environment comparison. It is kept in Chrome's local extension storage on your
  device.
- CSV exports are created on your device and saved only where you choose.
- Nothing is sent to the developer or to any third party. The extension has no analytics,
  no tracking, no advertising and no remote code. Network requests go only to the
  Dynamics 365 environments you use.

## Sale and transfer

User data is not sold, not transferred to third parties, not used for purposes unrelated
to the extension's single purpose, and not used to determine creditworthiness or for
lending.

## Permissions

- **Side panel**: the interface runs in Chrome's side panel next to Dynamics 365.
- **Tabs and active tab**: to read the current page address (environment, company, menu item).
- **Storage**: to remember the environments you save.
- **Host access**: Microsoft's commercial, US Government and China cloud domains for
  Dynamics 365 are granted at install. Any other address (for example an on-premises
  environment) is only accessed after you click "Allow access" for that site.

## Removing data

Uninstalling the extension deletes its local storage. You can also remove saved
environments inside the extension at any time.

## Contact

Questions about this policy: use the support link on the extension's Chrome Web Store page.

Dynamics 365 is a trademark of Microsoft. This extension is not affiliated with or endorsed
by Microsoft.
