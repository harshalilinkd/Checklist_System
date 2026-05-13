import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SUPABASE_URL = 'https://hwawiudaevydbglzdync.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh3YXdpdWRhZXZ5ZGJnbHpkeW5jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzMTg0OTYsImV4cCI6MjA5Mzg5NDQ5Nn0.5-4Np45ANbunPXxwaXT_95vpDsUm34PNJQskDpDr_sQ';

// In production, replace this with your Render backend URL.
const PRODUCTION_API_BASE = 'https://checklist-backend.onrender.com';
const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const API_BASE = isLocal ? 'http://localhost:3000' : PRODUCTION_API_BASE;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
window.SESSION = null;
window.STATE = { doers: [], tasks: [], master: [] };
let currentTab = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
};
const showLoading = (on) => $('#loading-overlay').hidden = !on;
const showToast = (msg, kind = '') => {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast ' + kind; t.hidden = false;
  clearTimeout(t._timer); t._timer = setTimeout(() => t.hidden = true, 3000);
};

async function api(path, opts = {}) {
  opts.headers = {
    ...(opts.headers || {}),
    'Authorization': 'Bearer ' + SESSION.token,
    'Content-Type': 'application/json',
  };
  const res = await fetch(API_BASE + path, opts);
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const email = fd.get('email'); const password = fd.get('password');
  const errEl = $('#login-error'); errEl.hidden = true;
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    SESSION = { token: data.session.access_token, email, isAdmin: false };
    await afterLogin();
  } catch (err) {
    errEl.textContent = err.message; errEl.hidden = false;
  }
});

$('#logout-btn').addEventListener('click', () => logout());

function logout() {
  SESSION = null; window.STATE = { doers: [], tasks: [], master: [] };
  $('#login-screen').hidden = false;
  $('#app-screen').hidden = true;
}

async function afterLogin() {
  $('#login-screen').hidden = true;
  $('#app-screen').hidden = false;
  showLoading(true);
  try {
    // bootstrap returns user + doers + tasks + masterWindow in one round trip
    const boot = await api('/api/bootstrap');
    SESSION.isAdmin = boot.user.isAdmin;
    SESSION.email = boot.user.email;
    $('#user-email').textContent = boot.user.email + (boot.user.isAdmin ? ' (admin)' : '');

    STATE.doers = boot.doers;
    STATE.tasks = boot.tasks;
    STATE.master = boot.masterWindow.rows;
    STATE.nextCursor = boot.masterWindow.nextCursor;

    renderTabs();
    selectTab(SESSION.isAdmin ? 'dashboard' : 'master');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    showLoading(false);
  }
}

// Restore session on reload
(async () => {
  const { data } = await supabase.auth.getSession();
  if (data.session) {
    SESSION = { token: data.session.access_token, email: data.session.user.email, isAdmin: false };
    await afterLogin();
  }
})();

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function renderTabs() {
  const tabs = SESSION.isAdmin
    ? [['dashboard', 'Dashboard'], ['master', 'Master Checklist'], ['doers', 'Doers'], ['tasks', 'Tasks']]
    : [['master', 'My Checklist']];
  const nav = $('#tabs'); nav.innerHTML = '';
  for (const [id, label] of tabs) {
    nav.appendChild(el('button', {
      'data-tab': id,
      onclick: () => selectTab(id),
    }, label));
  }
}

function selectTab(id) {
  currentTab = id;
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  const root = $('#tab-content'); root.innerHTML = '';
  if (id === 'dashboard') renderDashboard(root);
  else if (id === 'master') renderMaster(root);
  else if (id === 'doers') renderDoers(root);
  else if (id === 'tasks') renderTasks(root);
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
function renderDashboard(root) {
  const counts = { Total: STATE.master.length, Done: 0, Delayed: 0, Today: 0, 'Upcoming Focus': 0, Scheduled: 0 };
  for (const r of STATE.master) counts[r.status] = (counts[r.status] || 0) + 1;
  const cards = el('div', { class: 'cards' });
  for (const [label, n] of Object.entries(counts)) {
    cards.appendChild(el('div', { class: 'stat-card' },
      el('div', { class: 'label' }, label),
      el('div', { class: 'value' }, String(n)),
    ));
  }
  root.appendChild(el('h2', {}, 'Overview'));
  root.appendChild(cards);
  root.appendChild(el('p', { class: 'muted' }, `Showing first ${STATE.master.length} rows of master window. Switch to Master Checklist for the full filtered table.`));
}

// ---------------------------------------------------------------------------
// Master Checklist
// ---------------------------------------------------------------------------
const KPI_STATUSES = ['Today', 'Delayed', 'Done', 'Upcoming Focus'];

function renderMaster(root) {
  const filterState = { doer: '', task: '', status: '', from: '', to: '' };

  const filtersBar = el('div', { class: 'filters' });
  if (SESSION.isAdmin) {
    const doerSel = el('select', { id: 'f-doer', onchange: (e) => { filterState.doer = e.target.value; cascadeTasks(); apply(); } },
      el('option', { value: '' }, 'All doers'),
      ...STATE.doers.map(d => el('option', { value: d.email }, d.name)),
    );
    filtersBar.appendChild(el('label', {}, 'Doer', doerSel));
  }
  const taskSel = el('select', { id: 'f-task', onchange: (e) => { filterState.task = e.target.value; apply(); } },
    el('option', { value: '' }, 'All tasks'),
    ...STATE.tasks.map(t => el('option', { value: t.task_id }, t.task_name)),
  );
  filtersBar.appendChild(el('label', {}, 'Task', taskSel));

  const statusSel = el('select', { id: 'f-status', onchange: (e) => { filterState.status = e.target.value; apply(); } },
    ...['', 'Delayed', 'Today', 'Upcoming Focus', 'Scheduled', 'Done'].map(s => el('option', { value: s }, s || 'All statuses')),
  );
  filtersBar.appendChild(el('label', {}, 'Status', statusSel));

  filtersBar.appendChild(el('label', {}, 'From',
    el('input', { type: 'date', oninput: (e) => { filterState.from = e.target.value; apply(); } }),
  ));
  filtersBar.appendChild(el('label', {}, 'To',
    el('input', { type: 'date', oninput: (e) => { filterState.to = e.target.value; apply(); } }),
  ));

  // KPI cards — counts respect doer/task/date filters but not status filter.
  // Clicking a card toggles that status as the active filter.
  const kpiBar = el('div', { class: 'kpi-cards' });
  for (const s of KPI_STATUSES) {
    const card = el('div', {
      class: 'kpi-card kpi-' + s.replace(/\s+/g, ''),
      'data-kpi': s,
      onclick: () => {
        filterState.status = filterState.status === s ? '' : s;
        const sel = filtersBar.querySelector('#f-status');
        if (sel) sel.value = filterState.status;
        apply();
      },
    },
      el('div', { class: 'label' }, s),
      el('div', { class: 'value' }, '0'),
    );
    kpiBar.appendChild(card);
  }

  const tableWrap = el('div', { id: 'master-table' });
  root.appendChild(filtersBar);
  root.appendChild(kpiBar);
  root.appendChild(tableWrap);

  function cascadeTasks() {
    const sel = $('#f-task');
    const filtered = filterState.doer
      ? STATE.tasks.filter(t => t.doer_email === filterState.doer)
      : STATE.tasks;
    sel.innerHTML = '';
    sel.appendChild(el('option', { value: '' }, 'All tasks'));
    for (const t of filtered) sel.appendChild(el('option', { value: t.task_id }, t.task_name));
    filterState.task = '';
  }

  function apply() {
    // Base filter (everything except status) — feeds KPI counts.
    const base = STATE.master.filter(r =>
      (!filterState.doer || r.doer_email === filterState.doer) &&
      (!filterState.task || r.task_id === filterState.task) &&
      (!filterState.from || r.planned_date >= filterState.from) &&
      (!filterState.to || r.planned_date <= filterState.to)
    );

    // Update KPI cards
    const counts = {};
    for (const r of base) counts[r.status] = (counts[r.status] || 0) + 1;
    for (const s of KPI_STATUSES) {
      const card = kpiBar.querySelector(`[data-kpi="${s}"]`);
      card.querySelector('.value').textContent = counts[s] || 0;
      card.classList.toggle('active', filterState.status === s);
    }

    // Table rows additionally narrowed by status filter.
    const rows = filterState.status ? base.filter(r => r.status === filterState.status) : base;
    tableWrap.innerHTML = '';
    if (rows.length === 0) { tableWrap.appendChild(el('p', { class: 'muted' }, 'No matching rows.')); return; }
    const table = el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Date'), el('th', {}, 'Task'), el('th', {}, 'Doer'),
        el('th', {}, 'Freq'), el('th', {}, 'Status'), el('th', {}, 'Action'),
      )),
      el('tbody', {}, rows.map(r => el('tr', { 'data-key': r.occurrence_key },
        el('td', {}, r.planned_date),
        el('td', {}, r.task_name),
        el('td', {}, r.doer_email),
        el('td', {}, r.freq || ''),
        el('td', {}, el('span', { class: 'badge ' + r.status.replace(/\s+/g, '') }, r.status)),
        el('td', {}, r.status !== 'Done'
          ? el('button', { class: 'btn-sm', onclick: () => markDone(r.occurrence_key) }, 'Done')
          : el('span', { class: 'muted' }, r.actual_date || '')),
      ))),
    );
    tableWrap.appendChild(table);
    tableWrap.appendChild(el('p', { class: 'muted' }, `${rows.length} rows`));
  }
  apply();
}

function markDone(occurrenceKey) {
  const row = STATE.master.find(r => r.occurrence_key === occurrenceKey);
  if (!row) return;
  const prev = { status: row.status, actual_date: row.actual_date };
  row.status = 'Done';
  row.actual_date = new Date().toISOString().slice(0, 10);
  if (currentTab === 'master') selectTab('master');

  api('/api/master/' + encodeURIComponent(occurrenceKey) + '/done', { method: 'POST', body: '{}' })
    .then(() => showToast('Marked done'))
    .catch(err => {
      row.status = prev.status; row.actual_date = prev.actual_date;
      if (currentTab === 'master') selectTab('master');
      showToast('Failed: ' + err.message, 'error');
    });
}

// ---------------------------------------------------------------------------
// Doers
// ---------------------------------------------------------------------------
function renderDoers(root) {
  root.appendChild(el('h2', {}, 'Doers'));
  root.appendChild(el('button', { class: 'btn-sm', onclick: () => doerModal() }, '+ Add doer'));
  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, 'Name'), el('th', {}, 'Department'), el('th', {}, 'Email'), el('th', {}, ''))),
    el('tbody', {}, STATE.doers.map(d => el('tr', {},
      el('td', {}, d.name),
      el('td', {}, d.department || ''),
      el('td', {}, d.email),
      el('td', {}, el('div', { class: 'row-actions' },
        el('button', { class: 'btn-sm neutral', onclick: () => doerModal(d) }, 'Edit'),
        el('button', { class: 'btn-sm danger', onclick: () => deleteDoer(d) }, 'Delete'),
      )),
    ))),
  );
  root.appendChild(table);
}

function doerModal(doer) {
  const isEdit = !!doer;
  const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } });
  const form = el('form', { onsubmit: async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { name: fd.get('name'), department: fd.get('department'), email: fd.get('email') };
    try {
      if (isEdit) await api('/api/doers/' + doer.id, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/doers', { method: 'POST', body: JSON.stringify(body) });
      showToast(isEdit ? 'Doer updated' : 'Doer created');
      await refreshAndRender();
      backdrop.remove();
    } catch (err) { showToast(err.message, 'error'); }
  }},
    el('label', {}, 'Name', el('input', { name: 'name', required: true, value: doer?.name || '' })),
    el('label', {}, 'Department', el('input', { name: 'department', value: doer?.department || '' })),
    el('label', {}, 'Email', el('input', { name: 'email', type: 'email', required: true, value: doer?.email || '' })),
    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'secondary', onclick: () => backdrop.remove() }, 'Cancel'),
      el('button', { type: 'submit', class: 'primary' }, isEdit ? 'Save' : 'Create'),
    ),
  );
  backdrop.appendChild(el('div', { class: 'modal' }, el('h2', {}, isEdit ? 'Edit doer' : 'Add doer'), form));
  document.body.appendChild(backdrop);
}

async function deleteDoer(d) {
  if (!confirm(`Delete doer ${d.name}?`)) return;
  try {
    await api('/api/doers/' + d.id, { method: 'DELETE' });
    showToast('Deleted');
    await refreshAndRender();
  } catch (err) { showToast(err.message, 'error'); }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
function renderTasks(root) {
  root.appendChild(el('h2', {}, 'Tasks'));
  root.appendChild(el('button', { class: 'btn-sm', onclick: () => taskModal() }, '+ Add task'));
  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, 'Task'), el('th', {}, 'Doer'), el('th', {}, 'Freq'),
      el('th', {}, 'From'), el('th', {}, 'To'), el('th', {}, 'Status'), el('th', {}, ''))),
    el('tbody', {}, STATE.tasks.map(t => el('tr', {},
      el('td', {}, t.task_name),
      el('td', {}, t.doer_email),
      el('td', {}, t.frequency),
      el('td', {}, t.start_date),
      el('td', {}, t.end_date || ''),
      el('td', {}, t.status),
      el('td', {}, el('div', { class: 'row-actions' },
        el('button', { class: 'btn-sm neutral', onclick: () => taskModal(t) }, 'Edit'),
        el('button', { class: 'btn-sm danger', onclick: () => deleteTask(t) }, 'Delete'),
      )),
    ))),
  );
  root.appendChild(table);
}

const FREQ_OPTIONS = ['D', 'W', 'F', 'M', 'Q', 'Y', 'SM', 'E1ST', 'E2ND', 'E3RD', 'E4TH', 'ELAST'];

function taskModal(task) {
  const isEdit = !!task;
  const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } });
  const form = el('form', { onsubmit: async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      task_name: fd.get('task_name'),
      doer_email: fd.get('doer_email'),
      frequency: fd.get('frequency'),
      start_date: fd.get('start_date'),
      end_date: fd.get('end_date') || null,
      assigned_by: fd.get('assigned_by') || null,
      status: fd.get('status'),
    };
    try {
      if (isEdit) await api('/api/tasks/' + task.task_id, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
      showToast(isEdit ? 'Task updated' : 'Task created');
      await refreshAndRender();
      backdrop.remove();
    } catch (err) { showToast(err.message, 'error'); }
  }},
    el('label', {}, 'Task name', el('input', { name: 'task_name', required: true, value: task?.task_name || '' })),
    el('label', {}, 'Doer',
      el('select', { name: 'doer_email', required: true },
        ...STATE.doers.map(d => el('option', { value: d.email, selected: task?.doer_email === d.email }, `${d.name} (${d.email})`)),
      )),
    el('label', {}, 'Frequency',
      el('select', { name: 'frequency', required: true },
        ...FREQ_OPTIONS.map(f => el('option', { value: f, selected: task?.frequency === f }, f)),
      )),
    el('label', {}, 'Start date', el('input', { name: 'start_date', type: 'date', required: true, value: task?.start_date || '' })),
    el('label', {}, 'End date (optional)', el('input', { name: 'end_date', type: 'date', value: task?.end_date || '' })),
    el('label', {}, 'Assigned by', el('input', { name: 'assigned_by', value: task?.assigned_by || '' })),
    el('label', {}, 'Status',
      el('select', { name: 'status' },
        el('option', { value: 'Active', selected: task?.status !== 'Inactive' }, 'Active'),
        el('option', { value: 'Inactive', selected: task?.status === 'Inactive' }, 'Inactive'),
      )),
    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'secondary', onclick: () => backdrop.remove() }, 'Cancel'),
      el('button', { type: 'submit', class: 'primary' }, isEdit ? 'Save' : 'Create'),
    ),
  );
  backdrop.appendChild(el('div', { class: 'modal' }, el('h2', {}, isEdit ? 'Edit task' : 'Add task'), form));
  document.body.appendChild(backdrop);
}

async function deleteTask(t) {
  if (!confirm(`Delete task "${t.task_name}"? This will remove all its master rows.`)) return;
  try {
    await api('/api/tasks/' + t.task_id, { method: 'DELETE' });
    showToast('Deleted');
    await refreshAndRender();
  } catch (err) { showToast(err.message, 'error'); }
}

async function refreshAndRender() {
  const boot = await api('/api/bootstrap');
  STATE.doers = boot.doers;
  STATE.tasks = boot.tasks;
  STATE.master = boot.masterWindow.rows;
  selectTab(currentTab);
}
