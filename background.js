// D365 Who Has Access - Background Service Worker
// Uses SecurityPermissions entity for REAL access levels (Read/Update/Create/Delete/Invoke per role)

// ============ Access Level Helpers ============
// D365 SecurityPermissions access fields use a three-state enum:
//   0 = Unset  (not configured, inherits from elsewhere)
//   1 = Grant  (explicitly allowed)
//   2 = Deny   (explicitly blocked, overrides grants)

const ACCESS_UNSET = 0;
const ACCESS_GRANT = 1;
const ACCESS_DENY  = 2;

// Merge: Grant wins over Unset, Deny wins over everything
function mergeAccessField(current, incoming) {
  if (incoming === ACCESS_DENY) return ACCESS_DENY;   // Deny always wins
  if (incoming === ACCESS_GRANT && current !== ACCESS_DENY) return ACCESS_GRANT;
  return current;
}

function mergeAccess(target, p) {
  target.read    = mergeAccessField(target.read,    p.ReadAccess    ?? 0);
  target.update  = mergeAccessField(target.update,  p.UpdateAccess  ?? 0);
  target.create  = mergeAccessField(target.create,  p.CreateAccess  ?? 0);
  target.delete  = mergeAccessField(target.delete,  p.DeleteAccess  ?? 0);
  target.invoke  = mergeAccessField(target.invoke,  p.InvokeAccess  ?? 0);
  target.correct = mergeAccessField(target.correct, p.CorrectAccess ?? 0);
}

function newAccessMap() {
  return { read: 0, update: 0, create: 0, delete: 0, invoke: 0, correct: 0 };
}

// Does the role have at least one explicit Grant?
function hasAnyGrant(role) {
  return role.read === ACCESS_GRANT || role.update === ACCESS_GRANT ||
         role.create === ACCESS_GRANT || role.delete === ACCESS_GRANT ||
         role.invoke === ACCESS_GRANT || role.correct === ACCESS_GRANT;
}

// Does the role have any Deny?
function hasAnyDeny(role) {
  return role.read === ACCESS_DENY || role.update === ACCESS_DENY ||
         role.create === ACCESS_DENY || role.delete === ACCESS_DENY ||
         role.invoke === ACCESS_DENY || role.correct === ACCESS_DENY;
}

// Get label for an access value
function accessLabel(val) {
  if (val === ACCESS_GRANT) return 'Grant';
  if (val === ACCESS_DENY)  return 'Deny';
  return 'Unset';
}

// Count how many access fields are Grant (measures breadth of access)
function countGrants(role) {
  let n = 0;
  if (role.read === ACCESS_GRANT) n++;
  if (role.update === ACCESS_GRANT) n++;
  if (role.create === ACCESS_GRANT) n++;
  if (role.delete === ACCESS_GRANT) n++;
  if (role.invoke === ACCESS_GRANT) n++;
  if (role.correct === ACCESS_GRANT) n++;
  return n;
}

// ============ OData Fetch ============

async function odataFetch(url) {
  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0'
    }
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${response.status}: ${errorText.substring(0, 500)}`);
  }
  return await response.json();
}

async function query(baseUrl, entity, filter, select, top) {
  const params = [];
  if (filter) params.push(`$filter=${encodeURIComponent(filter)}`);
  if (select) params.push(`$select=${encodeURIComponent(select)}`);
  if (top) params.push(`$top=${top}`);
  params.push('cross-company=true');
  const url = `${baseUrl}/data/${entity}?${params.join('&')}`;
  const data = await odataFetch(url);
  return data.value || [];
}

async function queryCount(baseUrl, entity, filter) {
  const params = [];
  if (filter) params.push(`$filter=${encodeURIComponent(filter)}`);
  params.push('$count=true');
  params.push('$top=1');
  params.push('cross-company=true');
  const url = `${baseUrl}/data/${entity}?${params.join('&')}`;
  const data = await odataFetch(url);
  return data['@odata.count'] || 0;
}

async function getRoleName(baseUrl, roleId) {
  try {
    const data = await query(baseUrl, 'SecurityPermissions',
      `SecurityRoleIdentifier eq '${roleId}'`, 'SecurityRoleName', 1);
    return data[0]?.SecurityRoleName || roleId;
  } catch (e) {
    return roleId;
  }
}

// ============ Tab URL Detection ============

async function getD365TabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) throw new Error('No active tab.');
  const url = new URL(tab.url);
  if (!url.hostname.includes('.dynamics.com') && !url.hostname.includes('localhost') && !url.hostname.includes('127.0.0.1')) {
    throw new Error('Not on a D365 page. Navigate to D365 first.');
  }
  return {
    d365Url: url.origin,
    company: url.searchParams.get('cmp') || '',
    menuItem: url.searchParams.get('mi') || '',
    title: tab.title || ''
  };
}

// ============ Side Panel ============

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// ============ Message Handler ============

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch(err => {
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(msg) {
  switch (msg.action) {
    case 'getPageInfo':
      return await getD365TabInfo();
    case 'analyze':
      return await analyzeAccess(msg.menuItem, msg.baseUrl);
    case 'drillRole':
      return await drillRole(msg.roleId, msg.menuItem, msg.baseUrl);
    case 'compareUsers':
      return await compareUsers(msg.userIds, msg.menuItem, msg.baseUrl);
    case 'compareEnvironments':
      return await compareEnvironments(msg.userId, msg.menuItem, msg.baseUrlA, msg.baseUrlB, msg.envNameA, msg.envNameB);
    case 'getEnvironments':
      return await getEnvironments();
    case 'saveEnvironments':
      return await saveEnvironments(msg.environments);
    case 'deepCompareRoles':
      return await deepCompareRoles(msg.roleIds, msg.baseUrlA, msg.baseUrlB, msg.envNameA, msg.envNameB);
    case 'searchRole':
      return await searchRole(msg.query, msg.baseUrl);
    case 'searchUser':
      return await searchUser(msg.userId, msg.baseUrl);
    case 'traceChain':
      return await traceChain(msg.roleId, msg.dutyId, msg.menuItem, msg.baseUrl);
    case 'discoverEntities':
      return await discoverSecurityEntities(msg.baseUrl);
    case 'findNarrowestRole':
      return await findNarrowestRole(msg.menuItem, msg.baseUrl, msg.accessLevel);
    case 'recommendForUser':
      return await recommendForUser(msg.userIds, msg.menuItems || msg.menuItem, msg.baseUrl);
    case 'findNarrowestMulti':
      return await findNarrowestMulti(msg.menuItems, msg.baseUrl, msg.accessLevel);
    case 'searchUserByName':
      return await searchUserByName(msg.searchTerm, msg.baseUrl);
    case 'inspectRole':
      return await inspectRole(msg.roleQuery, msg.baseUrl);
    case 'tracePrivilegeForResource':
      return await tracePrivilegeForResource(msg.roleId, msg.resourceName, msg.baseUrl);
    case 'securityLicenseOverview':
      return await securityLicenseOverview(msg.baseUrl);
    case 'userPermissionInventory':
      return await userPermissionInventory(msg.baseUrl, msg.userIdFilter, msg.resourceTypeFilter);
    default:
      throw new Error(`Unknown: ${msg.action}`);
  }
}

// ============ Core: Analyze who has access ============

async function analyzeAccess(menuItem, baseUrl) {
  // SecurityPermissions stores ResourceName in UPPERCASE
  const mi = menuItem.toUpperCase();

  // Step 1: Query SecurityPermissions - gives REAL access levels per role
  // One query returns all roles with Read/Update/Create/Delete flags
  const permissions = await query(
    baseUrl,
    'SecurityPermissions',
    `ResourceName eq '${mi}'`,
    null,
    1000
  );

  if (permissions.length === 0) {
    return { menuItem, roles: [], users: [], noResults: true };
  }

  // Step 2: Build role map with actual access levels (Unset=0, Grant=1, Deny=2)
  // A role can appear multiple times (MenuItemDisplay, MenuItemAction, etc.) - merge access
  const roleMap = {};
  for (const p of permissions) {
    const roleId = p.SecurityRoleIdentifier;
    if (!roleMap[roleId]) {
      roleMap[roleId] = {
        roleId,
        roleName: p.SecurityRoleName || roleId,
        ...newAccessMap()
      };
    }
    mergeAccess(roleMap[roleId], p);
  }

  const roles = Object.values(roleMap);
  const roleIds = Object.keys(roleMap);

  // Step 3: Find users for each role
  const userMap = {};
  for (const roleId of roleIds) {
    const users = await query(
      baseUrl,
      'SecurityUserRoleAssociations',
      `SecurityRoleIdentifier eq '${roleId}'`,
      null,
      1000
    );
    for (const u of users) {
      if (u.AssignmentStatus && u.AssignmentStatus !== 'Enabled') continue;

      if (!userMap[u.UserId]) {
        userMap[u.UserId] = {
          userId: u.UserId,
          roles: [],
          roleIds: [],
          ...newAccessMap()
        };
      }
      const role = roleMap[roleId];
      userMap[u.UserId].roles.push(role.roleName);
      userMap[u.UserId].roleIds.push(roleId);
      // Merge access from all roles (Grant wins over Unset, Deny wins over all)
      userMap[u.UserId].read    = mergeAccessField(userMap[u.UserId].read,    role.read);
      userMap[u.UserId].update  = mergeAccessField(userMap[u.UserId].update,  role.update);
      userMap[u.UserId].create  = mergeAccessField(userMap[u.UserId].create,  role.create);
      userMap[u.UserId].delete  = mergeAccessField(userMap[u.UserId].delete,  role.delete);
      userMap[u.UserId].invoke  = mergeAccessField(userMap[u.UserId].invoke,  role.invoke);
      userMap[u.UserId].correct = mergeAccessField(userMap[u.UserId].correct, role.correct);
    }
  }

  const users = Object.values(userMap).sort((a, b) => a.userId.localeCompare(b.userId));

  // Build access label for each user
  for (const u of users) {
    u.access = [];
    if (u.read === ACCESS_GRANT) u.access.push('Read');
    if (u.update === ACCESS_GRANT) u.access.push('Update');
    if (u.create === ACCESS_GRANT) u.access.push('Create');
    if (u.delete === ACCESS_GRANT) u.access.push('Delete');
    if (u.invoke === ACCESS_GRANT) u.access.push('Invoke');
    if (u.correct === ACCESS_GRANT) u.access.push('Correct');
    // Track denies separately
    u.denied = [];
    if (u.read === ACCESS_DENY) u.denied.push('Read');
    if (u.update === ACCESS_DENY) u.denied.push('Update');
    if (u.create === ACCESS_DENY) u.denied.push('Create');
    if (u.delete === ACCESS_DENY) u.denied.push('Delete');
    if (u.invoke === ACCESS_DENY) u.denied.push('Invoke');
    if (u.correct === ACCESS_DENY) u.denied.push('Correct');
  }

  // Count by access type (Grant only)
  const counts = {
    read: users.filter(u => u.read === ACCESS_GRANT).length,
    update: users.filter(u => u.update === ACCESS_GRANT).length,
    create: users.filter(u => u.create === ACCESS_GRANT).length,
    delete: users.filter(u => u.delete === ACCESS_GRANT).length,
    invoke: users.filter(u => u.invoke === ACCESS_GRANT).length,
    correct: users.filter(u => u.correct === ACCESS_GRANT).length
  };

  // Step 4: Enrich each user with their effective license tier
  // License tier = highest tier across ALL of the user's enabled roles
  // (not just roles granting this menu item, since a user pays for the highest tier)
  await enrichUsersWithLicense(users, baseUrl);

  const licenseCounts = {};
  for (const u of users) {
    const tier = u.licenseTier || 'None';
    licenseCounts[tier] = (licenseCounts[tier] || 0) + 1;
  }

  return {
    menuItem,
    roles,
    users: Object.values(userMap).sort((a, b) => a.userId.localeCompare(b.userId)),
    counts,
    licenseCounts,
    totalRoles: roles.length,
    totalPermissions: permissions.length
  };
}

// Computes effective license tier per user based on their full enabled role set.
// Adds u.licenseTier and u.licenseRoleSource to each user object in place.
async function enrichUsersWithLicense(users, baseUrl) {
  if (users.length === 0) return;

  // Collect all distinct role IDs across all users
  const allRoleIds = new Set();
  for (const u of users) {
    // u.roleIds contains roles that grant access to THIS menu item.
    // For correct license, we need ALL enabled roles the user has.
    // Fetch them.
  }

  // Fetch each user's full role list
  const userToAllRoleIds = {};
  for (const u of users) {
    try {
      const assocs = await query(baseUrl, 'SecurityUserRoleAssociations',
        `UserId eq '${u.userId}'`, 'SecurityRoleIdentifier,AssignmentStatus', 200);
      const enabled = assocs.filter(a => !a.AssignmentStatus || a.AssignmentStatus === 'Enabled');
      const ids = enabled.map(a => a.SecurityRoleIdentifier).filter(Boolean);
      userToAllRoleIds[u.userId] = ids;
      ids.forEach(id => allRoleIds.add(id));
    } catch (e) {
      userToAllRoleIds[u.userId] = u.roleIds || [];
    }
  }

  // Get license type per role (cache to avoid duplicate queries)
  const roleLicenseMap = {};
  const roleIdsArr = [...allRoleIds];
  const batchSize = 5;
  for (let i = 0; i < roleIdsArr.length; i += batchSize) {
    const batch = roleIdsArr.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async rid => {
      try {
        const perms = await query(baseUrl, 'SecurityPermissions',
          `SecurityRoleIdentifier eq '${rid}'`,
          'UserLicenseType', 100);
        let highest = 'None';
        for (const p of perms) {
          const tier = p.UserLicenseType || 'None';
          if ((LICENSE_TIER[tier] || 0) > (LICENSE_TIER[highest] || 0)) {
            highest = tier;
          }
        }
        return { rid, license: highest };
      } catch (e) {
        return { rid, license: 'None' };
      }
    }));
    for (const { rid, license } of results) {
      roleLicenseMap[rid] = license;
    }
  }

  // Compute per-user effective license
  for (const u of users) {
    const userRoles = userToAllRoleIds[u.userId] || [];
    let highest = 'None';
    let sourceRole = null;
    for (const rid of userRoles) {
      const lic = roleLicenseMap[rid] || 'None';
      if ((LICENSE_TIER[lic] || 0) > (LICENSE_TIER[highest] || 0)) {
        highest = lic;
        sourceRole = rid;
      }
    }
    u.licenseTier = highest;
    u.licenseRoleSource = sourceRole;
  }
}

// ============ Drill into a role: show what we ACTUALLY know ============

async function drillRole(roleId, menuItem, baseUrl) {
  const mi = menuItem.toUpperCase();

  // Run queries in parallel
  const [duties, permissionDetails] = await Promise.all([
    query(baseUrl, 'SecurityRoleDuties', `SecurityRoleIdentifier eq '${roleId}'`, null, 500),
    // SecurityPermissions: the AUTHORITATIVE source - shows exactly what access this role
    // has to this menu item, broken down by resource type
    query(baseUrl, 'SecurityPermissions',
      `SecurityRoleIdentifier eq '${roleId}' and ResourceName eq '${mi}'`, null, 100)
  ]);

  // Return ALL fields from SecurityPermissions so UI can show everything
  const rawPerms = permissionDetails.map(p => {
    const obj = {};
    for (const key of Object.keys(p)) {
      if (key.startsWith('@') || key.startsWith('odata')) continue;
      obj[key] = p[key];
    }
    return obj;
  });

  // Also get ALL SecurityPermissions for this role (not just this menu item)
  // to show what ELSE this role can access
  const allRolePerms = await query(baseUrl, 'SecurityPermissions',
    `SecurityRoleIdentifier eq '${roleId}'`, null, 5000);

  // Group by ResourceType for a summary
  const resourceSummary = {};
  for (const p of allRolePerms) {
    const rt = p.ResourceType || 'Other';
    if (!resourceSummary[rt]) resourceSummary[rt] = { type: rt, count: 0, resources: [] };
    resourceSummary[rt].count++;
    // Keep first 10 resource names per type as examples
    if (resourceSummary[rt].resources.length < 10) {
      resourceSummary[rt].resources.push(p.ResourceName);
    }
  }

  return {
    roleId,
    menuItem: mi,
    duties: duties.map(d => ({
      id: d.SecurityDutyIdentifier,
      name: d.SecurityDutyName || d.SecurityDutyIdentifier
    })),
    permEntries: rawPerms,
    roleSummary: Object.values(resourceSummary),
    totalPermissions: allRolePerms.length
  };
}

// ============ Compare users: get each user's roles & access for a menu item ============

async function compareUsers(userIds, menuItem, baseUrl) {
  const mi = menuItem.toUpperCase();

  // Step 1: Get all roles that have access to this menu item (reuse analyzeAccess logic)
  const permissions = await query(
    baseUrl, 'SecurityPermissions', `ResourceName eq '${mi}'`, null, 1000
  );

  // Build role → access map (Unset=0, Grant=1, Deny=2)
  const roleAccessMap = {};
  for (const p of permissions) {
    const roleId = p.SecurityRoleIdentifier;
    if (!roleAccessMap[roleId]) {
      roleAccessMap[roleId] = {
        roleId,
        roleName: p.SecurityRoleName || roleId,
        ...newAccessMap()
      };
    }
    mergeAccess(roleAccessMap[roleId], p);
  }

  // Step 2: For each user, get ALL their roles
  const results = [];
  for (const userId of userIds) {
    const userRoles = await query(
      baseUrl, 'SecurityUserRoleAssociations',
      `UserId eq '${userId}'`, null, 500
    );

    const enabledRoles = userRoles.filter(
      r => !r.AssignmentStatus || r.AssignmentStatus === 'Enabled'
    );

    // Split into roles that grant access to this menu item vs other roles
    const grantingRoles = [];
    const otherRoles = [];
    const userAccess = newAccessMap();

    for (const r of enabledRoles) {
      const roleId = r.SecurityRoleIdentifier;
      const roleName = r.SecurityRoleName || roleId;
      if (roleAccessMap[roleId]) {
        const access = roleAccessMap[roleId];
        grantingRoles.push({ roleId, roleName, ...access });
        for (const f of ['read','update','create','delete','invoke','correct']) {
          userAccess[f] = mergeAccessField(userAccess[f], access[f]);
        }
      } else {
        otherRoles.push({ roleId, roleName });
      }
    }

    results.push({
      userId,
      totalRoles: enabledRoles.length,
      grantingRoles,
      otherRoles,
      access: userAccess,
      hasAccess: grantingRoles.length > 0
    });
  }

  return { menuItem, users: results };
}

// ============ Cross-Environment Compare ============

async function getEnvironments() {
  const data = await chrome.storage.local.get('d365Environments');
  return { environments: data.d365Environments || [] };
}

async function saveEnvironments(environments) {
  await chrome.storage.local.set({ d365Environments: environments });
  return { ok: true };
}

async function compareEnvironments(userId, menuItem, baseUrlA, baseUrlB, envNameA, envNameB) {
  const mi = menuItem.toUpperCase();

  // Helper: get user roles + menu item permissions from one environment
  async function queryEnv(baseUrl) {
    const [userRoles, permissions] = await Promise.all([
      query(baseUrl, 'SecurityUserRoleAssociations', `UserId eq '${userId}'`, null, 500),
      query(baseUrl, 'SecurityPermissions', `ResourceName eq '${mi}'`, null, 1000)
    ]);

    // Build role access map for this menu item (Unset=0, Grant=1, Deny=2)
    const roleAccessMap = {};
    for (const p of permissions) {
      const roleId = p.SecurityRoleIdentifier;
      if (!roleAccessMap[roleId]) {
        roleAccessMap[roleId] = { roleId, roleName: p.SecurityRoleName || roleId, ...newAccessMap() };
      }
      mergeAccess(roleAccessMap[roleId], p);
    }

    // Filter to enabled roles
    const enabledRoles = userRoles.filter(r => !r.AssignmentStatus || r.AssignmentStatus === 'Enabled');
    const allRoles = enabledRoles.map(r => ({
      roleId: r.SecurityRoleIdentifier,
      roleName: r.SecurityRoleName || r.SecurityRoleIdentifier
    }));

    // Which of user's roles grant access to this menu item?
    const grantingRoles = [];
    const access = newAccessMap();
    for (const r of enabledRoles) {
      const roleId = r.SecurityRoleIdentifier;
      if (roleAccessMap[roleId]) {
        const a = roleAccessMap[roleId];
        grantingRoles.push(a);
        for (const f of ['read','update','create','delete','invoke','correct']) {
          access[f] = mergeAccessField(access[f], a[f]);
        }
      }
    }

    return {
      totalRoles: enabledRoles.length,
      allRoles,
      grantingRoles,
      access,
      userFound: userRoles.length > 0
    };
  }

  // Query both environments in parallel
  let envAResult, envBResult, envAError, envBError;
  const [resA, resB] = await Promise.allSettled([queryEnv(baseUrlA), queryEnv(baseUrlB)]);

  if (resA.status === 'fulfilled') envAResult = resA.value;
  else envAError = resA.reason.message || String(resA.reason);

  if (resB.status === 'fulfilled') envBResult = resB.value;
  else envBError = resB.reason.message || String(resB.reason);

  // Compute role diff (all roles, not just granting ones)
  let roleDiff = null;
  if (envAResult && envBResult) {
    const rolesA = new Map(envAResult.allRoles.map(r => [r.roleId, r.roleName]));
    const rolesB = new Map(envBResult.allRoles.map(r => [r.roleId, r.roleName]));

    const common = [], onlyInA = [], onlyInB = [];
    for (const [id, name] of rolesA) {
      if (rolesB.has(id)) common.push({ roleId: id, roleName: name });
      else onlyInA.push({ roleId: id, roleName: name });
    }
    for (const [id, name] of rolesB) {
      if (!rolesA.has(id)) onlyInB.push({ roleId: id, roleName: name });
    }
    roleDiff = { common, onlyInA, onlyInB };
  }

  // Compute access diff for the menu item
  let accessDiff = null;
  if (envAResult && envBResult) {
    const a = envAResult.access, b = envBResult.access;
    accessDiff = {
      read:   { a: a.read,   b: b.read,   changed: a.read !== b.read },
      update: { a: a.update, b: b.update, changed: a.update !== b.update },
      create: { a: a.create, b: b.create, changed: a.create !== b.create },
      delete: { a: a.delete, b: b.delete, changed: a.delete !== b.delete }
    };
  }

  // Compute granting roles diff (roles that grant access to THIS menu item)
  let grantingDiff = null;
  if (envAResult && envBResult) {
    const gA = new Map(envAResult.grantingRoles.map(r => [r.roleId, r]));
    const gB = new Map(envBResult.grantingRoles.map(r => [r.roleId, r]));
    const allIds = new Set([...gA.keys(), ...gB.keys()]);
    grantingDiff = [];
    for (const id of allIds) {
      const roleEntry = gA.get(id) || gB.get(id);
      grantingDiff.push({
        roleId: id,
        roleName: roleEntry ? roleEntry.roleName : id,
        inA: gA.has(id),
        inB: gB.has(id),
        accessA: gA.get(id) || null,
        accessB: gB.get(id) || null
      });
    }
  }

  return {
    userId,
    menuItem: mi,
    envA: { name: envNameA, url: baseUrlA, ...(envAResult || {}), error: envAError || null },
    envB: { name: envNameB, url: baseUrlB, ...(envBResult || {}), error: envBError || null },
    roleDiff,
    accessDiff,
    grantingDiff
  };
}

// ============ Deep Compare: duties & privileges per role across environments ============

async function deepCompareRoles(roleIds, baseUrlA, baseUrlB, envNameA, envNameB) {
  const results = [];

  // For each role, query duties and privileges in both environments in parallel
  for (const roleId of roleIds) {
    const [dutiesA, dutiesB, privsA, privsB] = await Promise.all([
      query(baseUrlA, 'SecurityRoleDuties', `SecurityRoleIdentifier eq '${roleId}'`, null, 500).catch(() => []),
      query(baseUrlB, 'SecurityRoleDuties', `SecurityRoleIdentifier eq '${roleId}'`, null, 500).catch(() => []),
      query(baseUrlA, 'SecurityPrivileges', `SecurityRoleIdentifier eq '${roleId}'`, null, 2000).catch(() => []),
      query(baseUrlB, 'SecurityPrivileges', `SecurityRoleIdentifier eq '${roleId}'`, null, 2000).catch(() => []),
    ]);

    // Diff duties
    const dutySetA = new Map(dutiesA.map(d => [d.SecurityDutyIdentifier, d.SecurityDutyName || d.SecurityDutyIdentifier]));
    const dutySetB = new Map(dutiesB.map(d => [d.SecurityDutyIdentifier, d.SecurityDutyName || d.SecurityDutyIdentifier]));
    const dutiesCommon = [], dutiesOnlyA = [], dutiesOnlyB = [];
    for (const [id, name] of dutySetA) {
      if (dutySetB.has(id)) dutiesCommon.push({ id, name });
      else dutiesOnlyA.push({ id, name });
    }
    for (const [id, name] of dutySetB) {
      if (!dutySetA.has(id)) dutiesOnlyB.push({ id, name });
    }

    // Diff privileges
    const privSetA = new Map(privsA.map(p => [p.SecurityPrivilegeIdentifier, p.SecurityPrivilegeName || p.SecurityPrivilegeIdentifier]));
    const privSetB = new Map(privsB.map(p => [p.SecurityPrivilegeIdentifier, p.SecurityPrivilegeName || p.SecurityPrivilegeIdentifier]));
    const privsCommon = [], privsOnlyA = [], privsOnlyB = [];
    for (const [id, name] of privSetA) {
      if (privSetB.has(id)) privsCommon.push({ id, name });
      else privsOnlyA.push({ id, name });
    }
    for (const [id, name] of privSetB) {
      if (!privSetA.has(id)) privsOnlyB.push({ id, name });
    }

    const roleName = dutiesA[0]?.SecurityRoleName || dutiesB[0]?.SecurityRoleName || roleId;
    const hasDiff = dutiesOnlyA.length > 0 || dutiesOnlyB.length > 0 || privsOnlyA.length > 0 || privsOnlyB.length > 0;

    results.push({
      roleId,
      roleName,
      hasDiff,
      duties: {
        common: dutiesCommon,
        onlyInA: dutiesOnlyA,
        onlyInB: dutiesOnlyB,
        totalA: dutySetA.size,
        totalB: dutySetB.size
      },
      privileges: {
        common: privsCommon,
        onlyInA: privsOnlyA,
        onlyInB: privsOnlyB,
        totalA: privSetA.size,
        totalB: privSetB.size
      }
    });
  }

  return { roles: results, envNameA, envNameB };
}

// ============ Search: look up a role and show its users + permissions ============

async function searchRole(roleName, baseUrl) {
  // Query SecurityUserRoleAssociations for this role
  const assignments = await query(
    baseUrl, 'SecurityUserRoleAssociations',
    `SecurityRoleIdentifier eq '${roleName}'`, null, 1000
  );

  const users = assignments
    .filter(a => !a.AssignmentStatus || a.AssignmentStatus === 'Enabled')
    .map(a => a.UserId);

  // Get ALL permissions for this role
  const perms = await query(
    baseUrl, 'SecurityPermissions',
    `SecurityRoleIdentifier eq '${roleName}'`, null, 5000
  );

  // Get duties
  const duties = await query(
    baseUrl, 'SecurityRoleDuties',
    `SecurityRoleIdentifier eq '${roleName}'`, null, 500
  );

  // Group permissions by resource (Unset=0, Grant=1, Deny=2)
  const resources = {};
  for (const p of perms) {
    const key = p.ResourceName;
    if (!resources[key]) {
      resources[key] = {
        name: p.ResourceName,
        type: p.ResourceType,
        ...newAccessMap()
      };
    }
    mergeAccess(resources[key], p);
  }

  return {
    roleId: roleName,
    roleName: (assignments[0] && assignments[0].SecurityRoleName) || roleName,
    users: [...new Set(users)].sort(),
    duties: duties.map(d => ({
      id: d.SecurityDutyIdentifier,
      name: d.SecurityDutyName || d.SecurityDutyIdentifier
    })),
    resources: Object.values(resources),
    totalPermissions: perms.length
  };
}

// ============ Search: look up a user and show their roles + access ============

async function searchUser(userId, baseUrl) {
  const assignments = await query(
    baseUrl, 'SecurityUserRoleAssociations',
    `UserId eq '${userId}'`, null, 500
  );

  const enabledRoles = assignments.filter(
    a => !a.AssignmentStatus || a.AssignmentStatus === 'Enabled'
  );

  // For each role, get a sample of permissions to show scope
  const roles = [];
  for (const a of enabledRoles) {
    const roleId = a.SecurityRoleIdentifier;
    const roleName = a.SecurityRoleName || roleId;

    const perms = await query(
      baseUrl, 'SecurityPermissions',
      `SecurityRoleIdentifier eq '${roleId}'`, null, 5000
    );

    // Count by resource type
    const typeCounts = {};
    const menuItems = [];
    for (const p of perms) {
      const rt = p.ResourceType || 'Other';
      typeCounts[rt] = (typeCounts[rt] || 0) + 1;
      if ((rt === 'MenuItemDisplay' || rt === 'MenuItemAction' || rt === 'MenuItemOutput')
          && menuItems.length < 20) {
        menuItems.push({
          name: p.ResourceName,
          type: rt,
          read: p.ReadAccess || 0,
          update: p.UpdateAccess || 0,
          create: p.CreateAccess || 0,
          delete: p.DeleteAccess || 0
        });
      }
    }

    roles.push({
      roleId,
      roleName,
      totalPermissions: perms.length,
      typeCounts,
      menuItems
    });
  }

  return {
    userId,
    totalRoles: enabledRoles.length,
    roles
  };
}

// ============ Search Users by Name/ID ============

async function searchUserByName(searchTerm, baseUrl) {
  const term = (searchTerm || '').trim();
  if (term.length < 2) throw new Error('Enter at least 2 characters to search');
  const safeTerm = term.replace(/'/g, "''");

  // D365 F&O OData uses wildcard eq for string matching (not contains/substringof/startswith).
  // Official syntax: $filter=StringField eq '*value*'
  // See: https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/data-entities/odata
  const entities = [
    { entity: 'SystemUsers', nameField: 'UserName', idField: 'UserId', emailField: 'UserEmail', enabledField: 'Enabled' },
    { entity: 'UserInfos', nameField: 'UserName', idField: 'UserId', emailField: 'UserEmail', enabledField: 'Enabled' },
    { entity: 'SystemUsersV2', nameField: 'UserName', idField: 'UserId', emailField: 'UserEmail', enabledField: 'Enabled' },
  ];

  for (const att of entities) {
    try {
      // D365 wildcard: eq '*term*' acts as contains
      const filter = `${att.nameField} eq '*${safeTerm}*' or ${att.idField} eq '*${safeTerm}*'`;
      const select = [att.idField, att.nameField, att.emailField, att.enabledField].filter(Boolean).join(',');
      const results = await query(baseUrl, att.entity, filter, select, 50);

      return {
        users: results.map(u => ({
          userId: u[att.idField] || '',
          userName: u[att.nameField] || '',
          email: u[att.emailField] || '',
          enabled: u[att.enabledField] !== false && u[att.enabledField] !== 0
        })).filter(u => u.userId),
        entity: att.entity,
        searchTerm: term
      };
    } catch (e) {
      // Try next entity
      continue;
    }
  }

  // Fallback: search SecurityUserRoleAssociations with wildcard
  try {
    const filter = `UserId eq '*${safeTerm}*'`;
    const results = await query(baseUrl, 'SecurityUserRoleAssociations', filter, 'UserId,SecurityRoleName', 100);

    const seen = new Set();
    const users = [];
    for (const r of results) {
      if (!seen.has(r.UserId)) {
        seen.add(r.UserId);
        users.push({ userId: r.UserId, userName: '', email: '', enabled: true });
      }
    }

    if (users.length > 0) {
      return { users, entity: 'SecurityUserRoleAssociations (fallback)', searchTerm: term };
    }
  } catch (e) { /* fall through */ }

  throw new Error(`Could not search users matching "${term}"`);
}

// ============ Discover: try ALL possible security entity names ============

async function tryEntity(baseUrl, entity) {
  try {
    const data = await query(baseUrl, entity, null, null, 1);
    // Return the first record's keys so we know the schema
    const fields = data.length > 0
      ? Object.keys(data[0]).filter(k => !k.startsWith('@') && !k.startsWith('odata'))
      : [];
    return { entity, exists: true, fields, sample: data[0] || null };
  } catch (e) {
    return { entity, exists: false, error: e.message.substring(0, 200) };
  }
}

async function discoverSecurityEntities(baseUrl) {
  // Try every possible security-related entity name
  const candidates = [
    // Known working
    'SecurityPermissions',
    'SecurityUserRoleAssociations',
    'SecurityRoleDuties',
    'SecurityPrivileges',
    // Duty → Privilege (the missing link)
    'SecurityDutyPrivileges',
    'SecurityDutyPrivilegeAssociations',
    'SecurityTaskPrivileges',
    'SecurityTaskPrivilegeRelations',
    'SecurityDutyPermissions',
    // Privilege → Entry Point
    'SecurityPrivilegeEntryPoints',
    'SecurityPrivilegePermissions',
    'SecurityPrivilegeResources',
    'SecurityPrivilegeMenuItems',
    // Sub-roles
    'SecuritySubRoles',
    'SecurityRoleRelations',
    'SecurityRoleSubRoles',
    'SecurityRoleHierarchy',
    // Other
    'SecurityRolePermissions',
    'SecurityRolePrivileges',
    'SecurityRolePrivilegeAssociations',
    'SecurityDuties',
    'SecurityDutyEntryPoints',
    'SecurityObjects',
    'SecurityObjectPermissions',
    'SecurityEntryPoints',
    'SecurityAccessRights',
    'SecurityRoleTaskRelations',
    'SecurityTaskDutyRelations',
  ];

  // Run all in parallel for speed
  const results = await Promise.all(
    candidates.map(entity => tryEntity(baseUrl, entity))
  );

  return {
    found: results.filter(r => r.exists),
    notFound: results.filter(r => !r.exists).map(r => r.entity)
  };
}

// ============ Find Narrowest Role for a Menu Item ============

async function findNarrowestRole(menuItem, baseUrl, accessLevel) {
  const mi = menuItem.toUpperCase();

  // Step 1: Find all roles with access to this menu item
  const permissions = await query(
    baseUrl, 'SecurityPermissions', `ResourceName eq '${mi}'`, null, 1000
  );

  if (permissions.length === 0) {
    // No role grants access - try to find similar resources as hints
    let privilegeHint = null;
    try {
      const broader = await query(
        baseUrl, 'SecurityPermissions',
        `substringof('${mi}', ResourceName)`, null, 10
      ).catch(() => []);
      if (broader.length > 0) {
        privilegeHint = {
          type: 'similar',
          message: 'No exact match found, but similar resources exist',
          resources: [...new Set(broader.map(p => p.ResourceName))].slice(0, 10)
        };
      }
    } catch (e) {
      try {
        const broader = await query(
          baseUrl, 'SecurityPermissions',
          `startswith(ResourceName, '${mi.substring(0, Math.min(mi.length, 10))}')`, null, 10
        ).catch(() => []);
        if (broader.length > 0) {
          privilegeHint = {
            type: 'similar',
            message: 'No exact match found, but similar resources exist',
            resources: [...new Set(broader.map(p => p.ResourceName))].slice(0, 10)
          };
        }
      } catch (e2) { /* ignore */ }
    }

    return {
      menuItem: mi,
      noResults: true,
      privilegeHint,
      recommendation: `No security role grants access to "${mi}". A custom privilege needs to be created for this menu item, then assigned to a duty and role.`
    };
  }

  // Step 2: Build role map with access levels (Unset=0, Grant=1, Deny=2)
  // Note: SecurityPermissions only has role-level fields, NOT privilege/duty identifiers
  const roleMap = {};

  for (const p of permissions) {
    const roleId = p.SecurityRoleIdentifier;
    const roleName = p.SecurityRoleName || roleId;

    if (!roleMap[roleId]) {
      roleMap[roleId] = {
        roleId, roleName,
        ...newAccessMap(),
        privileges: new Set(),
        duties: new Set(),
        resourceTypes: new Set()
      };
    }
    mergeAccess(roleMap[roleId], p);
    if (p.ResourceType) roleMap[roleId].resourceTypes.add(p.ResourceType);
  }

  // Separate roles into: has Grant, all Deny, all Unset
  const grantRoles = [];
  const denyRoles = [];
  const unsetRoles = [];
  for (const roleId of Object.keys(roleMap)) {
    const r = roleMap[roleId];
    if (hasAnyGrant(r)) grantRoles.push(roleId);
    else if (hasAnyDeny(r)) denyRoles.push(roleId);
    else unsetRoles.push(roleId);
  }

  // Filter by requested access level (Grant only)
  let candidateRoleIds = grantRoles;
  if (accessLevel === 'read') {
    candidateRoleIds = candidateRoleIds.filter(id => roleMap[id].read === ACCESS_GRANT);
  } else if (accessLevel === 'update') {
    candidateRoleIds = candidateRoleIds.filter(id => roleMap[id].update === ACCESS_GRANT);
  } else if (accessLevel === 'create') {
    candidateRoleIds = candidateRoleIds.filter(id => roleMap[id].create === ACCESS_GRANT);
  } else if (accessLevel === 'delete') {
    candidateRoleIds = candidateRoleIds.filter(id => roleMap[id].delete === ACCESS_GRANT);
  } else if (accessLevel === 'invoke') {
    candidateRoleIds = candidateRoleIds.filter(id => roleMap[id].invoke === ACCESS_GRANT);
  }

  // If no Grant roles, show what we found (Deny/Unset roles) with explanation
  if (candidateRoleIds.length === 0) {
    const denyInfo = denyRoles.slice(0, 5).map(id => ({
      roleId: id,
      roleName: roleMap[id].roleName,
      read: accessLabel(roleMap[id].read),
      update: accessLabel(roleMap[id].update),
      create: accessLabel(roleMap[id].create),
      delete: accessLabel(roleMap[id].delete),
      invoke: accessLabel(roleMap[id].invoke),
      correct: accessLabel(roleMap[id].correct)
    }));

    return {
      menuItem: mi,
      noResults: true,
      totalRoles: Object.keys(roleMap).length,
      grantCount: grantRoles.length,
      denyCount: denyRoles.length,
      unsetCount: unsetRoles.length,
      denyInfo,
      recommendation: accessLevel
        ? `${Object.keys(roleMap).length} roles reference "${mi}" but none grant "${accessLevel}" access. ${denyRoles.length} roles have explicit Deny, ${unsetRoles.length} have Unset (not configured).`
        : `${Object.keys(roleMap).length} roles reference "${mi}" but none have explicit Grant. ${denyRoles.length} have Deny (explicitly blocked), ${unsetRoles.length} have Unset. A privilege with Grant access needs to be created or assigned.`
    };
  }

  // Step 3: For each candidate role, count total permissions (cap at 30 roles, parallel)
  const cappedCandidates = candidateRoleIds.slice(0, 30);
  const scoreResults = await Promise.all(cappedCandidates.map(async roleId => {
    let totalPerms = 0;
    let userCount = 0;
    try {
      const countUrl = `${baseUrl}/data/SecurityPermissions?$filter=${encodeURIComponent(`SecurityRoleIdentifier eq '${roleId}'`)}&$count=true&$top=0&cross-company=true`;
      const countData = await odataFetch(countUrl);
      totalPerms = countData['@odata.count'] || 0;
    } catch (e) {
      totalPerms = 9999;
    }
    try {
      const users = await query(
        baseUrl, 'SecurityUserRoleAssociations',
        `SecurityRoleIdentifier eq '${roleId}'`, null, 1000
      );
      userCount = users.filter(u => !u.AssignmentStatus || u.AssignmentStatus === 'Enabled').length;
    } catch (e) { /* ignore */ }
    return { roleId, totalPerms, userCount };
  }));

  const roleScores = [];
  for (const { roleId, totalPerms, userCount } of scoreResults) {
    const role = roleMap[roleId];
    roleScores.push({
      roleId,
      roleName: role.roleName,
      read: role.read,
      update: role.update,
      create: role.create,
      delete: role.delete,
      invoke: role.invoke,
      correct: role.correct,
      readLabel: accessLabel(role.read),
      updateLabel: accessLabel(role.update),
      createLabel: accessLabel(role.create),
      deleteLabel: accessLabel(role.delete),
      invokeLabel: accessLabel(role.invoke),
      correctLabel: accessLabel(role.correct),
      grantCount: countGrants(role),
      totalPermissions: totalPerms,
      userCount,
      privileges: [...role.privileges],
      duties: [...role.duties],
      resourceTypes: [...role.resourceTypes]
    });
  }

  // Step 4: Sort by narrowness
  // 1st: fewer total permissions = narrower scope (less extra access granted)
  // 2nd tiebreaker depends on intent:
  //   - "Any access": prefer MORE grants (most useful role for the least scope)
  //   - Specific level (e.g. "Read"): prefer FEWER grants (just what was asked for)
  roleScores.sort((a, b) => {
    const permDiff = a.totalPermissions - b.totalPermissions;
    if (permDiff !== 0) return permDiff;
    return accessLevel
      ? countGrants(a) - countGrants(b)   // specific level: fewer grants = narrower
      : countGrants(b) - countGrants(a);  // any access: more grants = more useful
  });

  const narrowest = roleScores[0];

  // Step 5: Get privileges and duties via SecurityPrivileges + SecurityRoleDuties entities
  // Only query the TOP 5 narrowest roles to avoid API explosion
  const grantRoleIdsForPrivDuty = (candidateRoleIds.length > 0 ? candidateRoleIds : grantRoles);
  const topRoleIds = roleScores.slice(0, 5).map(r => r.roleId);
  const privMap2 = {};
  const dutyMap2 = {};

  const rolePrivDutyResults = await Promise.all(topRoleIds.map(async roleId => {
    const [privs, roleDuties] = await Promise.all([
      query(baseUrl, 'SecurityPrivileges', `SecurityRoleIdentifier eq '${roleId}'`, null, 500).catch(() => []),
      query(baseUrl, 'SecurityRoleDuties', `SecurityRoleIdentifier eq '${roleId}'`, null, 200).catch(() => [])
    ]);
    return { roleId, privs, roleDuties };
  }));

  for (const { roleId, privs, roleDuties } of rolePrivDutyResults) {
    for (const p of privs) {
      const privId = p.SecurityPrivilegeIdentifier || p.SecurityPrivilegeName;
      if (!privId) continue;
      if (!privMap2[privId]) {
        privMap2[privId] = { id: privId, name: p.SecurityPrivilegeName || privId, roles: new Set() };
      }
      privMap2[privId].roles.add(roleId);
    }
    for (const d of roleDuties) {
      const dutyId = d.SecurityDutyIdentifier || d.SecurityDutyName;
      if (!dutyId) continue;
      if (!dutyMap2[dutyId]) {
        dutyMap2[dutyId] = { id: dutyId, name: d.SecurityDutyName || dutyId, roles: new Set(), privileges: new Set() };
      }
      dutyMap2[dutyId].roles.add(roleId);
    }
  }

  // Populate roleMap privileges/duties from the separate entity data
  for (const [privId, pr] of Object.entries(privMap2)) {
    for (const roleId of pr.roles) {
      if (roleMap[roleId]) roleMap[roleId].privileges.add(pr.name);
    }
  }
  for (const [dutyId, d] of Object.entries(dutyMap2)) {
    for (const roleId of d.roles) {
      if (roleMap[roleId]) roleMap[roleId].duties.add(d.name);
    }
  }

  // Score privileges by how many roles they appear in (fewer = more specific) - no extra API calls
  const privScores = Object.values(privMap2).map(pr => ({
    id: pr.id, name: pr.name,
    totalEntryPoints: pr.roles.size,
    roles: [...pr.roles].map(id => ({ id, name: roleMap[id]?.roleName || id }))
  }));
  privScores.sort((a, b) => a.totalEntryPoints - b.totalEntryPoints);

  // Score duties by how many privileges they contain - use duty→privilege data we already have
  const dutyScores = Object.values(dutyMap2).map(d => ({
    id: d.id, name: d.name,
    totalPrivileges: d.privileges.size,
    roles: [...d.roles].map(id => ({ id, name: roleMap[id]?.roleName || id })),
    privileges: [...d.privileges].map(id => ({ id, name: privMap2[id]?.name || id }))
  }));
  dutyScores.sort((a, b) => a.totalPrivileges - b.totalPrivileges || a.roles.length - b.roles.length);

  return {
    menuItem: mi,
    noResults: false,
    roles: roleScores,
    narrowest: {
      roleId: narrowest.roleId,
      roleName: narrowest.roleName,
      totalPermissions: narrowest.totalPermissions,
      userCount: narrowest.userCount,
      read: narrowest.read,
      update: narrowest.update,
      create: narrowest.create,
      delete: narrowest.delete,
      invoke: narrowest.invoke,
      correct: narrowest.correct,
      grantCount: narrowest.grantCount,
      readLabel: narrowest.readLabel,
      updateLabel: narrowest.updateLabel,
      createLabel: narrowest.createLabel,
      deleteLabel: narrowest.deleteLabel,
      invokeLabel: narrowest.invokeLabel,
      correctLabel: narrowest.correctLabel,
      privileges: narrowest.privileges,
      duties: narrowest.duties,
      resourceTypes: narrowest.resourceTypes
    },
    totalCandidates: roleScores.length,
    // Narrowest privilege and duty
    narrowestPrivilege: privScores.length > 0 ? privScores[0] : null,
    rankedPrivileges: privScores,
    narrowestDuty: dutyScores.length > 0 ? dutyScores[0] : null,
    rankedDuties: dutyScores,
    // Full chain: privileges and duties from SecurityPrivileges/SecurityRoleDuties
    privileges: privScores,
    duties: dutyScores
  };
}

// ============ Recommend Role for a Specific User ============

async function recommendForUser(userIds, menuItems, baseUrl) {
  const users = Array.isArray(userIds) ? userIds : [userIds];
  const items = (Array.isArray(menuItems) ? menuItems : menuItems ? [menuItems] : []).map(m => (m || '').trim().toUpperCase()).filter(Boolean);
  if (items.length === 0) throw new Error('No menu items provided');

  // Step 1: Get each user's current roles
  const userDataMap = {};
  for (const userId of users) {
    const userRoles = await query(
      baseUrl, 'SecurityUserRoleAssociations',
      `UserId eq '${userId}'`, null, 500
    );
    const enabled = userRoles.filter(r => !r.AssignmentStatus || r.AssignmentStatus === 'Enabled');
    userDataMap[userId] = {
      userId,
      roleIds: new Set(enabled.map(r => r.SecurityRoleIdentifier)),
      roleNames: {},
      totalRoles: enabled.length,
      found: userRoles.length > 0
    };
    for (const r of enabled) {
      userDataMap[userId].roleNames[r.SecurityRoleIdentifier] = r.SecurityRoleName || r.SecurityRoleIdentifier;
    }
  }

  // Step 2: Get all roles that reference EACH menu item
  const allPermissions = [];
  const perMenuItemPerms = {};
  const perMenuItemRoleIds = {};
  for (const mi of items) {
    const perms = await query(baseUrl, 'SecurityPermissions', `ResourceName eq '${mi}'`, null, 1000);
    perMenuItemPerms[mi] = perms;
    perMenuItemRoleIds[mi] = new Set(perms.map(p => p.SecurityRoleIdentifier));
    allPermissions.push(...perms);
  }

  const missing = items.filter(mi => perMenuItemPerms[mi].length === 0);
  const presentItems = items.filter(mi => perMenuItemPerms[mi].length > 0);

  if (presentItems.length === 0) {
    return {
      users: users.map(id => ({ userId: id, found: userDataMap[id]?.found })),
      menuItems: items,
      noRolesExist: true,
      missing,
      recommendation: `No role in the system grants access to: ${items.join(', ')}. Custom privileges need to be created.`
    };
  }

  // Step 3: Build role map with privileges/duties across all menu items
  const roleMap = {};
  const rolePerMenuItem = {};
  for (const mi of presentItems) {
    for (const p of perMenuItemPerms[mi]) {
      const roleId = p.SecurityRoleIdentifier;
      if (!roleMap[roleId]) {
        roleMap[roleId] = {
          roleId, roleName: p.SecurityRoleName || roleId,
          ...newAccessMap(),
          privileges: new Set(),
          duties: new Set(),
          menuItemsCovered: new Set()
        };
        rolePerMenuItem[roleId] = {};
      }
      mergeAccess(roleMap[roleId], p);
      roleMap[roleId].menuItemsCovered.add(mi);

      if (!rolePerMenuItem[roleId][mi]) rolePerMenuItem[roleId][mi] = newAccessMap();
      mergeAccess(rolePerMenuItem[roleId][mi], p);
    }
  }

  // Find roles that cover ALL present menu items with Grant
  const coverAllRoleIds = Object.keys(roleMap).filter(id => {
    for (const mi of presentItems) {
      if (!rolePerMenuItem[id]?.[mi]) return false;
      if (!hasAnyGrant(rolePerMenuItem[id][mi])) return false;
    }
    return true;
  });

  // Step 4: Per-user analysis - check access per menu item
  const userResults = [];
  for (const userId of users) {
    const ud = userDataMap[userId];
    if (!ud.found) {
      userResults.push({ userId, found: false });
      continue;
    }

    // Per menu item: which of user's roles grant access?
    const perMenuItem = {};
    let allCovered = true;
    for (const mi of presentItems) {
      const grantingRoles = [];
      for (const roleId of ud.roleIds) {
        if (rolePerMenuItem[roleId]?.[mi] && hasAnyGrant(rolePerMenuItem[roleId][mi])) {
          grantingRoles.push({
            roleId, roleName: roleMap[roleId].roleName,
            ...rolePerMenuItem[roleId][mi]
          });
        }
      }
      const effectiveAccess = newAccessMap();
      for (const r of grantingRoles) {
        for (const f of ['read','update','create','delete','invoke','correct']) {
          effectiveAccess[f] = mergeAccessField(effectiveAccess[f], r[f]);
        }
      }
      perMenuItem[mi] = { grantingRoles, effectiveAccess, hasAccess: grantingRoles.length > 0 };
      if (grantingRoles.length === 0) allCovered = false;
    }

    // Overall effective access (merged across all menu items)
    const overallAccess = newAccessMap();
    for (const mi of presentItems) {
      for (const f of ['read','update','create','delete','invoke','correct']) {
        overallAccess[f] = mergeAccessField(overallAccess[f], perMenuItem[mi].effectiveAccess[f]);
      }
    }

    const missingMenuItems = presentItems.filter(mi => !perMenuItem[mi].hasAccess);

    userResults.push({
      userId,
      found: true,
      totalRoles: ud.totalRoles,
      alreadyHasAccess: allCovered,
      effectiveAccess: overallAccess,
      perMenuItem,
      missingMenuItems
    });
  }

  // Step 5: Find common roles across ALL users
  const allUserRoleIds = users.filter(id => userDataMap[id]?.found).map(id => userDataMap[id].roleIds);
  let commonRoleIds = [];
  if (allUserRoleIds.length > 0) {
    commonRoleIds = [...allUserRoleIds[0]].filter(roleId =>
      allUserRoleIds.every(set => set.has(roleId))
    );
  }

  // Common roles that DON'T cover all menu items = candidates for modification
  const commonRolesWithoutFullAccess = commonRoleIds.filter(id => !coverAllRoleIds.includes(id));
  const commonRolesWithFullAccess = commonRoleIds.filter(id => coverAllRoleIds.includes(id));

  const systemRoleNames = ['systemuser', 'system user', 'systemadministrator'];
  const commonRoleInfo = commonRolesWithoutFullAccess
    .map(roleId => {
      const name = userDataMap[users[0]]?.roleNames[roleId] || roleId;
      // Show which menu items this role already covers
      const covers = presentItems.filter(mi =>
        rolePerMenuItem[roleId]?.[mi] && hasAnyGrant(rolePerMenuItem[roleId][mi])
      );
      return { roleId, roleName: name, coversMenuItems: covers };
    })
    .filter(r => !systemRoleNames.includes(r.roleName.toLowerCase()))
    .slice(0, 20);

  // Step 6: Find narrowest role that covers ALL menu items (cap at 20 to avoid API explosion)
  const roleScores = [];
  const topCoverRoleIds = coverAllRoleIds.slice(0, 20);
  const permCounts = await Promise.all(topCoverRoleIds.map(async roleId => {
    try {
      const countUrl = `${baseUrl}/data/SecurityPermissions?$filter=${encodeURIComponent(`SecurityRoleIdentifier eq '${roleId}'`)}&$count=true&$top=0&cross-company=true`;
      const countData = await odataFetch(countUrl);
      return { roleId, count: countData['@odata.count'] || 0 };
    } catch (e) {
      return { roleId, count: 9999 };
    }
  }));
  const permCountMap = {};
  for (const pc of permCounts) permCountMap[pc.roleId] = pc.count;

  for (const roleId of topCoverRoleIds) {
    const role = roleMap[roleId];
    roleScores.push({
      roleId, roleName: role.roleName,
      read: role.read, update: role.update, create: role.create,
      delete: role.delete, invoke: role.invoke, correct: role.correct,
      totalPermissions: permCountMap[roleId] || 0,
      privileges: [...role.privileges],
      duties: [...role.duties],
      menuItemsCovered: [...role.menuItemsCovered]
    });
  }
  roleScores.sort((a, b) => {
    const permDiff = a.totalPermissions - b.totalPermissions;
    if (permDiff !== 0) return permDiff;
    return countGrants(a) - countGrants(b);
  });

  // Step 6b: Get privileges and duties for TOP 5 narrowest roles only (avoid API explosion)
  const topRecRoleIds = roleScores.slice(0, 5).map(r => r.roleId);
  const privilegeMap = {};
  const dutyMap = {};

  if (topRecRoleIds.length > 0) {
    const rolePrivDutyResults = await Promise.all(topRecRoleIds.map(async roleId => {
      const [privs, duties] = await Promise.all([
        query(baseUrl, 'SecurityPrivileges', `SecurityRoleIdentifier eq '${roleId}'`, null, 500).catch(() => []),
        query(baseUrl, 'SecurityRoleDuties', `SecurityRoleIdentifier eq '${roleId}'`, null, 200).catch(() => [])
      ]);
      return { roleId, privs, duties };
    }));

    for (const { roleId, privs, duties } of rolePrivDutyResults) {
      for (const p of privs) {
        const privId = p.SecurityPrivilegeIdentifier || p.SecurityPrivilegeName;
        if (!privId) continue;
        if (!privilegeMap[privId]) {
          privilegeMap[privId] = { id: privId, name: p.SecurityPrivilegeName || privId, roles: new Set() };
        }
        privilegeMap[privId].roles.add(roleId);
      }
      for (const d of duties) {
        const dutyId = d.SecurityDutyIdentifier || d.SecurityDutyName;
        if (!dutyId) continue;
        if (!dutyMap[dutyId]) {
          dutyMap[dutyId] = { id: dutyId, name: d.SecurityDutyName || dutyId, roles: new Set(), privileges: new Set() };
        }
        dutyMap[dutyId].roles.add(roleId);
      }
    }

    // Populate roleMap privileges/duties
    for (const [privId, pr] of Object.entries(privilegeMap)) {
      for (const roleId of pr.roles) {
        if (roleMap[roleId]) roleMap[roleId].privileges.add(pr.name);
      }
    }
    for (const [dutyId, d] of Object.entries(dutyMap)) {
      for (const roleId of d.roles) {
        if (roleMap[roleId]) roleMap[roleId].duties.add(d.name);
      }
    }
  }

  // Score privileges by how many roles they appear in (fewer = more specific) - no extra API calls
  const privScores = Object.values(privilegeMap).map(pr => ({
    id: pr.id, name: pr.name,
    totalEntryPoints: pr.roles.size,
    roles: [...pr.roles].map(id => ({ id, name: roleMap[id]?.roleName || id }))
  }));
  privScores.sort((a, b) => a.totalEntryPoints - b.totalEntryPoints);

  // Score duties - use data we already have, no extra queries
  const dutyScores = Object.values(dutyMap).map(d => ({
    id: d.id, name: d.name,
    totalPrivileges: d.privileges.size,
    roles: [...d.roles].map(id => ({ id, name: roleMap[id]?.roleName || id })),
    privileges: [...d.privileges].map(id => ({ id, name: privilegeMap[id]?.name || id }))
  }));
  dutyScores.sort((a, b) => a.totalPrivileges - b.totalPrivileges || a.roles.length - b.roles.length);

  // Collect needed privileges/duties per menu item (using data from SecurityPrivileges/SecurityRoleDuties)
  const neededPerMenuItem = {};
  for (const mi of presentItems) {
    // Find roles that grant access to this menu item
    const miGrantRoleIds = [...(perMenuItemRoleIds[mi] || [])].filter(id => roleMap[id] && hasAnyGrant(roleMap[id]));
    // Privileges that belong to those granting roles
    const privs = Object.keys(privilegeMap).filter(privId =>
      miGrantRoleIds.some(rid => privilegeMap[privId].roles.has(rid))
    );
    // Duties that belong to those granting roles
    const duts = Object.keys(dutyMap).filter(dutyId =>
      miGrantRoleIds.some(rid => dutyMap[dutyId].roles.has(rid))
    );
    neededPerMenuItem[mi] = {
      privileges: privs.map(id => privilegeMap[id]?.name || id),
      duties: duts.map(id => dutyMap[id]?.name || id)
    };
  }

  // Aggregate all needed privileges/duties
  const allNeededPrivileges = [...new Set(presentItems.flatMap(mi => neededPerMenuItem[mi].privileges))];
  const allNeededDuties = [...new Set(presentItems.flatMap(mi => neededPerMenuItem[mi].duties))];
  const privilegesAreGrant = allNeededPrivileges.length > 0;

  return {
    menuItems: items,
    missing,
    users: userResults,
    recommendedRole: roleScores.length > 0 ? roleScores[0] : null,
    alternativeRoles: roleScores.slice(1),
    commonRolesWithoutAccess: commonRoleInfo,
    commonRolesWithAccess: commonRolesWithFullAccess.map(id => ({
      roleId: id, roleName: roleMap[id].roleName
    })),
    neededPrivileges: allNeededPrivileges,
    neededDuties: allNeededDuties,
    neededPerMenuItem,
    privilegesAreGrant,
    totalCommonRoles: commonRoleIds.length,
    noFullCoverageRole: coverAllRoleIds.length === 0,
    // Narrowest privilege and duty
    narrowestPrivilege: privScores.length > 0 ? privScores[0] : null,
    rankedPrivileges: privScores,
    narrowestDuty: dutyScores.length > 0 ? dutyScores[0] : null,
    rankedDuties: dutyScores
  };
}

// ============ Find Narrowest Role for Multiple Menu Items ============

async function findNarrowestMulti(menuItems, baseUrl, accessLevel) {
  const items = (Array.isArray(menuItems) ? menuItems : menuItems ? [menuItems] : []).map(m => (m || '').trim().toUpperCase()).filter(Boolean);
  if (items.length === 0) throw new Error('No menu items provided');

  // Single item → delegate to existing function
  if (items.length === 1) return await findNarrowestRole(items[0], baseUrl, accessLevel);

  // Step 1: Query SecurityPermissions for ALL menu items
  const perMenuItemPerms = {};
  const perMenuItemRoleIds = {};
  for (const mi of items) {
    const perms = await query(baseUrl, 'SecurityPermissions', `ResourceName eq '${mi}'`, null, 1000);
    perMenuItemPerms[mi] = perms;
    perMenuItemRoleIds[mi] = new Set(perms.map(p => p.SecurityRoleIdentifier));
  }

  // Check which menu items had zero results
  const missing = items.filter(mi => perMenuItemPerms[mi].length === 0);
  if (missing.length === items.length) {
    return {
      menuItems: items,
      noResults: true,
      recommendation: `No security role grants access to any of: ${items.join(', ')}. Custom privileges need to be created.`
    };
  }

  // Step 2: Find roles that appear in ALL menu items (intersection)
  const presentItems = items.filter(mi => perMenuItemPerms[mi].length > 0);
  let commonRoleIds = [...perMenuItemRoleIds[presentItems[0]]];
  for (let i = 1; i < presentItems.length; i++) {
    commonRoleIds = commonRoleIds.filter(id => perMenuItemRoleIds[presentItems[i]].has(id));
  }

  // Step 3: Build role map with merged access across ALL menu items
  const roleMap = {};
  const privilegeMap = {};
  const dutyMap = {};
  const rolePerMenuItem = {}; // roleId → { menuItem → access }

  for (const mi of presentItems) {
    for (const p of perMenuItemPerms[mi]) {
      const roleId = p.SecurityRoleIdentifier;
      const roleName = p.SecurityRoleName || roleId;
      const privId = p.SecurityPrivilegeIdentifier || null;
      const privName = p.SecurityPrivilegeName || privId;
      const dutyId = p.SecurityDutyIdentifier || null;
      const dutyName = p.SecurityDutyName || dutyId;

      if (!roleMap[roleId]) {
        roleMap[roleId] = {
          roleId, roleName,
          ...newAccessMap(),
          privileges: new Set(),
          duties: new Set(),
          menuItemsCovered: new Set()
        };
        rolePerMenuItem[roleId] = {};
      }
      mergeAccess(roleMap[roleId], p);
      roleMap[roleId].menuItemsCovered.add(mi);
      if (privId) roleMap[roleId].privileges.add(privId);
      if (dutyId) roleMap[roleId].duties.add(dutyId);

      // Track per-menu-item access for this role
      if (!rolePerMenuItem[roleId][mi]) rolePerMenuItem[roleId][mi] = newAccessMap();
      mergeAccess(rolePerMenuItem[roleId][mi], p);

      // Build privilege map
      if (privId) {
        const pKey = `${privId}__${mi}`;
        if (!privilegeMap[pKey]) {
          privilegeMap[pKey] = { id: privId, name: privName, menuItem: mi, ...newAccessMap(), roles: new Set(), duties: new Set() };
        }
        mergeAccess(privilegeMap[pKey], p);
        privilegeMap[pKey].roles.add(roleId);
        if (dutyId) privilegeMap[pKey].duties.add(dutyId);
      }

      // Build duty map
      if (dutyId) {
        const dKey = `${dutyId}__${mi}`;
        if (!dutyMap[dKey]) {
          dutyMap[dKey] = { id: dutyId, name: dutyName, menuItem: mi, roles: new Set(), privileges: new Set() };
        }
        dutyMap[dKey].roles.add(roleId);
        if (privId) dutyMap[dKey].privileges.add(privId);
      }
    }
  }

  // Step 4: Filter to roles covering ALL present menu items with Grant
  let candidateRoleIds = commonRoleIds.filter(id => {
    const r = roleMap[id];
    // Must have Grant access for each menu item
    for (const mi of presentItems) {
      const miAccess = rolePerMenuItem[id][mi];
      if (!miAccess) return false;
      if (accessLevel) {
        if (miAccess[accessLevel] !== ACCESS_GRANT) return false;
      } else {
        if (!hasAnyGrant(miAccess)) return false;
      }
    }
    return true;
  });

  // Convert maps for JSON
  const privileges = Object.values(privilegeMap).map(pr => ({
    ...pr,
    roles: [...pr.roles].map(id => ({ id, name: roleMap[id]?.roleName || id })),
    duties: [...pr.duties].map(id => {
      const dKey = `${id}__${pr.menuItem}`;
      return { id, name: dutyMap[dKey]?.name || id };
    })
  }));
  const duties = Object.values(dutyMap).map(d => ({
    ...d,
    roles: [...d.roles].map(id => ({ id, name: roleMap[id]?.roleName || id })),
    privileges: [...d.privileges].map(id => {
      const pKey = `${id}__${d.menuItem}`;
      return { id, name: privilegeMap[pKey]?.name || id };
    })
  }));

  if (candidateRoleIds.length === 0) {
    // No single role covers all - show partial coverage info
    const partialRoles = Object.keys(roleMap)
      .filter(id => hasAnyGrant(roleMap[id]))
      .map(id => ({
        roleId: id,
        roleName: roleMap[id].roleName,
        coveredCount: roleMap[id].menuItemsCovered.size,
        covered: [...roleMap[id].menuItemsCovered],
        ...roleMap[id]
      }))
      .sort((a, b) => b.coveredCount - a.coveredCount);

    return {
      menuItems: items,
      noResults: true,
      missing,
      partialCoverage: true,
      partialRoles: partialRoles.slice(0, 20).map(r => ({
        roleId: r.roleId, roleName: r.roleName,
        coveredCount: r.coveredCount, covered: r.covered,
        totalMenuItems: presentItems.length,
        read: r.read, update: r.update, create: r.create,
        delete: r.delete, invoke: r.invoke, correct: r.correct
      })),
      recommendation: `No single role covers all ${presentItems.length} menu items with ${accessLevel || 'any'} access. ` +
        `Best partial coverage: ${partialRoles[0]?.roleName || 'none'} covers ${partialRoles[0]?.coveredCount || 0}/${presentItems.length}.`,
      privileges,
      duties
    };
  }

  // Step 5: Score and sort candidates
  const roleScores = [];
  for (const roleId of candidateRoleIds) {
    let totalPerms = 0;
    try {
      const countUrl = `${baseUrl}/data/SecurityPermissions?$filter=${encodeURIComponent(`SecurityRoleIdentifier eq '${roleId}'`)}&$count=true&$top=0&cross-company=true`;
      const countData = await odataFetch(countUrl);
      totalPerms = countData['@odata.count'] || 0;
    } catch (e) {
      const sample = await query(baseUrl, 'SecurityPermissions', `SecurityRoleIdentifier eq '${roleId}'`, null, 5000);
      totalPerms = sample.length;
    }

    let userCount = 0;
    try {
      const users = await query(baseUrl, 'SecurityUserRoleAssociations', `SecurityRoleIdentifier eq '${roleId}'`, null, 1000);
      userCount = users.filter(u => !u.AssignmentStatus || u.AssignmentStatus === 'Enabled').length;
    } catch (e) { /* ignore */ }

    const role = roleMap[roleId];
    const perItem = {};
    for (const mi of presentItems) {
      const a = rolePerMenuItem[roleId][mi];
      perItem[mi] = {
        read: a.read, update: a.update, create: a.create,
        delete: a.delete, invoke: a.invoke, correct: a.correct
      };
    }

    roleScores.push({
      roleId, roleName: role.roleName,
      read: role.read, update: role.update, create: role.create,
      delete: role.delete, invoke: role.invoke, correct: role.correct,
      readLabel: accessLabel(role.read), updateLabel: accessLabel(role.update),
      createLabel: accessLabel(role.create), deleteLabel: accessLabel(role.delete),
      invokeLabel: accessLabel(role.invoke), correctLabel: accessLabel(role.correct),
      grantCount: countGrants(role),
      totalPermissions: totalPerms,
      userCount,
      privileges: [...role.privileges],
      duties: [...role.duties],
      menuItemsCovered: [...role.menuItemsCovered],
      perMenuItem: perItem
    });
  }

  roleScores.sort((a, b) => {
    const permDiff = a.totalPermissions - b.totalPermissions;
    if (permDiff !== 0) return permDiff;
    return accessLevel
      ? countGrants(a) - countGrants(b)
      : countGrants(b) - countGrants(a);
  });

  const narrowest = roleScores[0];

  return {
    menuItems: items,
    noResults: false,
    missing,
    roles: roleScores,
    narrowest: {
      roleId: narrowest.roleId, roleName: narrowest.roleName,
      totalPermissions: narrowest.totalPermissions, userCount: narrowest.userCount,
      read: narrowest.read, update: narrowest.update, create: narrowest.create,
      delete: narrowest.delete, invoke: narrowest.invoke, correct: narrowest.correct,
      grantCount: narrowest.grantCount,
      readLabel: narrowest.readLabel, updateLabel: narrowest.updateLabel,
      createLabel: narrowest.createLabel, deleteLabel: narrowest.deleteLabel,
      invokeLabel: narrowest.invokeLabel, correctLabel: narrowest.correctLabel,
      privileges: narrowest.privileges, duties: narrowest.duties,
      menuItemsCovered: narrowest.menuItemsCovered,
      perMenuItem: narrowest.perMenuItem
    },
    totalCandidates: roleScores.length,
    privileges,
    duties
  };
}

// ============ Trace the full chain: Role → Duty → Privilege → Entry Point ============

// Cache discovered entity names so we don't re-discover every time
let cachedDutyPrivEntity = null;
let cachedPrivEntryEntity = null;

async function traceChain(roleId, dutyId, menuItem, baseUrl) {
  const mi = (menuItem || '').toUpperCase();
  const result = {
    roleId,
    dutyId,
    menuItem: mi,
    chain: [],
    dutyPrivileges: null,
    privilegeEntryPoints: null,
    discoveryNeeded: false
  };

  // If we have a dutyId, try to find its privileges
  if (dutyId) {
    // Try known entity names for Duty → Privilege
    const dutyPrivEntities = cachedDutyPrivEntity
      ? [cachedDutyPrivEntity]
      : ['SecurityDutyPrivileges', 'SecurityTaskPrivileges', 'SecurityDutyPrivilegeAssociations',
         'SecurityRolePrivileges'];

    for (const entity of dutyPrivEntities) {
      try {
        // Try filtering by duty
        let data = await query(baseUrl, entity,
          `SecurityDutyIdentifier eq '${dutyId}'`, null, 500);
        if (data.length > 0) {
          cachedDutyPrivEntity = entity;
          result.dutyPrivileges = {
            entity,
            privileges: data.map(p => {
              const obj = {};
              for (const k of Object.keys(p)) {
                if (!k.startsWith('@') && !k.startsWith('odata')) obj[k] = p[k];
              }
              return obj;
            })
          };
          break;
        }
      } catch (e) {
        // Entity doesn't exist or filter failed, try next
      }
    }

    // If no duty→privilege entity found, try getting all privileges for the role
    // and show them all (user can look through them)
    if (!result.dutyPrivileges) {
      const allPrivs = await query(baseUrl, 'SecurityPrivileges',
        `SecurityRoleIdentifier eq '${roleId}'`, null, 2000);
      result.dutyPrivileges = {
        entity: 'SecurityPrivileges (flat role→privilege, no duty link)',
        privileges: allPrivs.map(p => ({
          SecurityPrivilegeIdentifier: p.SecurityPrivilegeIdentifier,
          SecurityPrivilegeName: p.SecurityPrivilegeName
        }))
      };
      result.discoveryNeeded = true;
    }
  }

  // For each privilege found, try to find its entry points
  if (result.dutyPrivileges && result.dutyPrivileges.privileges.length > 0) {
    const privEntryEntities = cachedPrivEntryEntity
      ? [cachedPrivEntryEntity]
      : ['SecurityPrivilegeEntryPoints', 'SecurityPrivilegePermissions',
         'SecurityPrivilegeResources', 'SecurityPrivilegeMenuItems'];

    const firstPriv = result.dutyPrivileges.privileges[0];
    const privId = firstPriv.SecurityPrivilegeIdentifier || '';

    if (privId) {
      for (const entity of privEntryEntities) {
        try {
          const data = await query(baseUrl, entity,
            `SecurityPrivilegeIdentifier eq '${privId}'`, null, 100);
          if (data.length > 0) {
            cachedPrivEntryEntity = entity;
            result.privilegeEntryPoints = {
              entity,
              sample: data.map(p => {
                const obj = {};
                for (const k of Object.keys(p)) {
                  if (!k.startsWith('@') && !k.startsWith('odata')) obj[k] = p[k];
                }
                return obj;
              })
            };
            break;
          }
        } catch (e) {
          // try next
        }
      }
    }
  }

  return result;
}

// ============ Role Inspector: show what a role grants access to ============

async function inspectRole(roleQuery, baseUrl) {
  const q = String(roleQuery || '').trim();
  if (!q) throw new Error('Role query is empty');

  // Step 1: Resolve role - try exact role identifier first, then name contains
  const roleIdUpper = q.toUpperCase();
  let roleMatches = await query(
    baseUrl,
    'SecurityUserRoleAssociations',
    `SecurityRoleIdentifier eq '${roleIdUpper}'`,
    'SecurityRoleIdentifier,SecurityRoleName',
    1
  );

  if (roleMatches.length === 0) {
    // Try searching by role name via SecurityPermissions (broad match)
    const permMatches = await query(
      baseUrl,
      'SecurityPermissions',
      `SecurityRoleName eq '${q.replace(/'/g, "''")}'`,
      'SecurityRoleIdentifier,SecurityRoleName',
      1
    );
    if (permMatches.length > 0) {
      roleMatches = permMatches;
    }
  }

  if (roleMatches.length === 0) {
    return { found: false, query: q };
  }

  const roleId = roleMatches[0].SecurityRoleIdentifier;
  const roleName = roleMatches[0].SecurityRoleName || roleId;

  // Step 2: Run all queries in parallel
  const [permissions, duties, privileges, userAssocs] = await Promise.all([
    query(baseUrl, 'SecurityPermissions', `SecurityRoleIdentifier eq '${roleId}'`, null, 5000),
    query(baseUrl, 'SecurityRoleDuties', `SecurityRoleIdentifier eq '${roleId}'`, 'SecurityDutyIdentifier,SecurityDutyName', 500),
    query(baseUrl, 'SecurityPrivileges', `SecurityRoleIdentifier eq '${roleId}'`, 'SecurityPrivilegeIdentifier,SecurityPrivilegeName', 2000),
    query(baseUrl, 'SecurityUserRoleAssociations', `SecurityRoleIdentifier eq '${roleId}'`, 'UserId,AssignmentStatus', 1000)
  ]);

  // Step 3: Group permissions by menu item
  const menuItems = {};
  for (const p of permissions) {
    const name = p.ResourceName;
    if (!name) continue;
    if (!menuItems[name]) {
      menuItems[name] = {
        resourceName: name,
        resourceType: p.ResourceType,
        ...newAccessMap()
      };
    }
    mergeAccess(menuItems[name], p);
  }

  // Break down by ResourceType
  const byType = {};
  for (const p of permissions) {
    const t = p.ResourceType || 'Unknown';
    byType[t] = (byType[t] || 0) + 1;
  }

  // Active user count
  const activeUsers = userAssocs
    .filter(u => !u.AssignmentStatus || u.AssignmentStatus === 'Enabled')
    .map(u => u.UserId);

  // Deduplicate duties and privileges
  const dutyMap = {};
  for (const d of duties) {
    const id = d.SecurityDutyIdentifier;
    if (id && !dutyMap[id]) dutyMap[id] = d.SecurityDutyName || id;
  }
  const privilegeMap = {};
  for (const p of privileges) {
    const id = p.SecurityPrivilegeIdentifier;
    if (id && !privilegeMap[id]) privilegeMap[id] = p.SecurityPrivilegeName || id;
  }

  // Convert menu items to array, sorted by resource type then name
  const menuItemList = Object.values(menuItems).sort((a, b) => {
    if (a.resourceType !== b.resourceType) {
      return String(a.resourceType).localeCompare(String(b.resourceType));
    }
    return String(a.resourceName).localeCompare(String(b.resourceName));
  });

  return {
    found: true,
    roleId,
    roleName,
    totalPermissions: permissions.length,
    uniqueMenuItems: menuItemList.length,
    duties: Object.entries(dutyMap).map(([id, name]) => ({ id, name })),
    privileges: Object.entries(privilegeMap).map(([id, name]) => ({ id, name })),
    menuItems: menuItemList,
    byType,
    activeUserCount: activeUsers.length,
    sampleUsers: activeUsers.slice(0, 10),
    allUsers: activeUsers
  };
}

// ============ Trace: which privilege in a role grants access to a menu item ============

async function tracePrivilegeForResource(roleId, resourceName, baseUrl) {
  const resUpper = (resourceName || '').toUpperCase();
  const result = {
    roleId,
    resourceName: resUpper,
    subRoles: [],        // precise: subroles that grant this resource
    duties: [],          // duties in role (name-matched against resource)
    privileges: [],      // privileges in role (name-matched against resource)
    method: null,
    error: null,
    attempts: [],
    note: null
  };

  // STEP 1: Check subroles - D365 SubRoles are full roles, we can query SecurityPermissions for each
  try {
    const subRoles = await query(baseUrl, 'SecuritySubRoles',
      `SecurityRoleIdentifier eq '${roleId}'`,
      'SecuritySubRoleIdentifier,SecuritySubRoleName', 200);

    result.attempts.push(`SecuritySubRoles: found ${subRoles.length} sub-roles`);

    if (subRoles.length > 0) {
      // Query each subrole's permissions for this resource (parallel, batched)
      const batchSize = 5;
      for (let i = 0; i < subRoles.length; i += batchSize) {
        const batch = subRoles.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(async sub => {
          try {
            const perms = await query(baseUrl, 'SecurityPermissions',
              `SecurityRoleIdentifier eq '${sub.SecuritySubRoleIdentifier}' and ResourceName eq '${resUpper}'`,
              null, 10);
            return { sub, perms };
          } catch (e) {
            return { sub, perms: [], error: e.message };
          }
        }));

        for (const { sub, perms, error } of batchResults) {
          if (perms && perms.length > 0) {
            // Merge access across multiple permissions for same subrole
            const access = newAccessMap();
            for (const p of perms) mergeAccess(access, p);
            result.subRoles.push({
              subRoleId: sub.SecuritySubRoleIdentifier,
              subRoleName: sub.SecuritySubRoleName || sub.SecuritySubRoleIdentifier,
              resourceType: perms[0].ResourceType,
              ...access
            });
          }
        }
      }
      if (result.subRoles.length > 0) {
        result.method = 'SecuritySubRoles (precise)';
      }
    }
  } catch (e) {
    result.attempts.push(`SecuritySubRoles: error - ${e.message}`);
  }

  // STEP 2a: Narrow-role privilege intersection - find the narrowest role that also has this
  // resource permission; intersect its privileges with the target role's privileges.
  // This gives a PRECISE answer for which privilege(s) grant/deny this resource.
  result.narrowPrivileges = [];
  try {
    const allRoleRows = await query(baseUrl, 'SecurityPermissions',
      `ResourceName eq '${resUpper}'`,
      'SecurityRoleIdentifier,ReadAccess,UpdateAccess,CreateAccess,DeleteAccess,InvokeAccess,CorrectAccess', 500);

    if (allRoleRows.length > 0) {
      // For each role (excluding the target), get total permission count and pick narrowest
      const otherRoleIds = [...new Set(allRoleRows.map(r => r.SecurityRoleIdentifier))].filter(id => id !== roleId);
      result.attempts.push(`Found ${otherRoleIds.length} other roles with this resource`);

      const counts = await Promise.all(otherRoleIds.slice(0, 50).map(async rid => {
        try {
          const count = await queryCount(baseUrl, 'SecurityPermissions',
            `SecurityRoleIdentifier eq '${rid}'`);
          return { rid, count };
        } catch (e) {
          return { rid, count: 99999 };
        }
      }));

      counts.sort((a, b) => a.count - b.count);
      const narrowest = counts.slice(0, 3); // top 3 narrowest roles
      result.narrowestRoleIds = narrowest.map(n => n.rid);

      // Get privileges of the target role
      const targetPrivRows = await query(baseUrl, 'SecurityPrivileges',
        `SecurityRoleIdentifier eq '${roleId}'`,
        'SecurityPrivilegeIdentifier,SecurityPrivilegeName', 2000);
      const targetPrivs = new Map();
      for (const p of targetPrivRows) {
        targetPrivs.set(p.SecurityPrivilegeIdentifier, p.SecurityPrivilegeName || p.SecurityPrivilegeIdentifier);
      }

      // For each narrow role, get its privileges and intersect with target
      const candidates = new Map(); // privId -> { name, narrowRoles: [] }
      for (const n of narrowest) {
        try {
          const nPrivs = await query(baseUrl, 'SecurityPrivileges',
            `SecurityRoleIdentifier eq '${n.rid}'`,
            'SecurityPrivilegeIdentifier,SecurityPrivilegeName', 500);
          const nRoleInfo = allRoleRows.find(r => r.SecurityRoleIdentifier === n.rid);
          const nRoleName = await getRoleName(baseUrl, n.rid);

          for (const p of nPrivs) {
            const pid = p.SecurityPrivilegeIdentifier;
            if (!pid || !targetPrivs.has(pid)) continue;
            if (!candidates.has(pid)) {
              candidates.set(pid, {
                privilegeId: pid,
                privilegeName: p.SecurityPrivilegeName || pid,
                narrowRoles: [],
                narrowRoleCount: 0
              });
            }
            const c = candidates.get(pid);
            c.narrowRoles.push({ roleId: n.rid, roleName: nRoleName, totalPerms: n.count });
            c.narrowRoleCount += 1;
          }
        } catch (e) { /* skip */ }
      }

      result.narrowPrivileges = Array.from(candidates.values())
        .sort((a, b) => {
          // Prefer privileges found in the narrowest role (fewer total perms = more specific)
          const aMin = Math.min(...a.narrowRoles.map(r => r.totalPerms));
          const bMin = Math.min(...b.narrowRoles.map(r => r.totalPerms));
          return aMin - bMin;
        });
      if (result.narrowPrivileges.length > 0) {
        result.method = 'Narrow-role privilege intersection (PRECISE)';
      }
    }
  } catch (e) {
    result.attempts.push(`Narrow-role intersection failed: ${e.message}`);
  }

  // STEP 2b: Get role's duties + privileges (with duty→privilege links via SecurityDuties)
  // SecurityDuties in D365 actually has a SecurityPrivilegeIdentifier column - it's a role+duty+privilege join
  const [dutyPrivRows, rolePrivsFlat] = await Promise.all([
    query(baseUrl, 'SecurityDuties',
      `SecurityRoleIdentifier eq '${roleId}'`,
      'SecurityDutyIdentifier,SecurityDutyName,SecurityPrivilegeIdentifier,SecurityPrivilegeName', 5000),
    query(baseUrl, 'SecurityPrivileges',
      `SecurityRoleIdentifier eq '${roleId}'`,
      'SecurityPrivilegeIdentifier,SecurityPrivilegeName', 2000)
  ]);

  // Build duty → [privileges] map
  const dutyMap = {};
  for (const row of dutyPrivRows) {
    const did = row.SecurityDutyIdentifier;
    if (!did) continue;
    if (!dutyMap[did]) {
      dutyMap[did] = { dutyId: did, dutyName: row.SecurityDutyName || did, privileges: [] };
    }
    if (row.SecurityPrivilegeIdentifier) {
      dutyMap[did].privileges.push({
        privilegeId: row.SecurityPrivilegeIdentifier,
        privilegeName: row.SecurityPrivilegeName || row.SecurityPrivilegeIdentifier
      });
    }
  }

  // All privileges in the role (flat)
  const privMap = {};
  for (const p of rolePrivsFlat) {
    if (p.SecurityPrivilegeIdentifier) {
      privMap[p.SecurityPrivilegeIdentifier] = p.SecurityPrivilegeName || p.SecurityPrivilegeIdentifier;
    }
  }

  // STEP 3: Name-based matching against resource (D365 doesn't expose privilege→resource via OData)
  // Build tokens from resource name: split on underscores and CamelCase
  const resTokens = tokenizeResource(resUpper);

  // Score each privilege
  const privCandidates = [];
  for (const [pid, pname] of Object.entries(privMap)) {
    const score = nameMatchScore(resUpper, resTokens, pid, pname);
    if (score > 0) {
      privCandidates.push({
        privilegeId: pid,
        privilegeName: pname,
        score,
        heuristic: true
      });
    }
  }
  privCandidates.sort((a, b) => b.score - a.score);
  result.privileges = privCandidates.slice(0, 10);

  // Score each duty (also include which of its matched privileges scored)
  const dutyCandidates = [];
  for (const d of Object.values(dutyMap)) {
    const dutyScore = nameMatchScore(resUpper, resTokens, d.dutyId, d.dutyName);
    const matchedPrivs = d.privileges.filter(p => {
      const s = nameMatchScore(resUpper, resTokens, p.privilegeId, p.privilegeName);
      p.score = s;
      return s > 0;
    });
    const totalScore = dutyScore + matchedPrivs.reduce((sum, p) => sum + p.score, 0);
    if (totalScore > 0) {
      dutyCandidates.push({
        dutyId: d.dutyId,
        dutyName: d.dutyName,
        score: totalScore,
        matchedPrivileges: matchedPrivs.sort((a, b) => b.score - a.score).slice(0, 5),
        heuristic: true
      });
    }
  }
  dutyCandidates.sort((a, b) => b.score - a.score);
  result.duties = dutyCandidates.slice(0, 10);

  if (result.subRoles.length > 0) {
    result.note = 'Subrole match is precise (from D365 permission data). Duty/privilege matches below are name-based heuristics - D365 OData does not expose privilege→resource mapping.';
  } else if (result.privileges.length > 0 || result.duties.length > 0) {
    result.method = 'Name-based heuristic';
    result.note = 'D365 OData does not expose privilege→resource mapping. These are best-guess matches based on duty/privilege names containing parts of the resource name.';
  } else {
    result.error = 'No subrole, duty, or privilege name matches this resource. The permission likely comes from role-level direct permissions without a sub-hierarchy.';
  }

  return result;
}

function tokenizeResource(resUpper) {
  // Split on underscores and CamelCase boundaries
  const parts = new Set();
  for (const chunk of resUpper.split(/[_\s]+/)) {
    if (chunk.length >= 4) parts.add(chunk);
  }
  return Array.from(parts);
}

function nameMatchScore(resUpper, resTokens, id, name) {
  const haystack = ((id || '') + ' ' + (name || '')).toUpperCase();
  if (!haystack.trim()) return 0;
  // Exact full match
  if (haystack.includes(resUpper)) return 1000;
  // Partial match on tokens
  let score = 0;
  for (const tok of resTokens) {
    if (haystack.includes(tok)) score += tok.length;
  }
  return score;
}

// ============ Security & License Overview ============
//
// Active users count + license distribution + per-user effective license tier.
// LastLogonDateTime is NOT exposed via OData. Idle-user detection would require
// a Microsoft Graph signInActivity call which is a separate auth path; we expose
// the inventory and CSV export here, with a placeholder note for sign-in data.

const LICENSE_TIER = { 'None': 0, 'Team Members': 1, 'Activity': 2, 'Universal': 3, 'Enterprise': 4 };

async function securityLicenseOverview(baseUrl) {
  // Pull users (only what we need)
  const users = await query(baseUrl, 'SystemUsers', null,
    'UserID,UserName,Enabled,Email,Company,NetworkDomain,AccountType,ExternalUser,PersonName', 5000);

  const enabledUsers = users.filter(u => u.Enabled === true || u.Enabled === 'Yes');
  const disabledUsers = users.filter(u => !(u.Enabled === true || u.Enabled === 'Yes'));

  // Pull user-role assocs (filter Enabled-only client-side because OData enum filter is unreliable)
  const assocs = await query(baseUrl, 'SecurityUserRoleAssociations', null,
    'UserId,SecurityRoleIdentifier,SecurityRoleName,AssignmentStatus', 10000);
  const enabledAssocs = assocs.filter(a => !a.AssignmentStatus || a.AssignmentStatus === 'Enabled');

  // Pull role license types from SecurityPermissions
  // UserLicenseType is a role-level attribute, so we only need distinct (role, license) pairs
  const perms = await query(baseUrl, 'SecurityPermissions', null,
    'SecurityRoleIdentifier,UserLicenseType', 50000);
  const roleLicenseMap = {};
  for (const p of perms) {
    const rid = p.SecurityRoleIdentifier;
    if (!rid) continue;
    const existing = roleLicenseMap[rid];
    const incoming = p.UserLicenseType || 'None';
    if (!existing || (LICENSE_TIER[incoming] || 0) > (LICENSE_TIER[existing] || 0)) {
      roleLicenseMap[rid] = incoming;
    }
  }

  // Per-user effective license = highest tier across all enabled role assignments
  const userIdToInfo = {};
  for (const u of enabledUsers) {
    userIdToInfo[u.UserID] = {
      userId: u.UserID,
      userName: u.UserName || u.PersonName || u.UserID,
      email: u.Email || '',
      company: u.Company || '',
      networkDomain: u.NetworkDomain || '',
      accountType: u.AccountType || '',
      externalUser: u.ExternalUser === true || u.ExternalUser === 'Yes',
      roleCount: 0,
      licenseTier: 'None',
      roles: []
    };
  }

  for (const a of enabledAssocs) {
    const info = userIdToInfo[a.UserId];
    if (!info) continue;
    info.roleCount += 1;
    info.roles.push({ roleId: a.SecurityRoleIdentifier, roleName: a.SecurityRoleName || a.SecurityRoleIdentifier });
    const lic = roleLicenseMap[a.SecurityRoleIdentifier] || 'None';
    if ((LICENSE_TIER[lic] || 0) > (LICENSE_TIER[info.licenseTier] || 0)) {
      info.licenseTier = lic;
    }
  }

  // Aggregate license counts at the USER level (Microsoft licensing rule: highest tier per user)
  const licenseDistribution = {};
  for (const info of Object.values(userIdToInfo)) {
    licenseDistribution[info.licenseTier] = (licenseDistribution[info.licenseTier] || 0) + 1;
  }

  // Account-type breakdown
  const accountTypes = {};
  for (const info of Object.values(userIdToInfo)) {
    const t = info.accountType || 'Unknown';
    accountTypes[t] = (accountTypes[t] || 0) + 1;
  }

  // External vs internal
  const externalCount = Object.values(userIdToInfo).filter(i => i.externalUser).length;

  return {
    generatedAt: new Date().toISOString(),
    baseUrl,
    totals: {
      totalUsers: users.length,
      enabledUsers: enabledUsers.length,
      disabledUsers: disabledUsers.length,
      externalUsers: externalCount,
      internalUsers: enabledUsers.length - externalCount,
      totalRoleAssignments: assocs.length,
      enabledRoleAssignments: enabledAssocs.length
    },
    licenseDistribution,
    accountTypes,
    perUser: Object.values(userIdToInfo).sort((a, b) => a.userId.localeCompare(b.userId)),
    note: 'Last sign-in date is not exposed via D365 OData. To list idle users, integrate Microsoft Graph signInActivity (separate auth scope).'
  };
}

// ============ User × Permission Inventory ============
//
// Cross-join of enabled SystemUsers x enabled SecurityUserRoleAssociations x SecurityPermissions.
// Equivalent to a custom "system user security permissions" data entity, built client-side
// because D365 OData does not expose that joined view natively.

async function userPermissionInventory(baseUrl, userIdFilter, resourceTypeFilter) {
  // Step 1: enabled users only
  const users = await query(baseUrl, 'SystemUsers', null,
    'UserID,UserName,Enabled,Email', 5000);
  let enabledUsers = users.filter(u => u.Enabled === true || u.Enabled === 'Yes');

  if (userIdFilter && userIdFilter.trim()) {
    const needle = userIdFilter.trim().toLowerCase();
    enabledUsers = enabledUsers.filter(u =>
      (u.UserID || '').toLowerCase().includes(needle) ||
      (u.UserName || '').toLowerCase().includes(needle) ||
      (u.Email || '').toLowerCase().includes(needle)
    );
  }

  if (enabledUsers.length === 0) {
    return { generatedAt: new Date().toISOString(), users: [], totalRows: 0,
      message: 'No enabled users matched the filter.' };
  }

  // Step 2: enabled assocs for these users
  const assocs = await query(baseUrl, 'SecurityUserRoleAssociations', null,
    'UserId,SecurityRoleIdentifier,SecurityRoleName,AssignmentStatus', 10000);
  const enabledIds = new Set(enabledUsers.map(u => u.UserID));
  const userAssocs = assocs.filter(a =>
    enabledIds.has(a.UserId) && (!a.AssignmentStatus || a.AssignmentStatus === 'Enabled')
  );

  // Group roles per user
  const userToRoles = {};
  for (const a of userAssocs) {
    if (!userToRoles[a.UserId]) userToRoles[a.UserId] = [];
    userToRoles[a.UserId].push({ roleId: a.SecurityRoleIdentifier, roleName: a.SecurityRoleName });
  }

  // Step 3: collect distinct roles, fetch permissions for each (batched)
  const allRoleIds = [...new Set(userAssocs.map(a => a.SecurityRoleIdentifier).filter(Boolean))];
  const rolePerms = {};

  const batchSize = 5;
  for (let i = 0; i < allRoleIds.length; i += batchSize) {
    const batch = allRoleIds.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async rid => {
      try {
        const perms = await query(baseUrl, 'SecurityPermissions',
          `SecurityRoleIdentifier eq '${rid}'`,
          'SecurityRoleIdentifier,ResourceName,ResourceType,ReadAccess,UpdateAccess,CreateAccess,DeleteAccess,InvokeAccess,CorrectAccess,UserLicenseType',
          5000);
        return { rid, perms };
      } catch (e) {
        return { rid, perms: [], error: e.message };
      }
    }));
    for (const { rid, perms } of results) {
      rolePerms[rid] = perms;
    }
  }

  // Step 4: build per-user resource matrix with effective access (Deny wins, Grant fills Unset)
  const userInventory = [];
  let totalRows = 0;

  for (const u of enabledUsers) {
    const rolesForUser = userToRoles[u.UserID] || [];
    const resourceMap = {};

    for (const r of rolesForUser) {
      const perms = rolePerms[r.roleId] || [];
      for (const p of perms) {
        if (resourceTypeFilter && resourceTypeFilter !== 'All' && p.ResourceType !== resourceTypeFilter) continue;
        const key = `${p.ResourceType}|${p.ResourceName}`;
        if (!resourceMap[key]) {
          resourceMap[key] = {
            resourceName: p.ResourceName,
            resourceType: p.ResourceType,
            read: 0, update: 0, create: 0, delete: 0, invoke: 0, correct: 0,
            grantingRoles: []
          };
        }
        const slot = resourceMap[key];
        slot.read = mergeAccessField(slot.read, p.ReadAccess || 0);
        slot.update = mergeAccessField(slot.update, p.UpdateAccess || 0);
        slot.create = mergeAccessField(slot.create, p.CreateAccess || 0);
        slot.delete = mergeAccessField(slot.delete, p.DeleteAccess || 0);
        slot.invoke = mergeAccessField(slot.invoke, p.InvokeAccess || 0);
        slot.correct = mergeAccessField(slot.correct, p.CorrectAccess || 0);
        if (!slot.grantingRoles.find(x => x.roleId === r.roleId)) {
          slot.grantingRoles.push({ roleId: r.roleId, roleName: r.roleName });
        }
      }
    }

    const resources = Object.values(resourceMap);
    totalRows += resources.length;

    userInventory.push({
      userId: u.UserID,
      userName: u.UserName || u.UserID,
      email: u.Email || '',
      roleCount: rolesForUser.length,
      roles: rolesForUser,
      resourceCount: resources.length,
      resources
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    totalUsers: enabledUsers.length,
    totalRows,
    users: userInventory.sort((a, b) => a.userId.localeCompare(b.userId))
  };
}
