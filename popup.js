// D365 Who Has Access - Popup (God Tier Edition)

let currentData = null;
let currentPage = null;
let activeFilter = 'all';

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, resp => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (resp && resp.error) return reject(new Error(resp.error));
      resolve(resp);
    });
  });
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// D365 access: 0=Unset, 1=Grant, 2=Deny. Deny wins over Grant wins over Unset.
function mergeField(current, incoming) {
  if (incoming === 2) return 2;
  if (incoming === 1 && current !== 2) return 1;
  return current;
}

// ============ Init ============

let lastDetectedMenuItem = null;

async function detectAndLoad() {
  const envBar = document.getElementById('envBar');
  const results = document.getElementById('results');
  const loading = document.getElementById('loading');

  try {
    const page = await send({ action: 'getPageInfo' });

    if (!page.menuItem) {
      // Only update if state actually changed
      if (lastDetectedMenuItem !== '') {
        lastDetectedMenuItem = '';
        envBar.className = 'env-bar error';
        envBar.textContent = 'Not on a D365 form (no menu item in URL)';
        loading.classList.add('hidden');
        results.innerHTML = `<div class="no-results">
          <h3>No menu item detected</h3>
          <p>Navigate to a D365 form first, then click this extension.</p>
        </div>`;
      }
      return;
    }

    // Skip if same page already loaded
    const pageKey = `${page.d365Url}|${page.company}|${page.menuItem}`;
    if (pageKey === lastDetectedMenuItem) return;
    lastDetectedMenuItem = pageKey;

    let hostname = page.d365Url;
    try { hostname = new URL(page.d365Url).hostname; } catch (e) {}
    envBar.textContent = `${hostname} | ${page.company} | ${page.menuItem}`;
    envBar.className = 'env-bar';

    loading.classList.remove('hidden');
    document.getElementById('loadingText').textContent =
      `Scanning permissions for ${page.menuItem}...`;

    const data = await send({ action: 'analyze', menuItem: page.menuItem, baseUrl: page.d365Url });
    loading.classList.add('hidden');

    if (data.noResults) {
      results.innerHTML = `<div class="no-results">
        <h3>No permissions found</h3>
        <p>Could not find any role with access to <code>${esc(page.menuItem)}</code>.</p>
      </div>`;
      return;
    }

    currentData = data;
    currentPage = page;
    renderResults(page, data);

  } catch (err) {
    loading.classList.add('hidden');
    envBar.className = 'env-bar error';
    const msg = err.message || String(err);
    if (msg.includes('403') || msg.includes('not authorized')) {
      envBar.textContent = 'Access Denied';
      results.innerHTML = `<div class="error-box">
        <strong>403 - Not authorized to read SecurityPermissions</strong><br><br>
        You need <strong>System Administrator</strong> or <strong>Security Administrator</strong> role on this environment.
      </div>`;
    } else {
      envBar.textContent = msg;
      results.innerHTML = `<div class="error-box">${esc(msg)}</div>`;
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  wireNarrowSearch();
  detectAndLoad();

  // Re-detect when user navigates within a tab
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === 'complete') {
      detectAndLoad();
    }
  });

  // Re-detect when user switches tabs
  chrome.tabs.onActivated.addListener(() => {
    detectAndLoad();
  });
});

// ============ Main Render ============

function renderResults(page, data) {
  const results = document.getElementById('results');
  const c = data.counts || {};

  // Compute security insights
  const readOnly = data.users.filter(u => u.read === 1 && u.update !== 1 && u.create !== 1 && u.delete !== 1);
  const fullCrud = data.users.filter(u => u.read === 1 && u.update === 1 && u.create === 1 && u.delete === 1);
  const canDelete = data.users.filter(u => u.delete === 1);

  let html = '';

  // Header
  html += `<div class="mi-header">
    <h2>${esc(page.title || page.menuItem)}</h2>
    <div class="mi-name">${esc(page.menuItem)}</div>
  </div>`;

  // Summary cards
  html += `<div class="summary">
    <div class="summary-item">
      <div class="num">${data.users.length}</div>
      <div class="label">Users</div>
    </div>
    <div class="summary-item">
      <div class="num">${data.totalRoles}</div>
      <div class="label">Roles</div>
    </div>
    <div class="summary-item compare-trigger" id="compareBtn">
      <div class="num" style="font-size:16px">vs</div>
      <div class="label">Compare</div>
    </div>
    <div class="summary-item crossenv-trigger" id="crossEnvBtn">
      <div class="num" style="font-size:16px">ENV</div>
      <div class="label">Cross-Env</div>
    </div>
    <div class="summary-item export-trigger" id="exportBtn">
      <div class="num" style="font-size:16px">CSV</div>
      <div class="label">Export</div>
    </div>
  </div>`;

  // Security insights bar
  html += `<div class="insights-bar">`;
  if (readOnly.length) html += `<span class="insight insight-blue">${readOnly.length} read-only</span>`;
  if (fullCrud.length) html += `<span class="insight insight-purple">${fullCrud.length} full CRUD</span>`;
  if (canDelete.length) html += `<span class="insight insight-red">${canDelete.length} can delete</span>`;
  if (data.licenseCounts) {
    for (const [tier, count] of Object.entries(data.licenseCounts).sort((a, b) => b[1] - a[1])) {
      if (!count) continue;
      const colorMap = { 'Enterprise': '#a4262c', 'Universal': '#0078d4', 'Activity': '#8a6d00', 'Team Members': '#605e5c', 'None': '#a19f9d' };
      const bg = colorMap[tier] || '#605e5c';
      html += `<span class="insight" style="background:${bg};color:#fff;">${count} ${esc(tier)}</span>`;
    }
  }
  html += `</div>`;

  // Access filter buttons
  html += `<div class="access-buttons" id="accessButtons">`;
  html += `<button class="access-btn active" data-filter="all">All (${data.users.length})</button>`;
  if (c.read) html += `<button class="access-btn btn-read" data-filter="read">Read (${c.read})</button>`;
  if (c.update) html += `<button class="access-btn btn-update" data-filter="update">Update (${c.update})</button>`;
  if (c.create) html += `<button class="access-btn btn-create" data-filter="create">Create (${c.create})</button>`;
  if (c.delete) html += `<button class="access-btn btn-delete" data-filter="delete">Delete (${c.delete})</button>`;
  if (c.invoke) html += `<button class="access-btn btn-invoke" data-filter="invoke">Invoke (${c.invoke})</button>`;
  html += `</div>`;

  // Search
  html += `<input type="text" class="filter-input" id="userFilter" placeholder="Filter users or roles...">`;

  // Compare panel (hidden by default)
  html += `<div id="comparePanel" class="compare-panel hidden">
    <div class="compare-header">
      <span class="compare-title">Compare Users</span>
      <button class="compare-close" id="compareClose">Back</button>
    </div>
    <div class="compare-input-row">
      <input type="text" class="filter-input" id="compareInput"
        placeholder="User IDs separated by commas (e.g. jsmith, adavis)">
      <button class="compare-go" id="compareGo">Compare</button>
    </div>
    <div id="compareResults"></div>
  </div>`;

  // Cross-env compare panel (hidden by default)
  html += `<div id="crossEnvPanel" class="cross-env-panel hidden">
    <div class="compare-header">
      <span class="compare-title">Cross-Environment Compare</span>
      <button class="compare-close" id="crossEnvClose">Back</button>
    </div>
    <div class="crossenv-form">
      <div class="crossenv-row">
        <label class="crossenv-label">Environment B</label>
        <div class="crossenv-select-row">
          <select class="crossenv-select" id="crossEnvSelect">
            <option value="">-- Select environment --</option>
          </select>
          <button class="crossenv-manage-btn" id="crossEnvManage">Manage</button>
        </div>
      </div>
      <div class="crossenv-row">
        <label class="crossenv-label">User ID</label>
        <input type="text" class="filter-input" id="crossEnvUserId" placeholder="e.g. jsmith" style="margin-bottom:0">
      </div>
      <button class="compare-go crossenv-go" id="crossEnvGo">Compare Environments</button>
    </div>
    <div id="crossEnvSettings" class="crossenv-settings hidden"></div>
    <div id="crossEnvResults"></div>
  </div>`;

  // User list
  html += `<div id="userList"></div>`;

  results.innerHTML = html;
  renderUserList();
  wireEvents(results);
}

function wireEvents(results) {
  // Access filter buttons
  document.querySelectorAll('.access-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.access-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      renderUserList();
    });
  });

  // Search - filter by user ID or role name
  document.getElementById('userFilter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.role-group').forEach(group => {
      const roleNames = (group.querySelector('.role-group-names')?.textContent || '').toLowerCase();
      let anyVisible = false;
      group.querySelectorAll('.grouped-user').forEach(user => {
        const match = !q || (user.dataset.userid || '').toLowerCase().includes(q) || roleNames.includes(q);
        user.style.display = match ? '' : 'none';
        if (match) anyVisible = true;
      });
      // Also show group if role name matches even if no user matches
      if (!q || roleNames.includes(q)) anyVisible = true;
      group.style.display = anyVisible ? '' : 'none';
    });
  });

  // Compare
  document.getElementById('compareBtn').addEventListener('click', () => toggleComparePanel(true));
  document.getElementById('compareClose').addEventListener('click', () => toggleComparePanel(false));
  document.getElementById('compareGo').addEventListener('click', runCompare);
  document.getElementById('compareInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runCompare();
  });

  // Cross-env compare
  document.getElementById('crossEnvBtn').addEventListener('click', () => toggleCrossEnvPanel(true));
  document.getElementById('crossEnvClose').addEventListener('click', () => toggleCrossEnvPanel(false));
  document.getElementById('crossEnvGo').addEventListener('click', runCrossEnvCompare);
  document.getElementById('crossEnvManage').addEventListener('click', showEnvSettings);
  document.getElementById('crossEnvUserId').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runCrossEnvCompare();
  });
  loadEnvironments();

  // Export CSV
  document.getElementById('exportBtn').addEventListener('click', exportCSV);

  // Click user chips to add to compare
  results.addEventListener('click', (e) => {
    const chip = e.target.closest('.grouped-user');
    if (!chip) return;
    chip.classList.toggle('selected');
    updateCompareFromSelection();
  });
}

// ============ Export CSV ============

function exportCSV() {
  if (!currentData) return;
  const rows = [['User ID', 'Read', 'Update', 'Create', 'Delete', 'Roles']];
  for (const u of currentData.users) {
    rows.push([
      u.userId,
      u.read === 1 ? 'Grant' : u.read === 2 ? 'Deny' : '',
      u.update === 1 ? 'Grant' : u.update === 2 ? 'Deny' : '',
      u.create === 1 ? 'Grant' : u.create === 2 ? 'Deny' : '',
      u.delete === 1 ? 'Grant' : u.delete === 2 ? 'Deny' : '',
      (u.roles || []).join('; ')
    ]);
  }
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentData.menuItem}_access_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ============ Compare ============

function updateCompareFromSelection() {
  const selected = document.querySelectorAll('.grouped-user.selected');
  const ids = [...new Set(Array.from(selected).map(el => el.dataset.userid))];
  const input = document.getElementById('compareInput');
  if (input) input.value = ids.join(', ');
  if (ids.length >= 2) toggleComparePanel(true);
}

function toggleComparePanel(show) {
  const panel = document.getElementById('comparePanel');
  const userList = document.getElementById('userList');
  const accessBtns = document.getElementById('accessButtons');
  const userFilter = document.getElementById('userFilter');

  if (show) {
    panel.classList.remove('hidden');
    userList.classList.add('hidden');
    accessBtns.classList.add('hidden');
    userFilter.classList.add('hidden');
    document.getElementById('compareInput').focus();
  } else {
    panel.classList.add('hidden');
    userList.classList.remove('hidden');
    accessBtns.classList.remove('hidden');
    userFilter.classList.remove('hidden');
  }
}

async function runCompare() {
  const input = document.getElementById('compareInput').value.trim();
  const container = document.getElementById('compareResults');
  if (!input) return;

  const userIds = input.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  if (userIds.length < 2) {
    container.innerHTML = '<div class="drill-error">Enter at least 2 user IDs.</div>';
    return;
  }
  if (userIds.length > 5) {
    container.innerHTML = '<div class="drill-error">Maximum 5 users.</div>';
    return;
  }

  container.innerHTML = '<div class="drill-loading"><div class="spinner-sm"></div> Comparing...</div>';

  try {
    const data = await send({
      action: 'compareUsers',
      userIds,
      menuItem: currentData.menuItem,
      baseUrl: currentPage.d365Url
    });
    renderCompareResults(data, container);
  } catch (err) {
    container.innerHTML = `<div class="drill-error">${esc(err.message)}</div>`;
  }
}

function renderCompareResults(data, container) {
  const users = data.users;
  let html = '';

  // Access table
  html += `<table class="compare-table">`;
  html += `<thead><tr><th>User</th><th>R</th><th>U</th><th>C</th><th>D</th><th>Roles</th></tr></thead>`;
  html += `<tbody>`;
  for (const u of users) {
    const a = u.access;
    html += `<tr class="${u.hasAccess ? '' : 'no-access-row'}">`;
    html += `<td class="compare-user">${esc(u.userId)}</td>`;
    html += `<td class="compare-cell ${a.read===1?'cell-yes':a.read===2?'cell-deny':'cell-no'}">${a.read===1?'G':a.read===2?'D':'-'}</td>`;
    html += `<td class="compare-cell ${a.update===1?'cell-yes':a.update===2?'cell-deny':'cell-no'}">${a.update===1?'G':a.update===2?'D':'-'}</td>`;
    html += `<td class="compare-cell ${a.create===1?'cell-yes':a.create===2?'cell-deny':'cell-no'}">${a.create===1?'G':a.create===2?'D':'-'}</td>`;
    html += `<td class="compare-cell ${a.delete===1?'cell-yes':a.delete===2?'cell-deny':'cell-no'}">${a.delete===1?'G':a.delete===2?'D':'-'}</td>`;
    html += `<td class="compare-roles-count">${u.totalRoles} total</td>`;
    html += `</tr>`;
  }
  html += `</tbody></table>`;

  // Role matrix
  const allGrantingRoleIds = new Set();
  for (const u of users) for (const r of u.grantingRoles) allGrantingRoleIds.add(r.roleId);

  if (allGrantingRoleIds.size > 0) {
    html += `<div class="compare-section-title">Roles granting access to ${esc(data.menuItem)}</div>`;
    html += `<table class="compare-table roles-table">`;
    html += `<thead><tr><th>Role</th>`;
    for (const u of users) html += `<th>${esc(u.userId)}</th>`;
    html += `</tr></thead><tbody>`;
    for (const roleId of allGrantingRoleIds) {
      let roleName = roleId;
      for (const u of users) {
        const found = u.grantingRoles.find(r => r.roleId === roleId);
        if (found) { roleName = found.roleName; break; }
      }
      html += `<tr><td class="compare-role-name">${esc(roleName)}</td>`;
      for (const u of users) {
        const has = u.grantingRoles.some(r => r.roleId === roleId);
        html += `<td class="compare-cell ${has ? 'cell-yes' : 'cell-no'}">${has ? 'Y' : '-'}</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table>`;
  }

  // Differences
  html += `<div class="compare-section-title">Differences</div>`;
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const uniqueRoles = u.grantingRoles.filter(r =>
      !users.some((other, j) => j !== i && other.grantingRoles.some(or => or.roleId === r.roleId))
    );
    if (uniqueRoles.length > 0) {
      html += `<div class="compare-unique">`;
      html += `<span class="compare-unique-user">${esc(u.userId)}</span> unique: `;
      html += uniqueRoles.map(r => `<span class="badge badge-read">${esc(r.roleName)}</span>`).join(' ');
      html += `</div>`;
    }
    if (!u.hasAccess) {
      html += `<div class="compare-unique">`;
      html += `<span class="compare-unique-user">${esc(u.userId)}</span> `;
      html += `<span class="badge badge-delete">No access</span>`;
      html += `</div>`;
    }
  }

  container.innerHTML = html;
}

// ============ Cross-Environment Compare ============

let savedEnvironments = [];

async function loadEnvironments() {
  try {
    const data = await send({ action: 'getEnvironments' });
    savedEnvironments = data.environments || [];
    populateEnvDropdown();
  } catch (e) {
    savedEnvironments = [];
  }
}

function populateEnvDropdown() {
  const select = document.getElementById('crossEnvSelect');
  if (!select) return;
  // Keep the default option
  select.innerHTML = '<option value="">-- Select environment --</option>';
  for (const env of savedEnvironments) {
    // Skip current environment
    if (currentPage && env.url === currentPage.d365Url) continue;
    select.innerHTML += `<option value="${esc(env.url)}">${esc(env.name)}</option>`;
  }
}

function toggleCrossEnvPanel(show) {
  const panel = document.getElementById('crossEnvPanel');
  const userList = document.getElementById('userList');
  const accessBtns = document.getElementById('accessButtons');
  const userFilter = document.getElementById('userFilter');
  const comparePanel = document.getElementById('comparePanel');
  const insightsBar = document.querySelector('.insights-bar');

  if (show) {
    panel.classList.remove('hidden');
    userList.classList.add('hidden');
    accessBtns.classList.add('hidden');
    userFilter.classList.add('hidden');
    comparePanel.classList.add('hidden');
    if (insightsBar) insightsBar.classList.add('hidden');
    populateEnvDropdown();
  } else {
    panel.classList.add('hidden');
    userList.classList.remove('hidden');
    accessBtns.classList.remove('hidden');
    userFilter.classList.remove('hidden');
    if (insightsBar) insightsBar.classList.remove('hidden');
    // Hide settings too
    document.getElementById('crossEnvSettings').classList.add('hidden');
  }
}

function showEnvSettings() {
  const container = document.getElementById('crossEnvSettings');
  container.classList.remove('hidden');

  let html = '<div class="env-settings-title">Saved Environments</div>';

  if (savedEnvironments.length === 0) {
    html += '<div class="drill-empty">No environments saved yet.</div>';
  } else {
    for (let i = 0; i < savedEnvironments.length; i++) {
      const env = savedEnvironments[i];
      const isCurrent = currentPage && env.url === currentPage.d365Url;
      html += `<div class="env-list-item ${isCurrent ? 'env-current' : ''}">`;
      html += `<div class="env-list-info">`;
      html += `<span class="env-list-name">${esc(env.name)}</span>`;
      html += `<span class="env-list-url">${esc(env.url)}</span>`;
      html += `</div>`;
      html += `<button class="env-delete-btn" data-idx="${i}">X</button>`;
      html += `</div>`;
    }
  }

  html += `<div class="env-add-row">
    <input type="text" class="env-add-input" id="envAddName" placeholder="Name (e.g. UAT)">
    <input type="text" class="env-add-input env-add-url" id="envAddUrl" placeholder="URL (e.g. https://xxx.operations.dynamics.com)">
    <button class="compare-go" id="envAddBtn">Add</button>
  </div>`;
  html += `<button class="crossenv-save-current" id="envSaveCurrent">+ Save current environment</button>`;

  container.innerHTML = html;

  // Wire add button
  document.getElementById('envAddBtn').addEventListener('click', addEnvironment);
  document.getElementById('envSaveCurrent').addEventListener('click', saveCurrentEnv);

  // Wire delete buttons
  container.querySelectorAll('.env-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.idx);
      const removed = savedEnvironments.splice(idx, 1);
      try {
        await send({ action: 'saveEnvironments', environments: savedEnvironments });
      } catch (e) {
        savedEnvironments.splice(idx, 0, ...removed); // Undo
      }
      showEnvSettings();
      populateEnvDropdown();
    });
  });
}

async function addEnvironment() {
  const nameInput = document.getElementById('envAddName');
  const urlInput = document.getElementById('envAddUrl');
  const name = nameInput.value.trim();
  let url = urlInput.value.trim();
  if (!name || !url) return;

  // Validate and normalize URL
  try {
    const urlObj = new URL(url.startsWith('http') ? url : 'https://' + url);
    url = urlObj.origin;
    if (!url.includes('.dynamics.com') && !url.includes('localhost') && !url.includes('127.0.0.1')) {
      urlInput.style.borderColor = '#d13438';
      return;
    }
  } catch (e) {
    urlInput.style.borderColor = '#d13438';
    return;
  }

  // Check for duplicates
  if (savedEnvironments.some(e => e.url === url)) {
    urlInput.style.borderColor = '#d13438';
    return;
  }

  savedEnvironments.push({ name, url });
  try {
    await send({ action: 'saveEnvironments', environments: savedEnvironments });
    nameInput.value = '';
    urlInput.value = '';
    urlInput.style.borderColor = '';
    showEnvSettings();
    populateEnvDropdown();
  } catch (err) {
    savedEnvironments.pop();
  }
}

async function saveCurrentEnv() {
  if (!currentPage) return;
  const url = currentPage.d365Url;
  if (savedEnvironments.some(e => e.url === url)) return; // Already saved

  // Auto-name from hostname
  let name = 'Current';
  try {
    const h = new URL(url).hostname;
    // Extract meaningful part (e.g., "contoso-prod" from "contoso-prod.operations.eu.dynamics.com")
    name = h.split('.')[0].toUpperCase();
  } catch (e) {}

  savedEnvironments.push({ name, url });
  await send({ action: 'saveEnvironments', environments: savedEnvironments });
  showEnvSettings();
  populateEnvDropdown();
}

async function runCrossEnvCompare() {
  const select = document.getElementById('crossEnvSelect');
  const userIdInput = document.getElementById('crossEnvUserId');
  const container = document.getElementById('crossEnvResults');

  const baseUrlB = select.value;
  const userId = userIdInput.value.trim();
  const envNameB = select.options[select.selectedIndex]?.text || '';

  if (!baseUrlB) {
    container.innerHTML = '<div class="drill-error">Select an environment to compare against.</div>';
    return;
  }
  if (!userId) {
    container.innerHTML = '<div class="drill-error">Enter a User ID.</div>';
    return;
  }

  // Get current env name
  let envNameA = 'Current';
  try { envNameA = new URL(currentPage.d365Url).hostname.split('.')[0].toUpperCase(); } catch (e) {}

  container.innerHTML = '<div class="drill-loading"><div class="spinner-sm"></div> Comparing across environments...</div>';

  try {
    const data = await send({
      action: 'compareEnvironments',
      userId,
      menuItem: currentData.menuItem,
      baseUrlA: currentPage.d365Url,
      baseUrlB,
      envNameA,
      envNameB
    });
    renderCrossEnvResults(data, container);
  } catch (err) {
    let msg = err.message || String(err);
    if (msg.includes('401') || msg.includes('403')) {
      msg = `Not logged into ${envNameB}. Open a tab to that environment and log in first.`;
    }
    container.innerHTML = `<div class="drill-error">${esc(msg)}</div>`;
  }
}

function renderCrossEnvResults(data, container) {
  let html = '';
  const a = data.envA, b = data.envB;

  // Error from either environment
  if (a.error) {
    html += `<div class="drill-error">${esc(a.name)}: ${esc(a.error.includes('401') || a.error.includes('403') ? 'Not logged in - open a tab and log in first.' : a.error)}</div>`;
  }
  if (b.error) {
    html += `<div class="drill-error">${esc(b.name)}: ${esc(b.error.includes('401') || b.error.includes('403') ? 'Not logged in - open a tab and log in first.' : b.error)}</div>`;
  }
  if (a.error || b.error) {
    container.innerHTML = html;
    return;
  }

  // User not found in either env - show and stop
  if (!a.userFound || !b.userFound) {
    if (!a.userFound) html += `<div class="drill-error">User "${esc(data.userId)}" not found in ${esc(a.name)}.</div>`;
    if (!b.userFound) html += `<div class="drill-error">User "${esc(data.userId)}" not found in ${esc(b.name)}.</div>`;
    container.innerHTML = html;
    return;
  }

  // Header
  html += `<div class="crossenv-result-header">${esc(data.userId)} - ${esc(data.menuItem)}</div>`;

  // Access comparison table
  html += `<div class="compare-section-title">Page Access</div>`;
  html += `<table class="compare-table">`;
  html += `<thead><tr><th></th><th>${esc(a.name)}</th><th>${esc(b.name)}</th><th></th></tr></thead>`;
  html += `<tbody>`;
  const labels = { read: 'Read', update: 'Update', create: 'Create', delete: 'Delete' };
  if (data.accessDiff) {
    for (const [key, label] of Object.entries(labels)) {
      const d = data.accessDiff[key];
      html += `<tr>`;
      html += `<td class="compare-role-name">${label}</td>`;
      html += `<td class="compare-cell ${d.a===1?'cell-yes':d.a===2?'cell-deny':'cell-no'}">${d.a===1?'G':d.a===2?'D':'-'}</td>`;
      html += `<td class="compare-cell ${d.b===1?'cell-yes':d.b===2?'cell-deny':'cell-no'}">${d.b===1?'G':d.b===2?'D':'-'}</td>`;
      html += `<td class="compare-cell">${d.changed ? '<span class="diff-indicator">DIFF</span>' : ''}</td>`;
      html += `</tr>`;
    }
  }
  html += `<tr>`;
  html += `<td class="compare-role-name">Total Roles</td>`;
  html += `<td class="compare-cell">${a.totalRoles || 0}</td>`;
  html += `<td class="compare-cell">${b.totalRoles || 0}</td>`;
  html += `<td class="compare-cell">${(a.totalRoles || 0) !== (b.totalRoles || 0) ? '<span class="diff-indicator">DIFF</span>' : ''}</td>`;
  html += `</tr>`;
  html += `</tbody></table>`;

  // Granting roles comparison for this menu item
  if (data.grantingDiff && data.grantingDiff.length > 0) {
    html += `<div class="compare-section-title">Roles granting access to ${esc(data.menuItem)}</div>`;
    html += `<table class="compare-table">`;
    html += `<thead><tr><th>Role</th><th>${esc(a.name)}</th><th>${esc(b.name)}</th></tr></thead>`;
    html += `<tbody>`;
    for (const r of data.grantingDiff) {
      html += `<tr>`;
      html += `<td class="compare-role-name">${esc(r.roleName)}</td>`;
      html += `<td class="compare-cell ${r.inA ? 'cell-yes' : 'cell-no'}">${r.inA ? 'Y' : '-'}</td>`;
      html += `<td class="compare-cell ${r.inB ? 'cell-yes' : 'cell-no'}">${r.inB ? 'Y' : '-'}</td>`;
      html += `</tr>`;
    }
    html += `</tbody></table>`;
  }

  // Role differences (ALL roles, not just granting)
  if (data.roleDiff) {
    const rd = data.roleDiff;

    if (rd.onlyInA.length > 0) {
      html += `<div class="compare-section-title">Only in ${esc(a.name)} (${rd.onlyInA.length})</div>`;
      html += `<div class="crossenv-role-list">`;
      for (const r of rd.onlyInA) {
        html += `<span class="badge badge-only-a">${esc(r.roleName)}</span>`;
      }
      html += `</div>`;
    }

    if (rd.onlyInB.length > 0) {
      html += `<div class="compare-section-title">Only in ${esc(b.name)} (${rd.onlyInB.length})</div>`;
      html += `<div class="crossenv-role-list">`;
      for (const r of rd.onlyInB) {
        html += `<span class="badge badge-only-b">${esc(r.roleName)}</span>`;
      }
      html += `</div>`;
    }

    if (rd.common.length > 0) {
      html += `<div class="compare-section-title crossenv-common-toggle" id="commonToggle">Common roles (${rd.common.length}) ▸</div>`;
      html += `<div class="crossenv-role-list hidden" id="commonRolesList">`;
      for (const r of rd.common) {
        html += `<span class="badge badge-common">${esc(r.roleName)}</span>`;
      }
      html += `</div>`;
    }

    // "Go Deeper" button - compare duties & privileges inside each role
    const allRoleIds = [...rd.common, ...rd.onlyInA, ...rd.onlyInB].map(r => r.roleId);
    if (allRoleIds.length > 0) {
      html += `<div class="deep-compare-bar">`;
      html += `<button class="compare-go deep-compare-btn" id="deepCompareBtn"
        data-roleids="${esc(allRoleIds.join(','))}"
        data-urla="${esc(data.envA.url)}"
        data-urlb="${esc(data.envB.url)}"
        data-namea="${esc(data.envA.name)}"
        data-nameb="${esc(data.envB.name)}">Go Deeper - Compare Duties &amp; Privileges</button>`;
      html += `</div>`;
      html += `<div id="deepCompareResults"></div>`;
    }
  }

  container.innerHTML = html;

  // Wire common roles toggle
  const toggle = document.getElementById('commonToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const list = document.getElementById('commonRolesList');
      list.classList.toggle('hidden');
      toggle.textContent = list.classList.contains('hidden')
        ? `Common roles (${data.roleDiff.common.length}) ▸`
        : `Common roles (${data.roleDiff.common.length}) ▾`;
    });
  }

  // Wire "Go Deeper" button
  const deepBtn = document.getElementById('deepCompareBtn');
  if (deepBtn) {
    deepBtn.addEventListener('click', () => runDeepCompare(deepBtn));
  }
}

// ============ Deep Compare - Duties & Privileges per role ============

async function runDeepCompare(btn) {
  const roleIds = btn.dataset.roleids.split(',').filter(Boolean);
  const baseUrlA = btn.dataset.urla;
  const baseUrlB = btn.dataset.urlb;
  const envNameA = btn.dataset.namea;
  const envNameB = btn.dataset.nameb;
  const container = document.getElementById('deepCompareResults');
  if (!container) return;

  btn.disabled = true;
  btn.textContent = 'Comparing duties & privileges...';
  container.innerHTML = `<div class="drill-loading"><div class="spinner-sm"></div> Querying ${roleIds.length} roles across both environments...</div>`;

  try {
    const data = await send({
      action: 'deepCompareRoles',
      roleIds,
      baseUrlA,
      baseUrlB,
      envNameA,
      envNameB
    });
    renderDeepCompareResults(data, container);
    btn.classList.add('hidden');
  } catch (err) {
    container.innerHTML = `<div class="drill-error">${esc(err.message)}</div>`;
    btn.disabled = false;
    btn.textContent = 'Go Deeper - Compare Duties & Privileges';
  }
}

function renderDeepCompareResults(data, container) {
  let html = '';
  const { roles, envNameA, envNameB } = data;

  // Summary: how many roles have differences?
  const diffRoles = roles.filter(r => r.hasDiff);
  if (diffRoles.length === 0) {
    html += `<div class="deep-summary deep-summary-ok">All ${roles.length} roles have identical duties and privileges in both environments.</div>`;
  } else {
    html += `<div class="deep-summary deep-summary-warn">${diffRoles.length} of ${roles.length} roles have differences</div>`;
  }

  // Show roles with differences first, then identical ones
  const sorted = [...roles].sort((a, b) => (b.hasDiff ? 1 : 0) - (a.hasDiff ? 1 : 0));

  for (const role of sorted) {
    html += `<div class="deep-role ${role.hasDiff ? 'deep-role-diff' : 'deep-role-ok'}">`;
    html += `<div class="deep-role-header">`;
    html += `<span class="deep-role-name">${esc(role.roleName)}</span>`;
    html += `<span class="deep-role-id">${esc(role.roleId)}</span>`;
    if (role.hasDiff) {
      html += `<span class="diff-indicator">DIFF</span>`;
    } else {
      html += `<span class="same-indicator">SAME</span>`;
    }
    html += `</div>`;

    // Duties summary
    const d = role.duties;
    html += `<div class="deep-section">`;
    html += `<span class="deep-section-label">Duties:</span> `;
    html += `<span class="deep-counts">${d.totalA} in ${esc(envNameA)}, ${d.totalB} in ${esc(envNameB)}</span>`;
    if (d.onlyInA.length > 0) {
      html += `<div class="deep-diff-list">`;
      html += `<span class="deep-diff-label">Only in ${esc(envNameA)}:</span> `;
      for (const item of d.onlyInA) {
        html += `<span class="badge badge-only-a">${esc(item.name)}</span> `;
      }
      html += `</div>`;
    }
    if (d.onlyInB.length > 0) {
      html += `<div class="deep-diff-list">`;
      html += `<span class="deep-diff-label">Only in ${esc(envNameB)}:</span> `;
      for (const item of d.onlyInB) {
        html += `<span class="badge badge-only-b">${esc(item.name)}</span> `;
      }
      html += `</div>`;
    }
    html += `</div>`;

    // Privileges summary
    const p = role.privileges;
    html += `<div class="deep-section">`;
    html += `<span class="deep-section-label">Privileges:</span> `;
    html += `<span class="deep-counts">${p.totalA} in ${esc(envNameA)}, ${p.totalB} in ${esc(envNameB)}</span>`;
    if (p.onlyInA.length > 0) {
      html += `<div class="deep-diff-list">`;
      html += `<span class="deep-diff-label">Only in ${esc(envNameA)}:</span> `;
      for (const item of p.onlyInA) {
        html += `<span class="badge badge-only-a">${esc(item.name)}</span> `;
      }
      html += `</div>`;
    }
    if (p.onlyInB.length > 0) {
      html += `<div class="deep-diff-list">`;
      html += `<span class="deep-diff-label">Only in ${esc(envNameB)}:</span> `;
      for (const item of p.onlyInB) {
        html += `<span class="badge badge-only-b">${esc(item.name)}</span> `;
      }
      html += `</div>`;
    }
    html += `</div>`;

    html += `</div>`;
  }

  container.innerHTML = html;
}

// ============ User List (grouped by role) ============

function renderUserList() {
  const container = document.getElementById('userList');
  if (!currentData) return;

  let users = currentData.users;
  if (activeFilter !== 'all') {
    users = users.filter(u => u[activeFilter]);
  }

  if (users.length === 0) {
    container.innerHTML = `<div class="no-results"><p>No users with this access level.</p></div>`;
    return;
  }

  // Group by sorted role combination
  const groups = {};
  for (const u of users) {
    const roles = (u.roles || []).slice().sort();
    const key = roles.join('|');
    if (!groups[key]) {
      groups[key] = {
        roles,
        roleIds: [],
        users: [],
        access: { read: 0, update: 0, create: 0, delete: 0, invoke: 0 }
      };
    }
    groups[key].users.push(u.userId);
    // Collect role IDs for this group
    if (u.roleIds && groups[key].roleIds.length === 0) {
      groups[key].roleIds = u.roleIds.slice();
    }
    groups[key].access.read = mergeField(groups[key].access.read, u.read);
    groups[key].access.update = mergeField(groups[key].access.update, u.update);
    groups[key].access.create = mergeField(groups[key].access.create, u.create);
    groups[key].access.delete = mergeField(groups[key].access.delete, u.delete);
    groups[key].access.invoke = mergeField(groups[key].access.invoke, u.invoke);
    groups[key].access.correct = mergeField(groups[key].access.correct, u.correct || 0);
  }

  const sorted = Object.values(groups).sort((a, b) => b.users.length - a.users.length);

  let html = '';
  for (let i = 0; i < sorted.length; i++) {
    const g = sorted[i];
    const groupId = 'rg-' + i;

    const badges = [];
    if (g.access.read === 1) badges.push('<span class="badge badge-read">Read</span>');
    else if (g.access.read === 2) badges.push('<span class="badge badge-deny">Read Deny</span>');
    if (g.access.update === 1) badges.push('<span class="badge badge-update">Update</span>');
    else if (g.access.update === 2) badges.push('<span class="badge badge-deny">Update Deny</span>');
    if (g.access.create === 1) badges.push('<span class="badge badge-create">Create</span>');
    else if (g.access.create === 2) badges.push('<span class="badge badge-deny">Create Deny</span>');
    if (g.access.delete === 1) badges.push('<span class="badge badge-delete">Delete</span>');
    else if (g.access.delete === 2) badges.push('<span class="badge badge-deny">Delete Deny</span>');
    if (g.access.invoke === 1) badges.push('<span class="badge badge-invoke">Invoke</span>');
    else if (g.access.invoke === 2) badges.push('<span class="badge badge-deny">Invoke Deny</span>');
    if (g.access.correct === 1) badges.push('<span class="badge badge-invoke">Correct</span>');
    else if (g.access.correct === 2) badges.push('<span class="badge badge-deny">Correct Deny</span>');

    const roleIds = g.roles.map(roleName => {
      const role = currentData.roles.find(r => r.roleName === roleName);
      return role ? role.roleId : '';
    }).filter(Boolean);

    // Build per-role access breakdown
    const perRoleHtml = [];
    if (g.roles.length > 1) {
      for (const roleName of g.roles) {
        const role = currentData.roles.find(r => r.roleName === roleName);
        if (role) {
          perRoleHtml.push(`<div style="margin:1px 0 1px 8px;font-size:10px;">` +
            `<span style="color:#0078d4;font-weight:600;">${esc(roleName)}</span> ` +
            `${renderAccessBadges(role)}` +
            `</div>`);
        }
      }
    }

    html += `<div class="role-group" id="${groupId}">`;
    html += `<div class="role-group-header" data-group="${groupId}" data-roleids="${esc(roleIds.join(','))}" data-rolenames="${esc(g.roles.join('|'))}">`;
    html += `<div class="role-group-info">`;
    html += `<span class="role-group-names">${esc(g.roles.join(', '))}</span>`;
    html += `<div class="role-group-badges">${badges.join(' ')}</div>`;
    if (perRoleHtml.length > 0) {
      html += `<div class="role-group-breakdown" style="margin-top:2px;">${perRoleHtml.join('')}</div>`;
    }
    html += `</div>`;
    html += `<span class="role-group-count">${g.users.length}</span>`;
    html += `</div>`;
    html += `<div class="role-group-users">`;
    for (const userId of g.users) {
      const userObj = currentData.users.find(u => u.userId === userId);
      const tier = userObj?.licenseTier || '';
      const tierShort = tier === 'Enterprise' ? 'E' : tier === 'Universal' ? 'U' : tier === 'Activity' ? 'A' : tier === 'Team Members' ? 'T' : '';
      const tierColors = { 'Enterprise': '#a4262c', 'Universal': '#0078d4', 'Activity': '#8a6d00', 'Team Members': '#605e5c' };
      const tierColor = tierColors[tier] || '';
      const tierBadge = tierShort
        ? ` <span class="license-badge" style="background:${tierColor};color:#fff;" title="${esc(tier)} license">${tierShort}</span>`
        : '';
      html += `<span class="grouped-user" data-userid="${esc(userId)}">${esc(userId)}${tierBadge}</span>`;
    }
    html += `</div>`;
    html += `<div class="drill-down" id="drill-${groupId}"></div>`;
    html += `</div>`;
  }

  container.innerHTML = html;

  container.querySelectorAll('.role-group-header').forEach(header => {
    header.addEventListener('click', () => drillDown(header));
  });
}

// ============ Drill-Down + Role Removal Impact ============

async function drillDown(header) {
  const groupId = header.dataset.group;
  const drillContainer = document.getElementById('drill-' + groupId);
  if (!drillContainer) return;

  if (drillContainer.classList.contains('open')) {
    drillContainer.classList.remove('open');
    header.classList.remove('expanded');
    return;
  }

  if (drillContainer.dataset.loaded) {
    drillContainer.classList.add('open');
    header.classList.add('expanded');
    return;
  }

  const roleIds = (header.dataset.roleids || '').split(',').filter(Boolean);
  const roleNames = (header.dataset.rolenames || '').split('|').filter(Boolean);
  if (roleIds.length === 0) return;

  header.classList.add('expanded');
  drillContainer.classList.add('open');
  drillContainer.innerHTML = '<div class="drill-loading"><div class="spinner-sm"></div> Loading...</div>';

  try {
    // Fetch drill-down for each role
    const results = [];
    for (const roleId of roleIds) {
      const data = await send({
        action: 'drillRole',
        roleId,
        menuItem: currentData.menuItem,
        baseUrl: currentPage.d365Url
      });
      results.push(data);
    }

    let html = '';

    // Role removal impact - computed client-side, no extra queries
    html += renderImpactAnalysis(roleNames, roleIds);

    // Per-role details
    for (let ri = 0; ri < results.length; ri++) {
      const r = results[ri];
      const roleName = currentData.roles.find(role => role.roleId === r.roleId);
      const displayName = roleName ? roleName.roleName : r.roleId;

      html += `<div class="drill-role">`;
      html += `<div class="drill-role-title">${esc(displayName)}</div>`;
      html += `<div class="drill-role-id">${esc(r.roleId)}</div>`;

      // Permission entries - all raw fields
      if (r.permEntries && r.permEntries.length > 0) {
        html += `<div class="drill-section-title">SecurityPermissions for ${esc(r.menuItem || currentData.menuItem)}</div>`;
        for (const perm of r.permEntries) {
          html += `<div class="perm-card">`;
          for (const [key, val] of Object.entries(perm)) {
            if (val === null || val === undefined || val === '') continue;
            html += `<div class="perm-field">`;
            html += `<span class="perm-field-key">${esc(key)}</span>`;
            html += `<span class="perm-field-val">${esc(String(val))}</span>`;
            html += `</div>`;
          }
          html += `</div>`;
        }
      }

      // Duties - clickable to trace chain
      if (r.duties && r.duties.length > 0) {
        html += `<div class="drill-section-title">Duties (${r.duties.length}) - click to trace</div>`;
        for (const d of r.duties) {
          html += `<div class="drill-item duty-clickable" data-dutyid="${esc(d.id)}" data-roleid="${esc(r.roleId)}">`;
          html += `<span class="drill-item-name">${esc(d.name)}</span>`;
          html += `<span class="drill-item-id">${esc(d.id)}</span>`;
          html += `</div>`;
          html += `<div class="duty-chain hidden" id="chain-${esc(r.roleId)}-${esc(d.id)}"></div>`;
        }
      }

      // Role scope
      if (r.roleSummary && r.roleSummary.length > 0) {
        html += `<div class="drill-section-title">Role scope (${r.totalPermissions} permissions)</div>`;
        for (const s of r.roleSummary) {
          html += `<div class="scope-row">`;
          html += `<span class="scope-type">${esc(s.type)}</span>`;
          html += `<span class="scope-count">${s.count}</span>`;
          html += `</div>`;
        }
      }

      html += `</div>`;
      if (ri < results.length - 1) html += `<hr class="drill-sep">`;
    }

    // Add discover button
    html += `<div class="discover-bar">`;
    html += `<button class="discover-btn" id="discoverBtn-${groupId}">Discover hidden D365 security entities</button>`;
    html += `<div class="discover-results hidden" id="discoverResults-${groupId}"></div>`;
    html += `</div>`;

    drillContainer.innerHTML = html;
    drillContainer.dataset.loaded = 'true';

    // Wire duty click handlers
    drillContainer.querySelectorAll('.duty-clickable').forEach(item => {
      item.addEventListener('click', () => traceDutyChain(item));
    });

    // Wire discover button
    const discoverBtn = document.getElementById('discoverBtn-' + groupId);
    if (discoverBtn) {
      discoverBtn.addEventListener('click', () => runDiscover(groupId));
    }

  } catch (err) {
    drillContainer.innerHTML = `<div class="drill-error">${esc(err.message)}</div>`;
  }
}

// ============ Trace Duty → Privilege → Entry Point chain ============

async function traceDutyChain(item) {
  const dutyId = item.dataset.dutyid;
  const roleId = item.dataset.roleid;
  const chainContainer = document.getElementById('chain-' + roleId + '-' + dutyId);
  if (!chainContainer) return;

  // Toggle
  if (!chainContainer.classList.contains('hidden')) {
    chainContainer.classList.add('hidden');
    item.classList.remove('duty-expanded');
    return;
  }

  if (chainContainer.dataset.loaded) {
    chainContainer.classList.remove('hidden');
    item.classList.add('duty-expanded');
    return;
  }

  item.classList.add('duty-expanded');
  chainContainer.classList.remove('hidden');
  chainContainer.innerHTML = '<div class="drill-loading"><div class="spinner-sm"></div> Tracing chain...</div>';

  try {
    const data = await send({
      action: 'traceChain',
      roleId,
      dutyId,
      menuItem: currentData.menuItem,
      baseUrl: currentPage.d365Url
    });

    let html = '';

    // Duty → Privileges
    if (data.dutyPrivileges) {
      const dp = data.dutyPrivileges;
      html += `<div class="chain-source">Source: ${esc(dp.entity)}</div>`;

      if (dp.privileges.length > 0) {
        html += `<div class="chain-section-title">Privileges (${dp.privileges.length})</div>`;
        for (const p of dp.privileges) {
          html += `<div class="chain-item">`;
          // Show all fields from this record
          for (const [k, v] of Object.entries(p)) {
            if (v === null || v === undefined || v === '' || v === 0) continue;
            html += `<span class="chain-field"><span class="chain-key">${esc(k)}:</span> ${esc(String(v))}</span> `;
          }
          html += `</div>`;
        }
      } else {
        html += `<div class="drill-empty">No privileges found for this duty</div>`;
      }
    }

    // Privilege → Entry Points
    if (data.privilegeEntryPoints) {
      const pe = data.privilegeEntryPoints;
      html += `<div class="chain-section-title">Entry Points (via ${esc(pe.entity)})</div>`;
      for (const ep of pe.sample) {
        html += `<div class="chain-item">`;
        for (const [k, v] of Object.entries(ep)) {
          if (v === null || v === undefined || v === '' || v === 0) continue;
          html += `<span class="chain-field"><span class="chain-key">${esc(k)}:</span> ${esc(String(v))}</span> `;
        }
        html += `</div>`;
      }
    }

    if (data.discoveryNeeded) {
      html += `<div class="chain-note">D365 does not expose a Duty→Privilege entity via OData. Showing all privileges for this role instead. Click "Discover" below to search for hidden entities.</div>`;
    }

    if (!data.dutyPrivileges && !data.privilegeEntryPoints) {
      html += `<div class="drill-empty">Could not trace chain - no Duty→Privilege or Privilege→EntryPoint entities found in OData</div>`;
    }

    chainContainer.innerHTML = html;
    chainContainer.dataset.loaded = 'true';

  } catch (err) {
    chainContainer.innerHTML = `<div class="drill-error">${esc(err.message)}</div>`;
  }
}

// ============ Discover hidden OData entities ============

async function runDiscover(groupId) {
  const container = document.getElementById('discoverResults-' + groupId);
  if (!container) return;

  container.classList.remove('hidden');
  container.innerHTML = '<div class="drill-loading"><div class="spinner-sm"></div> Trying 25+ entity names...</div>';

  try {
    const data = await send({
      action: 'discoverEntities',
      baseUrl: currentPage.d365Url
    });

    let html = '';
    html += `<div class="chain-section-title">Entities found (${data.found.length})</div>`;
    for (const e of data.found) {
      html += `<div class="discover-entity">`;
      html += `<div class="discover-entity-name">${esc(e.entity)}</div>`;
      if (e.fields.length > 0) {
        html += `<div class="discover-entity-fields">Fields: ${e.fields.map(f => esc(f)).join(', ')}</div>`;
      }
      html += `</div>`;
    }

    if (data.notFound.length > 0) {
      html += `<div class="chain-section-title">Not found (${data.notFound.length})</div>`;
      html += `<div class="discover-not-found">${data.notFound.map(n => esc(n)).join(', ')}</div>`;
    }

    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div class="drill-error">${esc(err.message)}</div>`;
  }
}

// ============ Narrowest Role Search ============

function wireNarrowSearch() {
  const goBtn = document.getElementById('narrowGo');
  const input = document.getElementById('narrowInput');
  if (!goBtn || !input) return;

  goBtn.addEventListener('click', runNarrowSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runNarrowSearch();
  });

  const userGoBtn = document.getElementById('narrowUserGo');
  const userInput = document.getElementById('narrowUserId');
  if (userGoBtn) {
    userGoBtn.addEventListener('click', runUserRecommend);
  }
  if (userInput) {
    userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runUserRecommend();
    });
  }

  // User search
  const searchBtn = document.getElementById('userSearchGo');
  const searchInput = document.getElementById('userSearchInput');
  if (searchBtn) {
    searchBtn.addEventListener('click', runUserSearch);
  }
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runUserSearch();
    });
  }

  // Role inspector
  const inspectBtn = document.getElementById('roleInspectGo');
  const inspectInput = document.getElementById('roleInspectInput');
  if (inspectBtn) {
    inspectBtn.addEventListener('click', runRoleInspect);
  }
  if (inspectInput) {
    inspectInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runRoleInspect();
    });
  }

  // Security & License Overview
  const overviewBtn = document.getElementById('licenseOverviewGo');
  if (overviewBtn) {
    overviewBtn.addEventListener('click', runLicenseOverview);
  }

  // User Permission Inventory
  const inventoryBtn = document.getElementById('userInventoryGo');
  if (inventoryBtn) {
    inventoryBtn.addEventListener('click', runUserInventory);
  }
}

async function runLicenseOverview() {
  const container = document.getElementById('licenseOverviewResults');
  if (!container) return;
  if (!currentPage || !currentPage.d365Url) {
    container.innerHTML = '<div class="drill-error">Open a D365 tab first.</div>';
    return;
  }
  container.innerHTML = '<div class="drill-loading"><div class="spinner-sm"></div> Pulling user inventory and license data...</div>';
  try {
    const data = await send({ action: 'securityLicenseOverview', baseUrl: currentPage.d365Url });
    renderLicenseOverview(data, container);
  } catch (err) {
    container.innerHTML = `<div class="drill-error">${esc(err.message)}</div>`;
  }
}

function renderLicenseOverview(data, container) {
  const t = data.totals;
  let html = `<div class="role-inspect-card">`;
  html += `<div class="role-inspect-header">`;
  html += `<div class="role-inspect-name">Security & License Overview</div>`;
  html += `<div class="role-inspect-id">${esc(data.generatedAt)}</div>`;
  html += `</div>`;

  html += `<div class="role-inspect-stats">`;
  html += `<span class="role-stat"><strong>${t.enabledUsers}</strong> enabled users</span>`;
  html += `<span class="role-stat"><strong>${t.disabledUsers}</strong> disabled</span>`;
  html += `<span class="role-stat"><strong>${t.externalUsers}</strong> external</span>`;
  html += `<span class="role-stat"><strong>${t.internalUsers}</strong> internal</span>`;
  html += `<span class="role-stat"><strong>${t.enabledRoleAssignments}</strong> enabled role assignments</span>`;
  html += `</div>`;

  html += `<div class="drill-section-title">License distribution (effective tier per user)</div>`;
  html += `<div class="role-inspect-types">`;
  for (const [lic, count] of Object.entries(data.licenseDistribution).sort((a, b) => b[1] - a[1])) {
    html += `<span class="scope-row"><span class="scope-type">${esc(lic)}</span><span class="scope-count">${count}</span></span>`;
  }
  html += `</div>`;

  html += `<div class="drill-section-title">Account types</div>`;
  html += `<div class="role-inspect-types">`;
  for (const [t2, count] of Object.entries(data.accountTypes).sort((a, b) => b[1] - a[1])) {
    html += `<span class="scope-row"><span class="scope-type">${esc(t2)}</span><span class="scope-count">${count}</span></span>`;
  }
  html += `</div>`;

  html += `<div class="drill-section-title">Per-user breakdown (${data.perUser.length})</div>`;
  html += `<input type="text" class="filter-input" id="overviewUserFilter" placeholder="Filter by user ID, name, email..." style="margin-bottom:6px;">`;
  html += `<button class="compare-go" id="overviewExportBtn" style="margin-bottom:6px;font-size:10px;padding:3px 8px;">Export CSV</button>`;
  html += `<div class="role-inspect-list" id="overviewUserList">`;
  for (const u of data.perUser) {
    const search = `${u.userId} ${u.userName} ${u.email} ${u.licenseTier}`.toLowerCase();
    html += `<div class="menu-item-row" data-search="${esc(search)}">`;
    html += `<div class="menu-item-info">`;
    html += `<span class="drill-item-name">${esc(u.userName)} <span style="color:#8a8886;">(${esc(u.userId)})</span></span>`;
    html += `<span class="drill-item-id">${esc(u.email)} • ${esc(u.accountType)} • ${u.externalUser ? 'External' : 'Internal'} • ${u.roleCount} roles</span>`;
    html += `</div>`;
    const colorMap = { 'Enterprise': '#a4262c', 'Universal': '#0078d4', 'Activity': '#8a6d00', 'Team Members': '#605e5c', 'None': '#a19f9d' };
    const color = colorMap[u.licenseTier] || '#605e5c';
    html += `<div class="menu-item-badges"><span class="badge" style="background:${color};color:#fff;">${esc(u.licenseTier)}</span></div>`;
    html += `</div>`;
  }
  html += `</div>`;

  html += `<div style="margin-top:6px;font-size:10px;color:#8a6d00;font-style:italic;">${esc(data.note)}</div>`;
  html += `</div>`;
  container.innerHTML = html;

  const filterInput = document.getElementById('overviewUserFilter');
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      const term = filterInput.value.toLowerCase();
      document.querySelectorAll('#overviewUserList .menu-item-row').forEach(row => {
        row.style.display = row.dataset.search.includes(term) ? '' : 'none';
      });
    });
  }

  const exportBtn = document.getElementById('overviewExportBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const rows = [['UserID', 'UserName', 'Email', 'Company', 'AccountType', 'External', 'RoleCount', 'LicenseTier', 'Roles']];
      for (const u of data.perUser) {
        rows.push([
          u.userId, u.userName, u.email, u.company, u.accountType,
          u.externalUser ? 'Yes' : 'No',
          u.roleCount, u.licenseTier,
          u.roles.map(r => r.roleName || r.roleId).join('; ')
        ]);
      }
      const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `SecurityLicenseOverview_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }
}

async function runUserInventory() {
  const container = document.getElementById('userInventoryResults');
  if (!container) return;
  if (!currentPage || !currentPage.d365Url) {
    container.innerHTML = '<div class="drill-error">Open a D365 tab first.</div>';
    return;
  }

  const userIdFilter = prompt('Optional: filter to a specific user ID, name, or email (leave blank for ALL enabled users - slow):');
  if (userIdFilter === null) return;

  container.innerHTML = '<div class="drill-loading"><div class="spinner-sm"></div> Building user × permission inventory (this may take a minute)...</div>';
  try {
    const data = await send({
      action: 'userPermissionInventory',
      baseUrl: currentPage.d365Url,
      userIdFilter: userIdFilter.trim() || null
    });
    renderUserInventory(data, container);
  } catch (err) {
    container.innerHTML = `<div class="drill-error">${esc(err.message)}</div>`;
  }
}

function renderUserInventory(data, container) {
  if (data.message) {
    container.innerHTML = `<div class="drill-error">${esc(data.message)}</div>`;
    return;
  }

  let html = `<div class="role-inspect-card">`;
  html += `<div class="role-inspect-header">`;
  html += `<div class="role-inspect-name">User × Permission Inventory</div>`;
  html += `<div class="role-inspect-id">${esc(data.generatedAt)}</div>`;
  html += `</div>`;

  html += `<div class="role-inspect-stats">`;
  html += `<span class="role-stat"><strong>${data.totalUsers}</strong> enabled users</span>`;
  html += `<span class="role-stat"><strong>${data.totalRows}</strong> user-resource rows</span>`;
  html += `</div>`;

  html += `<button class="compare-go" id="inventoryExportBtn" style="margin-bottom:6px;font-size:10px;padding:3px 8px;">Export CSV (all rows)</button>`;
  html += `<input type="text" class="filter-input" id="inventoryFilter" placeholder="Filter resource or user..." style="margin-bottom:6px;">`;
  html += `<div class="role-inspect-list" id="inventoryList">`;

  for (const u of data.users) {
    html += `<div class="conflict-row" data-search="${esc((u.userId + ' ' + u.userName).toLowerCase())}">`;
    html += `<div class="menu-item-info">`;
    html += `<span class="drill-item-name">${esc(u.userName)} <span style="color:#8a8886;">(${esc(u.userId)})</span></span>`;
    html += `<span class="drill-item-id">${u.roleCount} roles, ${u.resourceCount} resources</span>`;
    html += `</div>`;
    html += `<details style="margin-top:4px;">`;
    html += `<summary style="cursor:pointer;font-size:10px;color:#605e5c;">Show ${u.resourceCount} resources</summary>`;
    html += `<div style="max-height:300px;overflow-y:auto;">`;
    for (const res of u.resources.slice(0, 500)) {
      html += `<div class="menu-item-row">`;
      html += `<div class="menu-item-info">`;
      html += `<span class="drill-item-name">${esc(res.resourceName)}</span>`;
      html += `<span class="drill-item-id">${esc(res.resourceType || '')}</span>`;
      html += `</div>`;
      html += `<div class="menu-item-badges">${renderAccessBadges(res)}</div>`;
      html += `</div>`;
    }
    if (u.resources.length > 500) {
      html += `<div style="padding:4px 8px;font-size:10px;color:#8a8886;">...and ${u.resources.length - 500} more (export CSV for full list)</div>`;
    }
    html += `</div></details>`;
    html += `</div>`;
  }
  html += `</div>`;
  html += `</div>`;
  container.innerHTML = html;

  const filterInput = document.getElementById('inventoryFilter');
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      const term = filterInput.value.toLowerCase();
      document.querySelectorAll('#inventoryList .conflict-row').forEach(row => {
        row.style.display = row.dataset.search.includes(term) ? '' : 'none';
      });
    });
  }

  const exportBtn = document.getElementById('inventoryExportBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const rows = [['UserID', 'UserName', 'Email', 'ResourceName', 'ResourceType', 'Read', 'Update', 'Create', 'Delete', 'Invoke', 'Correct', 'GrantingRoles']];
      const acc = v => v === 1 ? 'Grant' : v === 2 ? 'Deny' : '';
      for (const u of data.users) {
        for (const res of u.resources) {
          rows.push([
            u.userId, u.userName, u.email,
            res.resourceName, res.resourceType || '',
            acc(res.read), acc(res.update), acc(res.create), acc(res.delete), acc(res.invoke), acc(res.correct),
            (res.grantingRoles || []).map(r => r.roleName || r.roleId).join('; ')
          ]);
        }
      }
      const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `UserPermissionInventory_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }
}

async function runRoleInspect() {
  const input = document.getElementById('roleInspectInput');
  const container = document.getElementById('roleInspectResults');
  if (!input || !container) return;

  const raw = input.value.trim();
  if (!raw) {
    container.innerHTML = '<div class="drill-error">Enter a role identifier or name.</div>';
    return;
  }
  if (!currentPage || !currentPage.d365Url) {
    container.innerHTML = '<div class="drill-error">No D365 environment detected. Open a D365 tab first.</div>';
    return;
  }

  const roles = raw.split(',').map(s => s.trim()).filter(Boolean);

  if (roles.length === 1) {
    container.innerHTML = '<div class="drill-loading"><div class="spinner-sm"></div> Inspecting role...</div>';
    try {
      const data = await send({
        action: 'inspectRole',
        roleQuery: roles[0],
        baseUrl: currentPage.d365Url
      });
      renderRoleInspect(data, container);
    } catch (err) {
      container.innerHTML = `<div class="drill-error">${esc(err.message)}</div>`;
    }
    return;
  }

  if (roles.length > 5) {
    container.innerHTML = '<div class="drill-error">Maximum 5 roles for comparison.</div>';
    return;
  }

  container.innerHTML = `<div class="drill-loading"><div class="spinner-sm"></div> Inspecting ${roles.length} roles and finding conflicts...</div>`;

  try {
    const results = await Promise.all(roles.map(r =>
      send({ action: 'inspectRole', roleQuery: r, baseUrl: currentPage.d365Url })
    ));
    renderRoleCompare(roles, results, container);
  } catch (err) {
    container.innerHTML = `<div class="drill-error">${esc(err.message)}</div>`;
  }
}

function accessSignature(access) {
  return ['read','update','create','delete','invoke','correct']
    .map(f => access[f] || 0)
    .join('');
}

function renderRoleCompare(queries, results, container) {
  const found = results.filter(r => r.found);
  const notFound = queries.filter((q, i) => !results[i].found);

  if (found.length < 2) {
    let html = '<div class="drill-error">Need at least 2 valid roles to compare.</div>';
    if (notFound.length > 0) {
      html += `<div style="font-size:11px;color:#d13438;margin-top:4px;">Not found: ${notFound.map(esc).join(', ')}</div>`;
    }
    container.innerHTML = html;
    return;
  }

  // Build menu item -> role -> access map
  const menuItemMap = {}; // { resourceName: { resourceType, roles: [{roleId, roleName, access}] } }
  for (const r of found) {
    for (const mi of r.menuItems) {
      if (!menuItemMap[mi.resourceName]) {
        menuItemMap[mi.resourceName] = {
          resourceName: mi.resourceName,
          resourceType: mi.resourceType,
          roles: {}
        };
      }
      menuItemMap[mi.resourceName].roles[r.roleId] = {
        roleId: r.roleId,
        roleName: r.roleName,
        read: mi.read || 0,
        update: mi.update || 0,
        create: mi.create || 0,
        delete: mi.delete || 0,
        invoke: mi.invoke || 0,
        correct: mi.correct || 0
      };
    }
  }

  // Categorize
  const roleIds = found.map(r => r.roleId);
  const conflictDeny = []; // One grants, another denies
  const conflictDiff = []; // Different access levels (both grant but different)
  const sharedSame = [];   // All roles touch it with same access
  const uniqueToRole = {}; // { roleId: [items] }
  for (const rid of roleIds) uniqueToRole[rid] = [];

  for (const mi of Object.values(menuItemMap)) {
    const rolesWithAccess = Object.keys(mi.roles);
    const touchingRoles = rolesWithAccess.length;

    if (touchingRoles === 1) {
      uniqueToRole[rolesWithAccess[0]].push(mi);
      continue;
    }

    // Check for Grant/Deny conflict across fields
    let hasGrant = false, hasDeny = false;
    const signatures = new Set();
    for (const rid of rolesWithAccess) {
      const a = mi.roles[rid];
      for (const f of ['read','update','create','delete','invoke','correct']) {
        if (a[f] === 1) hasGrant = true;
        if (a[f] === 2) hasDeny = true;
      }
      signatures.add(accessSignature(a));
    }

    if (hasGrant && hasDeny) {
      conflictDeny.push(mi);
    } else if (signatures.size > 1) {
      conflictDiff.push(mi);
    } else {
      sharedSame.push(mi);
    }
  }

  // Render
  let html = '';
  html += `<div class="role-inspect-card">`;
  html += `<div class="role-inspect-header"><div class="role-inspect-name">Comparing ${found.length} roles</div></div>`;

  html += `<div class="role-compare-roles">`;
  for (const r of found) {
    html += `<div class="role-compare-tag">`;
    html += `<strong>${esc(r.roleName)}</strong> <span style="color:#8a8886;">(${esc(r.roleId)})</span>`;
    html += ` - ${r.uniqueMenuItems} items, ${r.activeUserCount} users`;
    html += `</div>`;
  }
  html += `</div>`;

  if (notFound.length > 0) {
    html += `<div style="font-size:11px;color:#d13438;margin-top:4px;">Not found: ${notFound.map(esc).join(', ')}</div>`;
  }

  html += `<div class="role-inspect-stats">`;
  html += `<span class="role-stat" style="background:#fde7e9;color:#a4262c;"><strong>${conflictDeny.length}</strong> Grant/Deny conflicts</span>`;
  html += `<span class="role-stat" style="background:#fff4ce;color:#8a6d00;"><strong>${conflictDiff.length}</strong> Access level differences</span>`;
  html += `<span class="role-stat"><strong>${sharedSame.length}</strong> identical access</span>`;
  html += `<span class="role-stat"><strong>${Object.keys(menuItemMap).length}</strong> total overlap</span>`;
  html += `</div>`;

  // Grant/Deny conflicts - most important
  if (conflictDeny.length > 0) {
    html += `<div class="drill-section-title" style="color:#a4262c;">Grant/Deny conflicts (${conflictDeny.length}) - Deny wins!</div>`;
    html += renderConflictList(conflictDeny, found);
  }

  // Different access levels
  if (conflictDiff.length > 0) {
    html += `<div class="drill-section-title" style="color:#8a6d00;">Different access levels (${conflictDiff.length})</div>`;
    html += renderConflictList(conflictDiff, found);
  }

  // Shared same access
  if (sharedSame.length > 0) {
    html += `<div class="drill-section-title">Identical access in all roles (${sharedSame.length})</div>`;
    html += `<details><summary style="cursor:pointer;font-size:11px;color:#605e5c;">Show ${sharedSame.length} items</summary>`;
    html += renderConflictList(sharedSame, found);
    html += `</details>`;
  }

  // Unique per role
  for (const r of found) {
    const items = uniqueToRole[r.roleId];
    if (items.length === 0) continue;
    html += `<div class="drill-section-title">Only in <strong>${esc(r.roleName)}</strong> (${items.length})</div>`;
    html += `<details><summary style="cursor:pointer;font-size:11px;color:#605e5c;">Show ${items.length} items</summary>`;
    html += `<div class="role-inspect-list">`;
    for (const mi of items.slice(0, 200)) {
      html += `<div class="menu-item-row">`;
      html += `<div class="menu-item-info"><span class="drill-item-name">${esc(mi.resourceName)}</span><span class="drill-item-id">${esc(mi.resourceType || '')}</span></div>`;
      html += `<div class="menu-item-badges">${renderAccessBadges(mi.roles[r.roleId])}</div>`;
      html += `</div>`;
    }
    if (items.length > 200) html += `<div style="padding:4px 8px;font-size:11px;color:#8a8886;">...and ${items.length - 200} more</div>`;
    html += `</div></details>`;
  }

  html += `</div>`;
  container.innerHTML = html;

  // Wire trace privilege buttons
  container.querySelectorAll('.trace-priv-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      runTracePrivilege(btn);
    });
  });
}

function renderConflictList(items, roles) {
  let html = `<div class="role-inspect-list">`;
  for (const mi of items) {
    const safeRes = esc(mi.resourceName);
    html += `<div class="conflict-row" data-resource="${safeRes}">`;
    html += `<div class="menu-item-info"><span class="drill-item-name">${safeRes}</span><span class="drill-item-id">${esc(mi.resourceType || '')}</span></div>`;
    html += `<div class="conflict-roles">`;
    for (const r of roles) {
      const access = mi.roles[r.roleId];
      html += `<div class="conflict-role-line">`;
      html += `<span class="conflict-role-name">${esc(r.roleName)}:</span> `;
      if (access) {
        html += renderAccessBadges(access);
        html += ` <button class="trace-priv-btn" data-roleid="${esc(r.roleId)}" data-rolename="${esc(r.roleName)}" data-resource="${safeRes}">Trace privilege</button>`;
      } else {
        html += `<span style="color:#a19f9d;font-style:italic;">(no access)</span>`;
      }
      html += `</div>`;
      html += `<div class="trace-priv-result hidden" id="trace-${esc(r.roleId)}-${safeRes.replace(/[^a-z0-9]/gi,'_')}"></div>`;
    }
    html += `</div>`;
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

async function runTracePrivilege(btn) {
  const roleId = btn.dataset.roleid;
  const resource = btn.dataset.resource;
  const resultId = `trace-${roleId}-${resource.replace(/[^a-z0-9]/gi,'_')}`;
  const resultEl = document.getElementById(resultId);
  if (!resultEl) return;

  if (!resultEl.classList.contains('hidden') && resultEl.dataset.loaded) {
    resultEl.classList.add('hidden');
    return;
  }

  resultEl.classList.remove('hidden');
  resultEl.innerHTML = '<div class="drill-loading"><div class="spinner-sm"></div> Tracing privilege...</div>';

  try {
    const data = await send({
      action: 'tracePrivilegeForResource',
      roleId,
      resourceName: resource,
      baseUrl: currentPage.d365Url
    });

    let html = '';

    // Note banner
    if (data.note) {
      html += `<div style="font-size:10px;color:#8a6d00;background:#fff4ce;padding:4px 6px;border-radius:2px;margin:4px 0;">${esc(data.note)}</div>`;
    }

    // PRECISE: Privileges found via narrow-role intersection
    if (data.narrowPrivileges && data.narrowPrivileges.length > 0) {
      html += `<div style="font-size:11px;margin-bottom:4px;"><strong style="color:#107c10;">Privilege(s) in this role that grant/deny the resource (PRECISE):</strong></div>`;
      html += `<div style="font-size:10px;color:#605e5c;margin-bottom:4px;font-style:italic;">Identified by cross-referencing with other roles that also have this permission. The target role owns these privileges.</div>`;
      for (const p of data.narrowPrivileges.slice(0, 5)) {
        html += `<div class="trace-priv-item" style="border-left:2px solid #107c10;padding-left:6px;">`;
        html += `<div><span style="color:#107c10;font-weight:700;">${esc(p.privilegeName)}</span> <span style="color:#8a8886;">(${esc(p.privilegeId)})</span></div>`;
        if (p.narrowRoles && p.narrowRoles.length > 0) {
          html += `<div style="font-size:10px;color:#8a8886;margin-left:8px;">Reference probe: narrow role <strong>${esc(p.narrowRoles[0].roleName)}</strong> also has this privilege and access to the resource (${p.narrowRoles[0].totalPerms} total perms - used only to identify the privilege name)</div>`;
        }
        html += `</div>`;
      }
    }

    // PRECISE: Subroles that grant access
    if (data.subRoles && data.subRoles.length > 0) {
      html += `<div style="font-size:11px;margin:8px 0 4px 0;"><strong style="color:#107c10;">Sub-role(s) granting this (PRECISE):</strong></div>`;
      for (const s of data.subRoles) {
        html += `<div class="trace-priv-item" style="border-left:2px solid #107c10;padding-left:6px;">`;
        html += `<div><span style="color:#107c10;font-weight:700;">${esc(s.subRoleName)}</span> <span style="color:#8a8886;">(${esc(s.subRoleId)})</span></div>`;
        html += `<div style="margin:2px 0;">${renderAccessBadges(s)}</div>`;
        html += `</div>`;
      }
    }

    // HEURISTIC: Duties matching resource name
    if (data.duties && data.duties.length > 0) {
      html += `<div style="font-size:11px;margin-top:6px;"><strong style="color:#8764b8;">Duties with matching names (heuristic):</strong></div>`;
      for (const d of data.duties) {
        html += `<div class="trace-priv-item">`;
        html += `<div><span style="color:#8764b8;font-weight:600;">${esc(d.dutyName)}</span> <span style="color:#8a8886;">(${esc(d.dutyId)})</span> <span style="color:#8a6d00;font-size:10px;">score: ${d.score}</span></div>`;
        if (d.matchedPrivileges && d.matchedPrivileges.length > 0) {
          for (const p of d.matchedPrivileges) {
            html += `<div style="margin-left:8px;font-size:10px;color:#605e5c;">→ ${esc(p.privilegeName)} <span style="color:#8a8886;">(${esc(p.privilegeId)}, score ${p.score})</span></div>`;
          }
        }
        html += `</div>`;
      }
    }

    // HEURISTIC: All privileges in role matching resource name
    if (data.privileges && data.privileges.length > 0) {
      html += `<div style="font-size:11px;margin-top:6px;"><strong style="color:#0078d4;">Privileges with matching names (heuristic):</strong></div>`;
      for (const p of data.privileges) {
        html += `<div class="trace-priv-item">`;
        html += `<div><span style="color:#0078d4;font-weight:600;">${esc(p.privilegeName)}</span> <span style="color:#8a8886;">(${esc(p.privilegeId)})</span> <span style="color:#8a6d00;font-size:10px;">score: ${p.score}</span></div>`;
        html += `</div>`;
      }
    }

    // Error / empty state
    if (!data.subRoles?.length && !data.duties?.length && !data.privileges?.length) {
      html += `<div class="drill-error" style="font-size:11px;">${esc(data.error || 'No match found')}</div>`;
    }

    // Diagnostic attempts
    if (data.attempts && data.attempts.length > 0) {
      html += `<details style="margin-top:6px;"><summary style="cursor:pointer;font-size:10px;color:#605e5c;">Diagnostics (${data.attempts.length})</summary>`;
      for (const a of data.attempts) {
        html += `<div style="font-size:10px;color:#8a8886;font-family:monospace;">${esc(a)}</div>`;
      }
      html += `</details>`;
    }

    resultEl.innerHTML = html;
    resultEl.dataset.loaded = 'true';
  } catch (err) {
    resultEl.innerHTML = `<div class="drill-error" style="font-size:11px;">${esc(err.message)}</div>`;
  }
}

function renderRoleInspect(data, container) {
  if (!data.found) {
    container.innerHTML = `<div class="drill-error">Role not found for query: <strong>${esc(data.query || '')}</strong></div>`;
    return;
  }

  let html = '';
  html += `<div class="role-inspect-card">`;
  html += `<div class="role-inspect-header">`;
  html += `<div class="role-inspect-name">${esc(data.roleName)}</div>`;
  html += `<div class="role-inspect-id">${esc(data.roleId)}</div>`;
  html += `</div>`;

  // Stats
  html += `<div class="role-inspect-stats">`;
  html += `<span class="role-stat"><strong>${data.uniqueMenuItems}</strong> menu items</span>`;
  html += `<span class="role-stat"><strong>${data.totalPermissions}</strong> total permissions</span>`;
  html += `<span class="role-stat"><strong>${data.duties.length}</strong> duties</span>`;
  html += `<span class="role-stat"><strong>${data.privileges.length}</strong> privileges</span>`;
  html += `<span class="role-stat"><strong>${data.activeUserCount}</strong> active users</span>`;
  html += `</div>`;

  // Resource type breakdown
  if (data.byType && Object.keys(data.byType).length > 0) {
    html += `<div class="drill-section-title">Resource breakdown</div>`;
    html += `<div class="role-inspect-types">`;
    for (const [type, count] of Object.entries(data.byType)) {
      html += `<span class="scope-row"><span class="scope-type">${esc(type)}</span><span class="scope-count">${count}</span></span>`;
    }
    html += `</div>`;
  }

  // Users assigned to this role (all, with filter)
  const userList = data.allUsers || data.sampleUsers || [];
  if (userList.length > 0) {
    html += `<div class="drill-section-title">Users assigned (${data.activeUserCount})</div>`;
    html += `<input type="text" class="filter-input" id="roleUsersFilter" placeholder="Filter users..." style="margin-bottom:4px;">`;
    html += `<div class="role-group-users" id="roleUsersList">`;
    for (const uid of userList) {
      html += `<span class="grouped-user" data-userid="${esc(uid.toLowerCase())}">${esc(uid)}</span>`;
    }
    html += `</div>`;
    html += `<button class="compare-go" id="roleUsersExport" style="margin-top:4px;font-size:10px;padding:3px 8px;">Export CSV</button>`;
  }

  // Duties
  if (data.duties.length > 0) {
    html += `<div class="drill-section-title">Duties (${data.duties.length})</div>`;
    html += `<div class="role-inspect-list">`;
    for (const d of data.duties) {
      html += `<div class="drill-item"><span class="drill-item-name">${esc(d.name)}</span><span class="drill-item-id">${esc(d.id)}</span></div>`;
    }
    html += `</div>`;
  }

  // Privileges
  if (data.privileges.length > 0) {
    html += `<div class="drill-section-title">Privileges (${data.privileges.length})</div>`;
    html += `<div class="role-inspect-list">`;
    for (const p of data.privileges) {
      html += `<div class="drill-item"><span class="drill-item-name">${esc(p.name)}</span><span class="drill-item-id">${esc(p.id)}</span></div>`;
    }
    html += `</div>`;
  }

  // Menu items with access levels
  if (data.menuItems.length > 0) {
    html += `<div class="drill-section-title">Menu items & access (${data.menuItems.length})</div>`;
    html += `<input type="text" class="filter-input" id="roleMenuFilter" placeholder="Filter menu items..." style="margin-bottom:6px;">`;
    html += `<div class="role-inspect-list" id="roleMenuList">`;
    for (const mi of data.menuItems) {
      html += `<div class="menu-item-row" data-name="${esc(mi.resourceName.toLowerCase())}">`;
      html += `<div class="menu-item-info">`;
      html += `<span class="drill-item-name">${esc(mi.resourceName)}</span>`;
      html += `<span class="drill-item-id">${esc(mi.resourceType || '')}</span>`;
      html += `</div>`;
      html += `<div class="menu-item-badges">${renderAccessBadges(mi)}</div>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  container.innerHTML = html;

  // Wire filter
  const filterInput = document.getElementById('roleMenuFilter');
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      const term = filterInput.value.toLowerCase();
      document.querySelectorAll('#roleMenuList .menu-item-row').forEach(row => {
        row.style.display = row.dataset.name.includes(term) ? '' : 'none';
      });
    });
  }

  // Wire users filter
  const usersFilterInput = document.getElementById('roleUsersFilter');
  if (usersFilterInput) {
    usersFilterInput.addEventListener('input', () => {
      const term = usersFilterInput.value.toLowerCase();
      document.querySelectorAll('#roleUsersList .grouped-user').forEach(el => {
        el.style.display = el.dataset.userid.includes(term) ? '' : 'none';
      });
    });
  }

  // Wire users CSV export
  const usersExportBtn = document.getElementById('roleUsersExport');
  if (usersExportBtn) {
    usersExportBtn.addEventListener('click', () => {
      const rows = [['User ID']];
      for (const uid of (data.allUsers || [])) rows.push([uid]);
      const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${data.roleName || data.roleId}_users_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }
}

async function runUserSearch() {
  const input = document.getElementById('userSearchInput');
  const container = document.getElementById('userSearchResults');
  if (!input || !container) return;

  const raw = input.value.trim();
  if (raw.length < 2) {
    container.innerHTML = '<div class="drill-error">Enter at least 2 characters.</div>';
    return;
  }

  // Split on commas, ampersands, "and", semicolons, or newlines - but NOT spaces alone
  // (names like "Laura" are single words, but "van der Berg" shouldn't be split)
  const terms = raw.split(/[,;&\n]+|\band\b/i).map(s => s.trim()).filter(s => s.length >= 2);
  if (terms.length === 0) {
    container.innerHTML = '<div class="drill-error">Enter at least 2 characters per name.</div>';
    return;
  }

  let baseUrl = currentPage ? currentPage.d365Url : null;
  if (!baseUrl) {
    try {
      const page = await send({ action: 'getPageInfo' });
      baseUrl = page.d365Url;
    } catch (e) {
      container.innerHTML = '<div class="drill-error">Navigate to a D365 page first.</div>';
      return;
    }
  }

  container.innerHTML = `<div class="drill-loading"><div class="spinner-sm"></div> Searching for ${terms.length} name(s)...</div>`;

  try {
    // Search all terms in parallel
    const results = await Promise.all(
      terms.map(term => send({ action: 'searchUserByName', searchTerm: term, baseUrl }).catch(e => ({ users: [], searchTerm: term, error: e.message })))
    );

    // Combine and deduplicate
    const seen = new Set();
    const allUsers = [];
    const perTerm = [];
    for (let i = 0; i < terms.length; i++) {
      const data = results[i];
      const termUsers = [];
      for (const u of (data.users || [])) {
        if (!seen.has(u.userId)) {
          seen.add(u.userId);
          allUsers.push(u);
        }
        termUsers.push(u);
      }
      perTerm.push({ term: terms[i], users: termUsers, error: data.error });
    }

    renderUserSearchResults({ users: allUsers, searchTerm: raw, perTerm, terms }, container);
  } catch (err) {
    container.innerHTML = `<div class="drill-error">${esc(err.message)}</div>`;
  }
}

function renderUserSearchResults(data, container) {
  if (!data.users || data.users.length === 0) {
    let html = `<div class="narrow-no-result">No users found matching "${esc(data.searchTerm)}"`;
    if (data.perTerm) {
      for (const pt of data.perTerm) {
        if (pt.error) html += `<br><span style="color:#d13438;">"${esc(pt.term)}": ${esc(pt.error)}</span>`;
      }
    }
    html += `</div>`;
    container.innerHTML = html;
    return;
  }

  const isMulti = data.terms && data.terms.length > 1;
  let html = '';

  // Add All button when multiple results
  if (data.users.length > 1) {
    html += `<div style="margin-top:8px;margin-bottom:4px;display:flex;align-items:center;gap:8px;">`;
    html += `<span style="font-size:11px;color:#605e5c;">${data.users.length} user(s) found</span>`;
    html += `<button class="compare-go" id="userSearchAddAll" style="font-size:10px;padding:3px 10px;">Add all to User IDs</button>`;
    html += `</div>`;
  }

  html += `<div class="user-search-results-box">`;

  // Show per-term results if multi search
  if (isMulti && data.perTerm) {
    for (const pt of data.perTerm) {
      if (pt.error) {
        html += `<div class="user-search-term-header" style="color:#d13438;">"${esc(pt.term)}" - ${esc(pt.error)}</div>`;
        continue;
      }
      if (pt.users.length === 0) {
        html += `<div class="user-search-term-header" style="color:#a19f9d;">"${esc(pt.term)}" - no matches</div>`;
        continue;
      }
      html += `<div class="user-search-term-header">"${esc(pt.term)}" - ${pt.users.length} match(es)</div>`;
      for (const u of pt.users) {
        html += renderUserSearchItem(u);
      }
    }
  } else {
    html += `<div style="padding:6px 10px;font-size:11px;color:#605e5c;">Click to add to User IDs field</div>`;
    for (const u of data.users) {
      html += renderUserSearchItem(u);
    }
  }

  html += `</div>`;
  container.innerHTML = html;

  // Wire "Add all" button
  const addAllBtn = document.getElementById('userSearchAddAll');
  if (addAllBtn) {
    addAllBtn.addEventListener('click', () => {
      const userIdInput = document.getElementById('narrowUserId');
      if (!userIdInput) return;
      const current = userIdInput.value.trim();
      const existing = current.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
      const newIds = data.users.filter(u => u.enabled !== false).map(u => u.userId).filter(id => !existing.includes(id));
      if (newIds.length > 0) {
        userIdInput.value = [...existing, ...newIds].join(', ');
      }
      container.querySelectorAll('.user-search-item').forEach(el => {
        if (!el.classList.contains('user-search-disabled')) el.classList.add('user-search-selected');
      });
      addAllBtn.textContent = 'Added!';
      addAllBtn.disabled = true;
    });
  }

  // Wire individual clicks
  container.querySelectorAll('.user-search-item').forEach(item => {
    item.addEventListener('click', () => {
      const userId = item.dataset.userid;
      const userIdInput = document.getElementById('narrowUserId');
      if (!userIdInput) return;

      const current = userIdInput.value.trim();
      const existing = current.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
      if (!existing.includes(userId)) {
        userIdInput.value = existing.length > 0 ? existing.join(', ') + ', ' + userId : userId;
      }
      item.classList.add('user-search-selected');
    });
  });
}

function renderUserSearchItem(u) {
  const disabledClass = u.enabled === false ? ' user-search-disabled' : '';
  let html = `<div class="user-search-item${disabledClass}" data-userid="${esc(u.userId)}">`;
  html += `<div class="user-search-name">${esc(u.userName || u.userId)}</div>`;
  html += `<div class="user-search-id">${esc(u.userId)}`;
  if (u.email) html += ` · ${esc(u.email)}`;
  if (u.enabled === false) html += ` · <span style="color:#d13438;">Disabled</span>`;
  html += `</div></div>`;
  return html;
}

async function runNarrowSearch() {
  const input = document.getElementById('narrowInput');
  const accessSelect = document.getElementById('narrowAccess');
  const container = document.getElementById('narrowResults');
  if (!input || !container) return;

  const raw = input.value.trim();
  if (!raw) return;

  const menuItems = raw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  const accessLevel = accessSelect ? accessSelect.value : '';

  let baseUrl = currentPage ? currentPage.d365Url : null;
  if (!baseUrl) {
    try {
      const page = await send({ action: 'getPageInfo' });
      baseUrl = page.d365Url;
    } catch (e) {
      container.innerHTML = '<div class="drill-error">Navigate to a D365 page first.</div>';
      return;
    }
  }

  const label = menuItems.length > 1
    ? `${menuItems.length} menu items`
    : esc(menuItems[0]);
  container.innerHTML = `<div class="drill-loading"><div class="spinner-sm"></div> Analyzing roles for ${label}...</div>`;

  try {
    if (menuItems.length === 1) {
      const data = await send({ action: 'findNarrowestRole', menuItem: menuItems[0], baseUrl, accessLevel });
      renderNarrowResults(data, container);
    } else {
      const data = await send({ action: 'findNarrowestMulti', menuItems, baseUrl, accessLevel });
      renderNarrowResults(data, container);
    }
  } catch (err) {
    container.innerHTML = `<div class="drill-error">${esc(err.message)}</div>`;
  }
}

function renderAccessBadges(role) {
  // role has fields: read, update, create, delete, invoke, correct
  // Values: 0=Unset, 1=Grant, 2=Deny
  const fields = [
    { key: 'read',    label: 'Read',    grantClass: 'badge-read',   denyClass: 'badge-deny' },
    { key: 'update',  label: 'Update',  grantClass: 'badge-update', denyClass: 'badge-deny' },
    { key: 'create',  label: 'Create',  grantClass: 'badge-create', denyClass: 'badge-deny' },
    { key: 'delete',  label: 'Delete',  grantClass: 'badge-delete', denyClass: 'badge-deny' },
    { key: 'invoke',  label: 'Invoke',  grantClass: 'badge-invoke', denyClass: 'badge-deny' },
    { key: 'correct', label: 'Correct', grantClass: 'badge-invoke', denyClass: 'badge-deny' },
  ];
  let html = '';
  for (const f of fields) {
    const val = role[f.key];
    if (val === 1) {
      html += `<span class="badge ${f.grantClass}">${f.label}</span>`;
    } else if (val === 2) {
      html += `<span class="badge ${f.denyClass}">${f.label} Deny</span>`;
    }
    // 0 (Unset) = don't show
  }
  return html;
}

function renderNarrowestPrivilege(np, rankedPrivileges) {
  let html = `<div class="narrow-result-card" style="border-left:4px solid #8764b8;margin-top:10px;">`;
  html += `<div class="narrow-card-header">`;
  html += `<div class="narrow-card-info">`;
  html += `<div class="narrow-card-name">${esc(np.name)}</div>`;
  html += `<div class="narrow-card-id">${esc(np.id)}</div>`;
  html += `</div>`;
  html += `<div class="narrow-card-stats">`;
  html += `<div class="narrow-stat"><div class="narrow-stat-num">${np.totalEntryPoints}</div><div class="narrow-stat-label">Scope</div></div>`;
  html += `</div></div>`;
  html += `<div class="narrow-card-body">`;
  html += `<span class="narrow-best-tag" style="background:#e8d4ef;color:#8764b8;">NARROWEST PRIVILEGE</span>`;
  if (np.grantCount) html += renderAccessBadges(np);
  html += `</div>`;
  if (np.roles && np.roles.length > 0) {
    html += `<div class="narrow-duties-list">In roles: ${np.roles.map(r => `<span>${esc(r.name)}</span>`).join(', ')}</div>`;
  }
  html += `</div>`;

  if (rankedPrivileges && rankedPrivileges.length > 1) {
    html += `<div style="margin-top:4px;font-size:11px;color:#605e5c;cursor:pointer;" id="narrowShowMorePriv">Other privileges (${rankedPrivileges.length - 1}) ▸</div>`;
    html += `<div id="narrowOtherPrivs" class="hidden">`;
    for (let i = 1; i < rankedPrivileges.length; i++) {
      const pr = rankedPrivileges[i];
      html += `<div class="narrow-result-card narrow-other" style="border-left-color:#8764b8;">`;
      html += `<div class="narrow-card-header"><div class="narrow-card-info">`;
      html += `<div class="narrow-card-name">${esc(pr.name)}</div>`;
      html += `<div class="narrow-card-id">${esc(pr.id)}</div>`;
      html += `</div><div class="narrow-card-stats">`;
      html += `<div class="narrow-stat"><div class="narrow-stat-num">${pr.totalEntryPoints}</div><div class="narrow-stat-label">Scope</div></div>`;
      html += `</div></div>`;
      html += `<div class="narrow-card-body"><span class="narrow-rank">#${i + 1}</span></div>`;
      html += `</div>`;
    }
    html += `</div>`;
  }
  return html;
}

function renderNarrowestDuty(nd, rankedDuties) {
  let html = `<div class="narrow-result-card" style="border-left:4px solid #0078d4;margin-top:10px;">`;
  html += `<div class="narrow-card-header">`;
  html += `<div class="narrow-card-info">`;
  html += `<div class="narrow-card-name">${esc(nd.name)}</div>`;
  html += `<div class="narrow-card-id">${esc(nd.id)}</div>`;
  html += `</div>`;
  html += `<div class="narrow-card-stats">`;
  html += `<div class="narrow-stat"><div class="narrow-stat-num">${nd.totalPrivileges}</div><div class="narrow-stat-label">Privs</div></div>`;
  html += `</div></div>`;
  html += `<div class="narrow-card-body">`;
  html += `<span class="narrow-best-tag" style="background:#deecf9;color:#0078d4;">NARROWEST DUTY</span>`;
  html += `</div>`;
  if (nd.privileges && nd.privileges.length > 0) {
    html += `<div class="narrow-duties-list">Privileges: ${nd.privileges.map(p => `<span>${esc(p.name)}</span>`).join(', ')}</div>`;
  }
  if (nd.roles && nd.roles.length > 0) {
    html += `<div class="narrow-duties-list">In roles: ${nd.roles.map(r => `<span>${esc(r.name)}</span>`).join(', ')}</div>`;
  }
  html += `</div>`;

  if (rankedDuties && rankedDuties.length > 1) {
    html += `<div style="margin-top:4px;font-size:11px;color:#605e5c;cursor:pointer;" id="narrowShowMoreDuty">Other duties (${rankedDuties.length - 1}) ▸</div>`;
    html += `<div id="narrowOtherDuties" class="hidden">`;
    for (let i = 1; i < rankedDuties.length; i++) {
      const d = rankedDuties[i];
      html += `<div class="narrow-result-card narrow-other" style="border-left-color:#0078d4;">`;
      html += `<div class="narrow-card-header"><div class="narrow-card-info">`;
      html += `<div class="narrow-card-name">${esc(d.name)}</div>`;
      html += `<div class="narrow-card-id">${esc(d.id)}</div>`;
      html += `</div><div class="narrow-card-stats">`;
      html += `<div class="narrow-stat"><div class="narrow-stat-num">${d.totalPrivileges}</div><div class="narrow-stat-label">Privs</div></div>`;
      html += `</div></div>`;
      html += `<div class="narrow-card-body"><span class="narrow-rank">#${i + 1}</span></div>`;
      html += `</div>`;
    }
    html += `</div>`;
  }
  return html;
}

function renderNarrowResults(data, container) {
  let html = '';
  const isMulti = data.menuItems && data.menuItems.length > 1;
  const displayLabel = isMulti ? data.menuItems.map(m => esc(m)).join(', ') : esc(data.menuItem || (data.menuItems && data.menuItems[0]) || '');

  // Show multi-menu-item header
  if (isMulti) {
    html += `<div style="margin-bottom:8px;font-size:11px;color:#605e5c;">`;
    html += `Searching across <strong>${data.menuItems.length}</strong> menu items: ${data.menuItems.map(m => `<span class="badge badge-entry">${esc(m)}</span>`).join(' ')}`;
    if (data.missing && data.missing.length > 0) {
      html += `<br><span style="color:#d13438;">No results for: ${data.missing.map(m => esc(m)).join(', ')}</span>`;
    }
    html += `</div>`;
  }

  if (data.noResults) {
    html += `<div class="narrow-no-result">`;
    if (data.partialCoverage && data.partialRoles && data.partialRoles.length > 0) {
      html += `<strong>No single role covers all menu items</strong><br>`;
      html += `${esc(data.recommendation)}`;
      html += `<div style="margin-top:8px;font-size:11px;font-weight:600;">Best partial coverage:</div>`;
      for (const r of data.partialRoles.slice(0, 10)) {
        html += `<div class="narrow-result-card narrow-other" style="margin-top:4px;">`;
        html += `<div class="narrow-card-header">`;
        html += `<div class="narrow-card-info">`;
        html += `<div class="narrow-card-name">${esc(r.roleName)}</div>`;
        html += `<div class="narrow-card-id">${esc(r.roleId)} - covers ${r.coveredCount}/${r.totalMenuItems}: ${r.covered.map(m => esc(m)).join(', ')}</div>`;
        html += `</div></div>`;
        html += `<div class="narrow-card-body">${renderAccessBadges(r)}</div>`;
        html += `</div>`;
      }
    } else {
      html += `<strong>No role grants access to ${displayLabel}</strong><br>`;
      html += `${esc(data.recommendation)}`;
    }

    // Show breakdown: how many Grant vs Deny vs Unset
    if (data.totalRoles) {
      html += `<div style="margin-top:8px;font-size:11px;">`;
      html += `<strong>${data.totalRoles}</strong> roles reference this menu item: `;
      if (data.grantCount) html += `<span class="badge badge-read">${data.grantCount} Grant</span> `;
      if (data.denyCount) html += `<span class="badge badge-deny">${data.denyCount} Deny</span> `;
      if (data.unsetCount) html += `<span class="badge badge-entry">${data.unsetCount} Unset</span> `;
      html += `</div>`;
    }

    // Show Deny roles detail
    if (data.denyInfo && data.denyInfo.length > 0) {
      html += `<div style="margin-top:8px;font-size:11px;font-weight:600;">Roles with explicit Deny:</div>`;
      for (const r of data.denyInfo) {
        html += `<div class="perm-card" style="margin-top:4px;">`;
        html += `<div class="perm-field"><span class="perm-field-key">Role</span><span class="perm-field-val">${esc(r.roleName)}</span></div>`;
        const fields = ['read','update','create','delete','invoke','correct'];
        for (const f of fields) {
          const val = r[f];
          const cls = val === 'Grant' ? 'style="color:#107c10;font-weight:700"' : val === 'Deny' ? 'style="color:#d13438;font-weight:700"' : 'style="color:#a19f9d"';
          html += `<div class="perm-field"><span class="perm-field-key">${esc(f.charAt(0).toUpperCase() + f.slice(1))}</span><span class="perm-field-val" ${cls}>${esc(val)}</span></div>`;
        }
        html += `</div>`;
      }
    }

    if (data.privilegeHint && data.privilegeHint.resources) {
      html += `<div style="margin-top:6px;font-size:11px;color:#605e5c;">Did you mean one of these?</div>`;
      html += `<div class="narrow-similar">`;
      for (const res of data.privilegeHint.resources) {
        html += `<span class="narrow-similar-item" data-mi="${esc(res)}">${esc(res)}</span>`;
      }
      html += `</div>`;
    }
    html += `</div>`;

    container.innerHTML = html;

    // Wire similar item clicks to re-search
    container.querySelectorAll('.narrow-similar-item').forEach(item => {
      item.addEventListener('click', () => {
        document.getElementById('narrowInput').value = item.dataset.mi;
        runNarrowSearch();
      });
    });
    return;
  }

  // Show narrowest (best) role first
  const best = data.narrowest;
  html += `<div class="narrow-result-card narrow-best">`;
  html += `<div class="narrow-card-header">`;
  html += `<div class="narrow-card-info">`;
  html += `<div class="narrow-card-name">${esc(best.roleName)}</div>`;
  html += `<div class="narrow-card-id">${esc(best.roleId)}</div>`;
  html += `</div>`;
  html += `<div class="narrow-card-stats">`;
  html += `<div class="narrow-stat"><div class="narrow-stat-num">${best.totalPermissions}</div><div class="narrow-stat-label">Perms</div></div>`;
  html += `<div class="narrow-stat"><div class="narrow-stat-num">${best.grantCount || 0}/6</div><div class="narrow-stat-label">Access</div></div>`;
  html += `<div class="narrow-stat"><div class="narrow-stat-num">${best.userCount}</div><div class="narrow-stat-label">Users</div></div>`;
  html += `</div>`;
  html += `</div>`;
  html += `<div class="narrow-card-body">`;
  html += `<span class="narrow-best-tag">NARROWEST</span>`;
  html += renderAccessBadges(best);
  html += `</div>`;
  if (best.duties.length > 0) {
    html += `<div class="narrow-duties-list">Via duties: ${best.duties.map(d => `<span>${esc(d)}</span>`).join(', ')}</div>`;
  }
  if (best.privileges.length > 0) {
    html += `<div class="narrow-duties-list">Via privileges: ${best.privileges.map(p => `<span>${esc(p)}</span>`).join(', ')}</div>`;
  }
  // Per-menu-item breakdown for multi search
  if (isMulti && best.perMenuItem) {
    html += `<div style="margin-top:6px;font-size:11px;border-top:1px solid #edebe9;padding-top:6px;">`;
    html += `<div style="font-weight:600;margin-bottom:4px;">Per menu item access:</div>`;
    for (const mi of Object.keys(best.perMenuItem)) {
      html += `<div style="margin-bottom:2px;"><span class="badge badge-entry">${esc(mi)}</span> ${renderAccessBadges(best.perMenuItem[mi])}</div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;

  // Show narrowest privilege
  if (data.narrowestPrivilege) {
    html += renderNarrowestPrivilege(data.narrowestPrivilege, data.rankedPrivileges);
  }

  // Show narrowest duty
  if (data.narrowestDuty) {
    html += renderNarrowestDuty(data.narrowestDuty, data.rankedDuties);
  }

  // Show other role candidates (collapsed if many)
  if (data.roles.length > 1) {
    html += `<div style="margin-top:8px;font-size:11px;color:#605e5c;cursor:pointer;" id="narrowShowMore">Other candidates (${data.roles.length - 1}) ▸</div>`;
    html += `<div id="narrowOtherRoles" class="hidden">`;
    for (let i = 1; i < data.roles.length; i++) {
      const r = data.roles[i];
      html += `<div class="narrow-result-card narrow-other">`;
      html += `<div class="narrow-card-header">`;
      html += `<div class="narrow-card-info">`;
      html += `<div class="narrow-card-name">${esc(r.roleName)}</div>`;
      html += `<div class="narrow-card-id">${esc(r.roleId)}</div>`;
      html += `</div>`;
      html += `<div class="narrow-card-stats">`;
      html += `<div class="narrow-stat"><div class="narrow-stat-num">${r.totalPermissions}</div><div class="narrow-stat-label">Perms</div></div>`;
      html += `<div class="narrow-stat"><div class="narrow-stat-num">${r.grantCount || 0}/6</div><div class="narrow-stat-label">Access</div></div>`;
      html += `<div class="narrow-stat"><div class="narrow-stat-num">${r.userCount}</div><div class="narrow-stat-label">Users</div></div>`;
      html += `</div>`;
      html += `</div>`;
      html += `<div class="narrow-card-body">`;
      html += `<span class="narrow-rank">#${i + 1}</span>`;
      html += renderAccessBadges(r);
      html += `</div>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  // Show privilege → duty → role chain
  const chainLabel = isMulti ? 'all menu items' : esc(data.menuItem || (data.menuItems && data.menuItems[0]) || '');
  if (data.privileges && data.privileges.length > 0) {
    html += `<div class="narrow-chain">`;
    html += `<div class="narrow-chain-title" id="narrowPrivToggle">Privileges referencing ${chainLabel} (${data.privileges.length}) ▸</div>`;
    html += `<div id="narrowPrivList" class="hidden">`;
    for (const pr of data.privileges) {
      html += `<div class="narrow-chain-item">`;
      html += `<span class="narrow-chain-name">${esc(pr.name)}</span>`;
      if (isMulti && pr.menuItem) html += `<span class="badge badge-entry" style="margin-left:4px;">${esc(pr.menuItem)}</span>`;
      html += renderAccessBadges(pr);
      html += `</div>`;
      if (pr.duties && pr.duties.length > 0) {
        html += `<div class="narrow-chain-sub">Duties: ${pr.duties.map(d => esc(d.name || d)).join(', ')}</div>`;
      }
      if (pr.roles && pr.roles.length > 0) {
        html += `<div class="narrow-chain-sub">Roles: ${pr.roles.map(r => esc(r.name)).join(', ')}</div>`;
      }
    }
    html += `</div></div>`;
  }

  if (data.duties && data.duties.length > 0) {
    html += `<div class="narrow-chain">`;
    html += `<div class="narrow-chain-title" id="narrowDutyToggle">Duties referencing ${chainLabel} (${data.duties.length}) ▸</div>`;
    html += `<div id="narrowDutyList" class="hidden">`;
    for (const d of data.duties) {
      html += `<div class="narrow-chain-item">`;
      html += `<span class="narrow-chain-name">${esc(d.name)}</span>`;
      html += `<span class="narrow-chain-id">${esc(d.id)}</span>`;
      if (isMulti && d.menuItem) html += `<span class="badge badge-entry" style="margin-left:4px;">${esc(d.menuItem)}</span>`;
      html += `</div>`;
      if (d.privileges && d.privileges.length > 0) {
        html += `<div class="narrow-chain-sub">Privileges: ${d.privileges.map(p => esc(p.name || p)).join(', ')}</div>`;
      }
      if (d.roles && d.roles.length > 0) {
        html += `<div class="narrow-chain-sub">Roles: ${d.roles.map(r => esc(r.name || r)).join(', ')}</div>`;
      }
    }
    html += `</div></div>`;
  }

  container.innerHTML = html;

  // Wire show more toggle
  const showMore = document.getElementById('narrowShowMore');
  if (showMore) {
    showMore.addEventListener('click', () => {
      const list = document.getElementById('narrowOtherRoles');
      list.classList.toggle('hidden');
      showMore.textContent = list.classList.contains('hidden')
        ? `Other candidates (${data.roles.length - 1}) ▸`
        : `Other candidates (${data.roles.length - 1}) ▾`;
    });
  }

  // Wire privilege/duty narrowest toggles
  const showMorePriv = document.getElementById('narrowShowMorePriv');
  if (showMorePriv) {
    showMorePriv.addEventListener('click', () => {
      const list = document.getElementById('narrowOtherPrivs');
      list.classList.toggle('hidden');
      showMorePriv.textContent = list.classList.contains('hidden')
        ? `Other privileges (${data.rankedPrivileges.length - 1}) ▸`
        : `Other privileges (${data.rankedPrivileges.length - 1}) ▾`;
    });
  }
  const showMoreDuty = document.getElementById('narrowShowMoreDuty');
  if (showMoreDuty) {
    showMoreDuty.addEventListener('click', () => {
      const list = document.getElementById('narrowOtherDuties');
      list.classList.toggle('hidden');
      showMoreDuty.textContent = list.classList.contains('hidden')
        ? `Other duties (${data.rankedDuties.length - 1}) ▸`
        : `Other duties (${data.rankedDuties.length - 1}) ▾`;
    });
  }

  // Wire chain toggles
  const privToggle = document.getElementById('narrowPrivToggle');
  if (privToggle) {
    privToggle.addEventListener('click', () => {
      const list = document.getElementById('narrowPrivList');
      list.classList.toggle('hidden');
      const count = data.privileges.length;
      privToggle.textContent = list.classList.contains('hidden')
        ? `Privileges referencing ${chainLabel} (${count}) ▸`
        : `Privileges referencing ${chainLabel} (${count}) ▾`;
    });
  }
  const dutyToggle = document.getElementById('narrowDutyToggle');
  if (dutyToggle) {
    dutyToggle.addEventListener('click', () => {
      const list = document.getElementById('narrowDutyList');
      list.classList.toggle('hidden');
      const count = data.duties.length;
      dutyToggle.textContent = list.classList.contains('hidden')
        ? `Duties referencing ${chainLabel} (${count}) ▸`
        : `Duties referencing ${chainLabel} (${count}) ▾`;
    });
  }
}

// ============ User Role Recommendation ============

async function runUserRecommend() {
  const miInput = document.getElementById('narrowInput');
  const userInput = document.getElementById('narrowUserId');
  const container = document.getElementById('narrowUserResults');
  if (!miInput || !userInput || !container) return;

  const raw = miInput.value.trim();
  const userText = userInput.value.trim();
  if (!raw) { container.innerHTML = '<div class="drill-error">Enter menu item name(s) first.</div>'; return; }
  if (!userText) { container.innerHTML = '<div class="drill-error">Enter one or more User IDs.</div>'; return; }

  const menuItems = raw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  const userIds = userText.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);

  let baseUrl = currentPage ? currentPage.d365Url : null;
  if (!baseUrl) {
    try {
      const page = await send({ action: 'getPageInfo' });
      baseUrl = page.d365Url;
    } catch (e) {
      container.innerHTML = '<div class="drill-error">Navigate to a D365 page first.</div>';
      return;
    }
  }

  const miLabel = menuItems.length > 1 ? `${menuItems.length} menu items` : esc(menuItems[0]);
  container.innerHTML = `<div class="drill-loading"><div class="spinner-sm"></div> Analyzing ${userIds.length} user(s) for ${miLabel}...</div>`;

  try {
    const data = await send({
      action: 'recommendForUser',
      userIds,
      menuItems,
      baseUrl
    });
    renderUserRecommend(data, container);
  } catch (err) {
    container.innerHTML = `<div class="drill-error">${esc(err.message)}</div>`;
  }
}

function renderUserRecommend(data, container) {
  let html = '';
  const isMulti = data.menuItems && data.menuItems.length > 1;
  const displayLabel = isMulti
    ? data.menuItems.map(m => esc(m)).join(', ')
    : esc(data.menuItem || (data.menuItems && data.menuItems[0]) || '');

  if (data.noRolesExist) {
    html += `<div class="narrow-no-result">`;
    html += `<strong>${esc(data.recommendation)}</strong>`;
    if (data.missing && data.missing.length > 0) {
      html += `<br><span style="color:#d13438;">No results for: ${data.missing.map(m => esc(m)).join(', ')}</span>`;
    }
    html += `</div>`;
    container.innerHTML = html;
    return;
  }

  // Multi-menu-item header
  if (isMulti) {
    html += `<div style="margin-bottom:8px;font-size:11px;color:#605e5c;">`;
    html += `Analyzing access for <strong>${data.menuItems.length}</strong> menu items: ${data.menuItems.map(m => `<span class="badge badge-entry">${esc(m)}</span>`).join(' ')}`;
    if (data.missing && data.missing.length > 0) {
      html += `<br><span style="color:#d13438;">No results for: ${data.missing.map(m => esc(m)).join(', ')}</span>`;
    }
    html += `</div>`;
  }

  // Per-user status
  for (const u of data.users) {
    if (!u.found) {
      html += `<div class="narrow-user-card user-no-access"><div class="narrow-user-header">`;
      html += `<div class="narrow-user-title">${esc(u.userId)}</div>`;
      html += `<div class="narrow-user-subtitle">User not found</div>`;
      html += `</div></div>`;
      continue;
    }

    html += `<div class="narrow-user-card ${u.alreadyHasAccess ? 'user-has-access' : 'user-needs-role'}">`;
    html += `<div class="narrow-user-header">`;
    html += `<div class="narrow-user-title">${esc(u.userId)}</div>`;
    html += `<div class="narrow-user-subtitle">${u.totalRoles} roles assigned</div>`;
    html += `</div>`;
    html += `<div class="narrow-user-body">`;

    if (u.alreadyHasAccess) {
      html += `<div class="narrow-user-status status-has-access">Already has access to all menu items</div>`;
      html += `<div style="font-size:11px;margin-bottom:4px;">Effective: ${renderAccessBadges(u.effectiveAccess)}</div>`;
      // Show which roles grant access
      if (u.perMenuItem) {
        const allGrantingRoles = new Map(); // roleId -> {roleName, access per mi}
        for (const mi of Object.keys(u.perMenuItem)) {
          const pm = u.perMenuItem[mi];
          if (pm.grantingRoles) {
            for (const gr of pm.grantingRoles) {
              if (!allGrantingRoles.has(gr.roleId)) {
                allGrantingRoles.set(gr.roleId, { roleName: gr.roleName, roleId: gr.roleId, access: { read:0, update:0, create:0, delete:0, invoke:0, correct:0 } });
              }
              const entry = allGrantingRoles.get(gr.roleId);
              for (const f of ['read','update','create','delete','invoke','correct']) {
                if (gr[f] === 1) entry.access[f] = 1;
              }
            }
          }
        }
        if (allGrantingRoles.size > 0) {
          html += `<div style="margin-top:4px;font-size:11px;"><strong>Granted by:</strong>`;
          for (const [roleId, info] of allGrantingRoles) {
            html += `<div style="margin:2px 0 2px 8px;">`;
            html += `<span style="color:#0078d4;font-weight:600;">${esc(info.roleName)}</span>`;
            html += ` <span style="color:#8a8886;">(${esc(roleId)})</span> `;
            html += renderAccessBadges(info.access);
            html += `</div>`;
          }
          html += `</div>`;
        }
      }
    } else if (u.missingMenuItems && u.missingMenuItems.length > 0) {
      html += `<div class="narrow-user-status status-needs-role">Missing access to ${u.missingMenuItems.length} menu item(s)</div>`;
      html += `<div style="font-size:11px;color:#d13438;margin-bottom:4px;">Needs: ${u.missingMenuItems.map(m => `<span class="badge badge-deny">${esc(m)}</span>`).join(' ')}</div>`;
    } else {
      html += `<div class="narrow-user-status status-needs-role">No access - needs a role</div>`;
    }

    // Per-menu-item breakdown (show for both single and multi)
    if (u.perMenuItem) {
      html += `<div style="margin-top:4px;font-size:11px;">`;
      for (const mi of Object.keys(u.perMenuItem)) {
        const pm = u.perMenuItem[mi];
        html += `<div style="margin-bottom:3px;">`;
        html += `<span class="badge badge-entry">${esc(mi)}</span> `;
        if (pm.hasAccess) {
          html += `<span style="color:#107c10;">Has access</span> ${renderAccessBadges(pm.effectiveAccess)}`;
          // Show which roles grant this specific menu item
          if (pm.grantingRoles && pm.grantingRoles.length > 0) {
            html += `<div style="margin-left:12px;color:#605e5c;">`;
            for (const gr of pm.grantingRoles) {
              html += `<div>via <strong>${esc(gr.roleName)}</strong> ${renderAccessBadges(gr)}</div>`;
            }
            html += `</div>`;
          }
        } else {
          html += `<span style="color:#d13438;">No access</span>`;
        }
        html += `</div>`;
      }
      html += `</div>`;
    }

    html += `</div></div>`;
  }

  // Recommendation section
  const needsAccess = data.users.filter(u => u.found && !u.alreadyHasAccess);

  if (needsAccess.length === 0) {
    html += `<div style="margin-top:10px;font-size:12px;color:#107c10;font-weight:600;">All users already have access to all menu items.</div>`;
    container.innerHTML = html;
    return;
  }

  html += `<div style="margin-top:12px;">`;
  html += `<div class="drill-section-title">Recommendations for ${needsAccess.map(u => esc(u.userId)).join(', ')}</div>`;

  // No single role covers all?
  if (data.noFullCoverageRole) {
    html += `<div style="margin-top:6px;font-size:11px;color:#d13438;font-weight:600;">No single role covers all ${isMulti ? data.menuItems.length + ' menu items' : 'access'}. Multiple roles or privilege additions needed.</div>`;
  }

  // Option A: Modify a common role (add privilege/duty)
  if (data.commonRolesWithoutAccess && data.commonRolesWithoutAccess.length > 0) {
    html += `<div style="margin-top:8px;">`;
    html += `<div style="font-size:12px;font-weight:700;color:#8764b8;margin-bottom:4px;">Option A: Add privilege to a shared role</div>`;
    html += `<div style="font-size:11px;color:#605e5c;margin-bottom:6px;">All ${needsAccess.length} users share these roles. Add duty/privilege to grant access without assigning a new role:</div>`;

    for (const r of data.commonRolesWithoutAccess.slice(0, 10)) {
      html += `<div class="narrow-chain-item">`;
      html += `<span class="narrow-chain-name">${esc(r.roleName)}</span>`;
      html += `<span class="narrow-chain-id">${esc(r.roleId)}`;
      if (isMulti && r.coversMenuItems && r.coversMenuItems.length > 0) {
        html += ` - already covers: ${r.coversMenuItems.map(m => esc(m)).join(', ')}`;
      }
      html += `</span>`;
      html += `</div>`;
    }

    // Show needed privileges/duties per menu item for multi
    if (isMulti && data.neededPerMenuItem) {
      html += `<div style="margin-top:6px;font-size:11px;">`;
      html += `<strong>Needed privileges/duties per menu item:</strong>`;
      for (const mi of Object.keys(data.neededPerMenuItem)) {
        const nd = data.neededPerMenuItem[mi];
        html += `<div style="margin-top:4px;"><span class="badge badge-entry">${esc(mi)}</span></div>`;
        if (nd.privileges.length > 0) {
          html += `<div style="margin-left:8px;">Privileges: ${nd.privileges.map(p => `<span class="badge ${data.privilegesAreGrant ? 'badge-invoke' : 'badge-deny'}">${esc(p)}</span>`).join(' ')}</div>`;
        }
        if (nd.duties.length > 0) {
          html += `<div style="margin-left:8px;">Duties: ${nd.duties.map(d => `<span class="badge badge-read">${esc(d)}</span>`).join(' ')}</div>`;
        }
      }
      html += `</div>`;
    } else {
      // Single menu item - show flat list
      if (data.neededPrivileges.length > 0) {
        html += `<div style="margin-top:6px;font-size:11px;">`;
        if (data.privilegesAreGrant) {
          html += `<strong>Add one of these privileges:</strong> `;
        } else {
          html += `<strong>Privileges referencing this menu item</strong> (currently Deny/Unset - need Grant access): `;
        }
        html += data.neededPrivileges.map(p => `<span class="badge ${data.privilegesAreGrant ? 'badge-invoke' : 'badge-deny'}">${esc(p)}</span>`).join(' ');
        html += `</div>`;
      }
      if (data.neededDuties.length > 0) {
        html += `<div style="margin-top:4px;font-size:11px;">`;
        if (data.privilegesAreGrant) {
          html += `<strong>Or add one of these duties:</strong> `;
        } else {
          html += `<strong>Duties referencing this menu item:</strong> `;
        }
        html += data.neededDuties.map(d => `<span class="badge badge-read">${esc(d)}</span>`).join(' ');
        html += `</div>`;
      }
    }
    html += `</div>`;
  }

  // Option B: Assign a new role
  if (data.recommendedRole) {
    html += `<div style="margin-top:10px;">`;
    html += `<div style="font-size:12px;font-weight:700;color:#0078d4;margin-bottom:4px;">`;
    html += data.commonRolesWithoutAccess?.length > 0 ? 'Option B: Assign a new role' : 'Recommendation: Assign narrowest role';
    if (isMulti) html += ` (covers all ${data.menuItems.length} menu items)`;
    html += `</div>`;

    const rec = data.recommendedRole;
    html += `<div class="narrow-result-card narrow-best">`;
    html += `<div class="narrow-card-header">`;
    html += `<div class="narrow-card-info">`;
    html += `<div class="narrow-card-name">${esc(rec.roleName)}</div>`;
    html += `<div class="narrow-card-id">${esc(rec.roleId)}</div>`;
    html += `</div>`;
    html += `<div class="narrow-card-stats">`;
    html += `<div class="narrow-stat"><div class="narrow-stat-num">${rec.totalPermissions}</div><div class="narrow-stat-label">Perms</div></div>`;
    html += `</div>`;
    html += `</div>`;
    html += `<div class="narrow-card-body">`;
    html += `<span class="narrow-best-tag">NARROWEST</span>`;
    html += renderAccessBadges(rec);
    html += `</div>`;
    if (rec.duties.length > 0) {
      html += `<div class="narrow-duties-list">Via duties: ${rec.duties.map(d => `<span>${esc(d)}</span>`).join(', ')}</div>`;
    }
    if (rec.privileges.length > 0) {
      html += `<div class="narrow-duties-list">Via privileges: ${rec.privileges.map(p => `<span>${esc(p)}</span>`).join(', ')}</div>`;
    }
    if (isMulti && rec.menuItemsCovered) {
      html += `<div class="narrow-duties-list">Covers: ${rec.menuItemsCovered.map(m => `<span class="badge badge-entry">${esc(m)}</span>`).join(' ')}</div>`;
    }
    html += `</div>`;

    if (data.alternativeRoles.length > 0) {
      html += `<div style="margin-top:4px;font-size:11px;color:#605e5c;">${data.alternativeRoles.length} other role(s) also grant access to all menu items.</div>`;
    }
    html += `</div>`;
  }

  // Narrowest privilege
  if (data.narrowestPrivilege) {
    html += renderNarrowestPrivilege(data.narrowestPrivilege, data.rankedPrivileges);
  }

  // Narrowest duty
  if (data.narrowestDuty) {
    html += renderNarrowestDuty(data.narrowestDuty, data.rankedDuties);
  }

  html += `</div>`;
  container.innerHTML = html;

  // Wire privilege/duty collapsible toggles
  const showMorePriv = container.querySelector('#narrowShowMorePriv');
  if (showMorePriv) {
    showMorePriv.addEventListener('click', () => {
      const list = container.querySelector('#narrowOtherPrivs');
      list.classList.toggle('hidden');
      showMorePriv.textContent = list.classList.contains('hidden')
        ? `Other privileges (${data.rankedPrivileges.length - 1}) ▸`
        : `Other privileges (${data.rankedPrivileges.length - 1}) ▾`;
    });
  }
  const showMoreDuty = container.querySelector('#narrowShowMoreDuty');
  if (showMoreDuty) {
    showMoreDuty.addEventListener('click', () => {
      const list = container.querySelector('#narrowOtherDuties');
      list.classList.toggle('hidden');
      showMoreDuty.textContent = list.classList.contains('hidden')
        ? `Other duties (${data.rankedDuties.length - 1}) ▸`
        : `Other duties (${data.rankedDuties.length - 1}) ▾`;
    });
  }
}

// ============ Role Removal Impact (client-side) ============

function renderImpactAnalysis(roleNames, roleIds) {
  if (!currentData) return '';

  // For each role in this group, compute: if removed, who loses access?
  let html = `<div class="impact-section">`;
  html += `<div class="drill-section-title">Role Removal Impact</div>`;

  for (let i = 0; i < roleIds.length; i++) {
    const roleId = roleIds[i];
    const roleName = roleNames[i] || roleId;
    const roleObj = currentData.roles.find(r => r.roleId === roleId);

    // Find all users who have this role
    const usersWithRole = currentData.users.filter(u => u.roleIds && u.roleIds.includes(roleId));

    if (usersWithRole.length === 0) {
      html += `<div class="impact-role-header">${esc(roleName)}: no users affected</div>`;
      continue;
    }

    // For each user: what happens if this role is removed?
    const losesAll = [];
    const losesPartial = [];
    const retains = [];

    for (const u of usersWithRole) {
      // Other roles the user has that also grant access to this menu item
      const otherRoleIds = (u.roleIds || []).filter(rid => rid !== roleId);
      const otherGranting = otherRoleIds.filter(rid => currentData.roles.some(r => r.roleId === rid));

      if (otherGranting.length === 0) {
        // User LOSES ALL access to this menu item
        losesAll.push(u.userId);
      } else {
        // User retains access through other roles - but might lose some access levels
        // Compute remaining access
        let rRead = 0, rUpdate = 0, rCreate = 0, rDelete = 0;
        for (const rid of otherGranting) {
          const r = currentData.roles.find(role => role.roleId === rid);
          if (r) {
            if (r.read === 1) rRead = 1;
            if (r.update === 1) rUpdate = 1;
            if (r.create === 1) rCreate = 1;
            if (r.delete === 1) rDelete = 1;
          }
        }

        // What does the removed role specifically grant?
        const lostLevels = [];
        if (roleObj) {
          if (roleObj.read === 1 && !rRead) lostLevels.push('Read');
          if (roleObj.update === 1 && !rUpdate) lostLevels.push('Update');
          if (roleObj.create === 1 && !rCreate) lostLevels.push('Create');
          if (roleObj.delete === 1 && !rDelete) lostLevels.push('Delete');
        }

        if (lostLevels.length > 0) {
          losesPartial.push({ userId: u.userId, loses: lostLevels });
        } else {
          retains.push(u.userId);
        }
      }
    }

    html += `<div class="impact-block">`;
    html += `<div class="impact-role-header">If <strong>${esc(roleName)}</strong> is removed:</div>`;

    if (losesAll.length > 0) {
      html += `<div class="impact-row impact-danger">`;
      html += `<span class="impact-icon">LOSE ALL ACCESS</span>`;
      html += `<span class="impact-users">${losesAll.map(id => esc(id)).join(', ')}</span>`;
      html += `<span class="impact-count">${losesAll.length}</span>`;
      html += `</div>`;
    }

    if (losesPartial.length > 0) {
      html += `<div class="impact-row impact-warn">`;
      html += `<span class="impact-icon">LOSE PARTIAL</span>`;
      html += `<div class="impact-details">`;
      for (const p of losesPartial) {
        html += `<div>${esc(p.userId)} loses: ${p.loses.map(l =>
          `<span class="badge badge-delete">${esc(l)}</span>`).join(' ')}</div>`;
      }
      html += `</div>`;
      html += `</div>`;
    }

    if (retains.length > 0) {
      html += `<div class="impact-row impact-safe">`;
      html += `<span class="impact-icon">STILL HAVE ACCESS</span>`;
      html += `<span class="impact-users">${retains.map(id => esc(id)).join(', ')}</span>`;
      html += `<span class="impact-count">${retains.length}</span>`;
      html += `</div>`;
    }

    html += `</div>`;
  }

  html += `</div>`;
  return html;
}
