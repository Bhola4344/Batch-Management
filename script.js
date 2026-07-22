      const CONFIG = { WEBAPP_URL: 'https://script.google.com/macros/s/AKfycbw-lLKVVs6Eopiur7dHY7Mx5TCROM2EiqpaJJIJypPu541KNfmjm1xfqAyHjfMWXEZYiA/exec', API_TOKEN: 'a8f3k9x2m4p7q1w5e6r8t3y9u2i4o7' };
      let receiving = [], issues = [], editIndex = null, editIssueIndex = null, isSaving = false, pendingPartyIdx = null, pendingCancelIssueIdx = null, pendingIQCIdx = null, pendingIQCStatus = null;
      let batchMailExcluded = new Set();
      let sessionToken = null, idleTimer = null;
      const PAGE_SIZE = 5;
      let recPage = 1, issuePage = 1, rejPage = 1, iqcPage = 1, holdPage = 1, reportPage = 1;
      let currentReportSummary = {};
      function sanitize(s) { return String(s).replace(/[<>"'&;]/g, '').substring(0, 200) }
      function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      }
      function todayStr() { const d = new Date(); return String(d.getDate()).padStart(2, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + d.getFullYear() }
      function autoDateSlash(el) { let v = el.value.replace(/[^\d]/g, ''); if (v.length > 2) v = v.slice(0, 2) + '-' + v.slice(2); if (v.length > 5) v = v.slice(0, 5) + '-' + v.slice(5); el.value = v.slice(0, 10) }
      function isValidDate(s) {
        if (!s || s.length !== 10) return false;
        const p = s.split('-'); if (p.length !== 3) return false;
        const dd = +p[0], mm = +p[1], yyyy = +p[2];
        if (!Number.isInteger(dd) || !Number.isInteger(mm) || !Number.isInteger(yyyy)) return false;
        if (yyyy < 2000 || yyyy > 2100) return false;
        if (mm < 1 || mm > 12) return false;
        const dt = new Date(yyyy, mm - 1, dd);
        // Agar JS ne date ko "roll over" kar diya (e.g. 31-02 -> March), to ye invalid hai
        return dt.getFullYear() === yyyy && dt.getMonth() === mm - 1 && dt.getDate() === dd;
      }
      function dateToDMY(s) { if (!s) return ''; if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const [y, m, d] = s.split('-'); return `${d}-${m}-${y}` } return s }
      function parseDMY(s) { if (!s || s.length !== 10) return null; const [d, m, y] = s.split('-'); const dt = new Date(+y, +m - 1, +d); return isNaN(dt) ? null : dt }
      function normalizeStatus(s) { if (!s) return 'Pending'; const m = { 'pending': 'Pending', 'testing': 'Testing', 'approved': 'Approved', 'hold': 'Hold', 'rejected': 'Rejected', 'returned': 'Returned' }; return m[String(s).toLowerCase().trim()] || String(s).trim() }
      function normalizeReceiving(r) { return { ...r, recDate: dateToDMY(r.recDate), status: normalizeStatus(r.status), qty: Number(r.qty) || 0, roll: Number(r.roll) || 0, remainQty: Number(r.remainQty) || 0, remainRoll: Number(r.remainRoll) || 0, origQty: Number(r.origQty || r.qty) || 0, origRoll: Number(r.origRoll || r.roll) || 0, returnStock: Number(r.returnStock) || 0, returnRoll: Number(r.returnRoll) || 0, returnedToParty: r.returnedToParty === true || String(r.returnedToParty).toLowerCase() === 'true' } }
      function normalizeIssue(i) { return { ...i, qty: Number(i.qty) || 0, roll: Number(i.roll) || 0 } }
      function isApproved(r) { return String(r.status).toLowerCase().trim() === 'approved' }
      function isRejected(r) { return String(r.status).toLowerCase().trim() === 'rejected' }
      function isTesting(r) { return String(r.status).toLowerCase().trim() === 'testing' }
      function isHold(r) { return String(r.status).toLowerCase().trim() === 'hold' }
      function isIssuableForSpecial(r) { return isApproved(r) || isTesting(r) }

      function recalcRemaining(recArr, issueArr) {
        const issuedQty = {}, issuedRoll = {};
        for (const is of issueArr) {
          const bn = is.batchNo; if (!bn) continue;
          issuedQty[bn] = (issuedQty[bn] || 0) + (Number(is.qty) || 0);
          issuedRoll[bn] = (issuedRoll[bn] || 0) + (Number(is.roll) || 0);
        }
        return recArr.map(r => {
          if (r.returnedToParty === true || String(r.returnedToParty).toLowerCase() === 'true' || r.status === 'Returned') { return { ...r, remainQty: 0, remainRoll: 0, returnStock: r.returnStock || 0, returnRoll: r.returnRoll || 0 } }
          const bn = r.batchNo;
          const usedQ = issuedQty[bn] || 0;
          const usedR = issuedRoll[bn] || 0;
          return { ...r, remainQty: round2(Math.max(0, r.qty - usedQ)), remainRoll: Math.max(0, r.roll - usedR) };
        });
      }


      function loadTableVisibility() {
        try { return JSON.parse(localStorage.getItem('tableVisibility')) || {} }
        catch (e) { return {} }
      }
      function saveTableVisibility(state) {
        localStorage.setItem('tableVisibility', JSON.stringify(state));
      }
      function toggleTable(key) {
        const state = loadTableVisibility();
        state[key] = state[key] === false ? true : false;
        saveTableVisibility(state);
        applyTableVisibility();
      }
      function applyTableVisibility() {
        const state = loadTableVisibility();
        ['rec', 'issue', 'rej', 'hold', 'recForm', 'issueForm'].forEach(key => {
          const visible = state[key] !== false;
          const content = document.getElementById(key + 'Content');
          const btn = document.getElementById(key + 'ToggleBtn');
          if (content) content.style.display = visible ? '' : 'none';
          if (btn) btn.textContent = visible ? '🙈 Hide' : '👁️ Show';
        });
      }

      window.onload = () => {
        const saved = sessionStorage.getItem('sessionToken');
        if (saved) {
          sessionToken = saved;
          document.getElementById('loginOverlay').style.display = 'none';
          resetIdleTimer();
          setTodayDates(); setBatchNo(); applyTableVisibility(); refreshFromSheet(true);
        } else {
          const su = localStorage.getItem('savedUser');
          const sp = localStorage.getItem('savedPass');
          if (su) { document.getElementById('loginUser').value = su; document.getElementById('rememberMe').checked = true }
          if (sp) document.getElementById('loginPass').value = sp;
        }
      };

      async function doLogin() {
        const username = document.getElementById('loginUser').value.trim();
        const password = document.getElementById('loginPass').value;
        const remember = document.getElementById('rememberMe').checked;
        const btn = document.getElementById('loginBtn');

        if (!username || !password) {
          showToast('❌ Username aur password bharo', 'error');
          return;
        }

        btn.disabled = true;
        btn.textContent = '⏳ Logging in...';

        try {
          const resp = await apiCall('login', { username, password });
          if (resp.status === 'ok') {
            sessionToken = resp.sessionToken;
            sessionStorage.setItem('sessionToken', sessionToken);
            sessionStorage.setItem('username', resp.username);

            if (remember) {
              localStorage.setItem('savedUser', username);
              localStorage.setItem('savedPass', password);
            } else {
              localStorage.removeItem('savedUser');
              localStorage.removeItem('savedPass');
            }

            btn.textContent = '✅ Success';
            document.getElementById('loginOverlay').style.display = 'none';
            resetIdleTimer();
            setTodayDates(); setBatchNo(); applyTableVisibility(); refreshFromSheet(true);
          } else {
            showToast('❌ Galat username ya password', 'error');
          }
        } catch (e) {
          showToast('❌ Network error: ' + e.message, 'error');
        } finally {
          btn.disabled = false;
          if (btn.textContent !== '✅ Success') btn.textContent = 'Login';
        }
      }

      function togglePassVisibility() {
        const p = document.getElementById('loginPass');
        p.type = p.type === 'password' ? 'text' : 'password';
      }

      function toggleSettingsPass(id, el) {
        const inp = document.getElementById(id);
        inp.type = inp.type === 'password' ? 'text' : 'password';
        el.textContent = inp.type === 'password' ? '👁️' : '🙈';
      }

      function forceLogout(msg) {
        if (sessionToken) { apiCall('logout', {}).catch(() => { }) }
        sessionToken = null;
        sessionStorage.clear();
        clearTimeout(idleTimer);
        document.getElementById('loginOverlay').style.display = 'flex';
        document.getElementById('loginPass').value = '';
        if (msg) showToast('⚠️ ' + msg, 'warn');
      }

      function resetIdleTimer() {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => forceLogout('Inactivity ki wajah se logout ho gaya'), 30 * 60 * 1000);
      }
      ['click', 'keydown', 'mousemove'].forEach(ev => document.addEventListener(ev, () => { if (sessionToken) resetIdleTimer() }));

      async function apiCall(action, payload = {}) {
        const res = await fetch(CONFIG.WEBAPP_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token: CONFIG.API_TOKEN, sessionToken, action, ...payload }) });
        const data = await res.json();
        if (data.status === 'session_expired') {
          forceLogout('Session expire ho gaya, dobara login karo');
        }
        return data;
      }
      async function refreshFromSheet(initial = false) {
        showLoader();
        try {
          const resp = await apiCall('getData');
          if (resp.status !== 'ok') { updateGsStatus(false, true); showToast('❌ Sheet load failed: ' + resp.status, 'error'); return }
          receiving = (resp.receiving || []).map(normalizeReceiving);
          issues = (resp.issues || []).map(normalizeIssue);
          receiving = recalcRemaining(receiving, issues);
          updateGsStatus(true);
          renderReceivingTable(); renderIssueTable(); renderRejectedTable(); renderIQCTable(); renderHoldTable(); populateSapDropdown(); setBatchNo();
          if (!initial) showToast('✅ Data refreshed — ' + receiving.length + ' receiving, ' + issues.length + ' issues');
        } catch (e) { updateGsStatus(false, true); showToast('❌ Sheet reach nahi ho rahi: ' + e.message, 'error') }
        finally { hideLoader() }
      }
      function showLoader() { document.getElementById('globalLoader').classList.remove('hidden') }
      function hideLoader() { document.getElementById('globalLoader').classList.add('hidden') }

      async function persist(newR, newI, label) {
        showToast('⏳ ' + label);
        try {
          const resp = await apiCall('saveData', { receiving: newR, issues: newI });
          if (resp.status === 'ok') { updateGsStatus(true); return true }
          updateGsStatus(false, true); showToast('❌ Save failed: ' + (resp.msg || resp.status), 'error'); return false;
        } catch (e) { updateGsStatus(false, true); showToast('❌ Network error: ' + e.message, 'error'); return false }
      }
      function updateGsStatus(ok, err = false) {
        const dot = document.getElementById('gsDot'), tx = document.getElementById('gsStatusText');
        dot.className = 'gs-dot' + (ok ? ' connected' : err ? ' error' : '');
        tx.textContent = ok ? 'Sheets: Connected ✓' : err ? 'Sheets: Error' : 'Sheets: Not Connected';
      }

      function openSidebar() {
        document.getElementById('sidebarMenu').classList.add('open');
        document.getElementById('sidebarOverlay').classList.add('show');
      }
      function closeSidebar() {
        document.getElementById('sidebarMenu').classList.remove('open');
        document.getElementById('sidebarOverlay').classList.remove('show');
      }
      function toggleSidebar() {
        const menu = document.getElementById('sidebarMenu');
        menu.classList.contains('open') ? closeSidebar() : openSidebar();
      }

      function switchTab(name) {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        const idx = { issue: 0, receiving: 1, iqc: 2, hold: 3, rejected: 4, report: 5, settings: 6 }[name];
        document.querySelectorAll('.tab')[idx].classList.add('active');
        document.getElementById('tab-' + name).classList.add('active');
        if (name === 'issue') populateSapDropdown();
        if (name === 'iqc') renderIQCTable();
        if (name === 'rejected') renderRejectedTable();
        if (name === 'hold') renderHoldTable();
        closeSidebar();
      }

      function setTodayDates() { const d = todayStr(); document.getElementById('recDate').value = d; document.getElementById('issueDate').value = d }
      function getNextBatchNo() {
        if (!receiving.length) return 'B-0001';
        const nums = receiving.map(r => parseInt(String(r.batchNo).replace(/\D/g, '')) || 0);
        return 'B-' + String(Math.max(...nums) + 1).padStart(4, '0');
      }
      function setBatchNo() { document.getElementById('batchNo').value = getNextBatchNo() }
      function onSapCodeInput(el) {
        const val = el.value = sanitize(el.value);
        const hint = document.getElementById('descHint');
        if (!val) { hint.classList.remove('show'); return }
        const match = receiving.find(r => r.sapCode === val && r.description);
        if (match) {
          const descEl = document.getElementById('description');
          if (!descEl.value) { descEl.value = match.description; hint.classList.add('show') }
          else hint.classList.remove('show');
        } else hint.classList.remove('show');
      }
      function clearForm() {
        ['docNumber', 'sapCode', 'description', 'qty', 'roll', 'location', 'remark'].forEach(id => document.getElementById(id).value = '');
        document.getElementById('status').value = 'Pending';
        document.getElementById('sapHint').classList.remove('show');
        document.getElementById('descHint').classList.remove('show');
        setBatchNo(); setTodayDates();
      }

      function fillSapFromTable(sapCode, description) {
        document.getElementById('sapCode').value = sapCode;
        document.getElementById('description').value = description;
        document.getElementById('sapHint').classList.add('show');
        document.getElementById('descHint').classList.add('show');
        window.scrollTo({ top, behavior: 'smooth' });
        showToast('✅ SAP Code & Description fill ho gaya');
      }

      async function addEntry() {
        if (isSaving) { showToast('⏳ Save chal raha hai, wait karo', 'warn'); return }
        const recDate = document.getElementById('recDate').value.trim();
        const docNumber = sanitize(document.getElementById('docNumber').value.trim());
        const sapCode = sanitize(document.getElementById('sapCode').value.trim());
        const description = sanitize(document.getElementById('description').value.trim());
        const qty = Math.max(0, Math.min(round2(document.getElementById('qty').value), 99999));
        const roll = Math.max(0, Math.min(parseInt(document.getElementById('roll').value) || 0, 99999));
        if (qty <= 0 && roll <= 0) { showToast('❌ Qty ya Roll me se kam se kam ek 0 se zyada hona chahiye', 'error'); return }
        const status = document.getElementById('status').value;
        const location = sanitize(document.getElementById('location').value.trim());
        const remark = sanitize(document.getElementById('remark').value.trim());
        if (!isValidDate(recDate)) { showToast('❌ Date sahi format mein daalo: dd-mm-yyyy', 'error'); return }
        if (!sapCode || !description) { showToast('❌ SAP Code aur Description zaroori hain', 'error'); return }

        const btn = document.getElementById('addEntryBtn');
        isSaving = true; btn.disabled = true; btn.textContent = '⏳ Saving...';
        showToast('⏳ Entry sheet mein save ho rahi hai...');
        try {
          // NOTE: batchNo yahan nahi bheja — backend LockService ke saath khud generate karega
          const resp = await apiCall('addEntry', { recDate, docNumber, sapCode, description, qty, roll, status, location, remark });
          if (resp.status === 'ok') {
            receiving = [normalizeReceiving(resp.entry), ...receiving];
            renderReceivingTable(); renderIssueTable(); renderRejectedTable(); renderIQCTable(); renderHoldTable(); populateSapDropdown();
            clearForm();
            showToast('✅ Entry add hui — Batch ' + resp.batchNo);
            updateGsStatus(true);
          } else {
            updateGsStatus(false, true);
            showToast('❌ ' + (resp.msg || 'Save failed'), 'error');
          }
        } catch (e) {
          updateGsStatus(false, true);
          showToast('❌ Network error: ' + e.message, 'error');
        } finally {
          isSaving = false; btn.disabled = false; btn.textContent = '➕ Add Entry';
        }
      }

      function getFilteredReceiving() {
        const q = (document.getElementById('recSearch').value || '').toLowerCase();
        const df = document.getElementById('recDateFrom').value;
        const dt = document.getElementById('recDateTo').value;
        const st = document.getElementById('recStatusFilter').value;
        const dtFrom = df && isValidDate(df) ? parseDMY(df) : null;
        const dtTo = dt && isValidDate(dt) ? parseDMY(dt) : null;
        return receiving.filter(r => {
          if (q && !([r.batchNo, r.sapCode, r.description, r.docNumber, r.location, r.remark || '', String(r.qty)].join(' ').toLowerCase().includes(q))) return false;
          if (st && r.status !== st) return false;
          const rd = parseDMY(dateToDMY(r.recDate));
          if (dtFrom && rd && rd < dtFrom) return false;
          if (dtTo && rd && rd > dtTo) return false;
          return true;
        });
      }

      function renderReceivingTable() {
        const body = document.getElementById('receivingBody'); body.innerHTML = '';
        const filtered = getFilteredReceiving();
        const total = filtered.length;
        const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (recPage > maxPage) recPage = maxPage;
        if (!receiving.length) { document.getElementById('alertReceiving').classList.add('show'); document.getElementById('receivingTableWrap').style.display = 'none'; document.getElementById('recPagination').innerHTML = ''; return }
        document.getElementById('alertReceiving').classList.remove('show'); document.getElementById('receivingTableWrap').style.display = '';
        if (total === 0) { body.innerHTML = '<tr><td colspan="12" class="empty-state">No matching records found.</td></tr>'; renderPagination('rec', 0, 0); return }
        const start = (recPage - 1) * PAGE_SIZE, end = Math.min(start + PAGE_SIZE, total);
        filtered.slice(start, end).forEach((r, i) => {
          const globalIdx = receiving.indexOf(r);
          const tr = document.createElement('tr');
          const sapCell = `<span class="mono" style="color:var(--yellow);cursor:pointer;text-decoration:underline dotted" onclick="fillSapFromTable('${escapeHtml(r.sapCode)}','${escapeHtml(r.description).replace(/'/g, "\\'")}') " title="Click to fill form">${escapeHtml(r.sapCode)}</span>`;
          tr.innerHTML = `<td class="mono">${total - start - i}</td>
      <td class="mono">${dateToDMY(r.recDate) || '—'}</td>
      <td>${escapeHtml(r.docNumber) || '—'}</td>
      <td class="mono" style="color:var(--accent2)">
  <span class="batch-tip" onclick="toggleTip(this,event)">${escapeHtml(r.batchNo)}
    <span class="tip-box">${escapeHtml(r.remark) || 'No remark'}</span>
  </span>
</td>
      <td>${sapCell}</td>
      <td style="max-width:160px">${escapeHtml(r.description)}</td>
      <td class="mono">${fmtKg(r.qty)}<small style="color:#5b21b6"> (rem:${fmtKg(r.remainQty)})</small></td>
<td class="mono">${fmtNum(r.roll)}<small style="color:#5b21b6"> (rem:${fmtNum(r.remainRoll)})</small></td>
      <td>${badgeHtml(r.status)}</td>
      <td>${escapeHtml(r.location) || '—'}</td>
      <td style="color:var(--text3);font-size:11px;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(r.remark) || ''}">${escapeHtml(r.remark) || '—'}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-secondary btn-sm" onclick="openEdit(${globalIdx})">✏️ Edit</button>
          <button class="btn btn-sm" style="background:#f0fdf4;border:1px solid #86efac;color:#166534" onclick="openSticker(${globalIdx})">🏷️ Sticker</button>
        </div>
      </td>`;
          body.appendChild(tr);
        });
        renderPagination('rec', total, maxPage);
      }

      function renderPagination(key, total, maxPage) {
        const container = document.getElementById(key + 'Pagination');
        if (total === 0 || maxPage <= 1) { container.innerHTML = ''; return }
        const page = key === 'rec' ? recPage : key === 'issue' ? issuePage : key === 'iqc' ? iqcPage : key === 'hold' ? holdPage : key === 'report' ? reportPage : rejPage;
        const start = (page - 1) * PAGE_SIZE + 1, end = Math.min(page * PAGE_SIZE, total);
        let html = `<span class="pg-info">${start}-${end} / ${total}</span>`;
        html += `<button class="pg-btn" onclick="changePage('${key}',${page - 1})" ${page <= 1 ? 'disabled' : ''}>Pre</button>`;
        // Sirf 3 page numbers dikhao, current page ke aas-paas
        let s = Math.max(1, page - 1);
        let e = Math.min(maxPage, s + 2);
        s = Math.max(1, e - 2);
        for (let p = s; p <= e; p++) {
          html += `<button class="pg-btn${p === page ? ' active' : ''}" onclick="changePage('${key}',${p})">${p}</button>`;
        }
        html += `<button class="pg-btn" onclick="changePage('${key}',${page + 1})" ${page >= maxPage ? 'disabled' : ''}>Next</button>`;
        container.innerHTML = html;
      }
      function changePage(key, page) {
        if (key === 'rec') { recPage = page; renderReceivingTable() }
        else if (key === 'issue') { issuePage = page; renderIssueTable() }
        else if (key === 'iqc') { iqcPage = page; renderIQCTable() }
        else if (key === 'hold') { holdPage = page; renderHoldTable() }
        else if (key === 'report') { reportPage = page; renderReportTable(currentReportHeaders, currentReportData, currentReportSummary) }
        else { rejPage = page; renderRejectedTable() }
      }

      function clearRecSearch() { ['recSearch', 'recDateFrom', 'recDateTo'].forEach(id => document.getElementById(id).value = ''); document.getElementById('recStatusFilter').value = ''; recPage = 1; renderReceivingTable() }
      function clearIssueSearch() { ['issueSearch', 'issueDateFrom', 'issueDateTo'].forEach(id => document.getElementById(id).value = ''); document.getElementById('issueTypeFilter').value = ''; issuePage = 1; renderIssueTable() }
      function clearRejSearch() { ['rejSearch', 'rejDateFrom', 'rejDateTo'].forEach(id => document.getElementById(id).value = ''); document.getElementById('rejReturnedFilter').value = ''; rejPage = 1; renderRejectedTable() }

      function clearIQCSearch() { ['iqcSearch', 'iqcDateFrom', 'iqcDateTo'].forEach(id => document.getElementById(id).value = ''); iqcPage = 1; renderIQCTable() }
      function clearHoldSearch() { ['holdSearch', 'holdDateFrom', 'holdDateTo'].forEach(id => document.getElementById(id).value = ''); holdPage = 1; renderHoldTable() }

      function getFilteredIQC() {
        const q = (document.getElementById('iqcSearch').value || '').toLowerCase();
        const df = document.getElementById('iqcDateFrom').value;
        const dt = document.getElementById('iqcDateTo').value;
        const dtFrom = df && isValidDate(df) ? parseDMY(df) : null;
        const dtTo = dt && isValidDate(dt) ? parseDMY(dt) : null;
        return receiving.filter(r => {
          if (!isTesting(r)) return false;
          if (q && !([r.batchNo, r.sapCode, r.description, r.docNumber, r.location, r.remark || '', String(r.qty)].join(' ').toLowerCase().includes(q))) return false;
          const rd = parseDMY(dateToDMY(r.recDate));
          if (dtFrom && rd && rd < dtFrom) return false;
          if (dtTo && rd && rd > dtTo) return false;
          return true;
        });
      }

      function renderIQCTable() {
        const body = document.getElementById('iqcBody'); body.innerHTML = '';
        const filtered = getFilteredIQC();
        const total = filtered.length;
        const allIQC = receiving.filter(r => isTesting(r)).length;
        const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (iqcPage > maxPage) iqcPage = maxPage;
        document.getElementById('iqcCount').textContent = allIQC ? `(${total} shown / ${allIQC} total under testing)` : '';
        if (!allIQC) { document.getElementById('alertIQC').classList.add('show'); document.getElementById('iqcTableWrap').style.display = 'none'; document.getElementById('iqcPagination').innerHTML = ''; return }
        document.getElementById('alertIQC').classList.remove('show'); document.getElementById('iqcTableWrap').style.display = '';
        if (total === 0) { body.innerHTML = '<tr><td colspan="10" class="empty-state">No matching testing records found.</td></tr>'; renderPagination('iqc', 0, 0); return }
        const start = (iqcPage - 1) * PAGE_SIZE, end = Math.min(start + PAGE_SIZE, total);
        filtered.slice(start, end).forEach((r, i) => {
          const globalIdx = receiving.indexOf(r);
          const tr = document.createElement('tr');
          tr.innerHTML = `<td class="mono">${total - start - i}</td>
      <td class="mono">${dateToDMY(r.recDate) || '—'}</td>
      <td>${escapeHtml(r.docNumber) || '—'}</td>
      <td class="mono" style="color:var(--accent2)">
  <span class="batch-tip" onclick="toggleTip(this,event)">${escapeHtml(r.batchNo)}
    <span class="tip-box">${escapeHtml(r.remark) || 'No remark'}</span>
  </span>
</td>
      <td class="mono" style="color:var(--yellow)">${escapeHtml(r.sapCode)}</td>
      <td style="max-width:160px">${escapeHtml(r.description)}</td>
      <td class="mono">${fmtKg(r.qty)}</td>
      <td class="mono">${fmtNum(r.roll)}</td>
      <td>${escapeHtml(r.location) || '—'}</td>
      <td>
  <div class="action-btns">
    <button class="btn btn-sm" style="background:#f0fdf4;border:1px solid #86efac;color:#166534" onclick="openIQCStatusModal(${globalIdx},'Approved')">✅ Approve</button>
    <button class="btn btn-sm" style="background:#fef2f2;border:1px solid #fca5a5;color:#991b1b" onclick="openIQCStatusModal(${globalIdx},'Rejected')">❌ Reject</button>
    <button class="btn btn-sm" style="background:#f0fdf4;border:1px solid #86efac;color:#166534" onclick="openIQCSticker(${globalIdx})">🏷️ Sticker</button>
  </div>
</td>`;
          body.appendChild(tr);
        });
        renderPagination('iqc', total, maxPage);
      }

      function openIQCStatusModal(idx, newStatus) {
        pendingIQCIdx = idx; pendingIQCStatus = newStatus;
        const r = receiving[idx];
        const isApprove = newStatus === 'Approved';
        document.getElementById('iqcStatusFormContent').innerHTML = `
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:16px;font-size:12px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><span style="color:var(--text3)">Batch:</span> <strong class="mono">${escapeHtml(r.batchNo)}</strong></div>
        <div><span style="color:var(--text3)">SAP:</span> <strong style="color:var(--yellow)">${escapeHtml(r.sapCode)}</strong></div>
        <div style="grid-column:span 2"><span style="color:var(--text3)">Description:</span> <strong>${escapeHtml(r.description)}</strong></div>
        <div><span style="color:var(--text3)">Qty:</span> <strong class="mono">${fmtKg(r.qty)} Kg</strong></div>
        <div><span style="color:var(--text3)">Roll:</span> <strong class="mono">${fmtNum(r.roll)} Nos</strong></div>
        <div><span style="color:var(--text3)">Location:</span> <strong>${escapeHtml(r.location) || '—'}</strong></div>
        <div><span style="color:var(--text3)">Remark:</span> <strong>${escapeHtml(r.remark) || '—'}</strong></div>
      </div>
    </div>
    <div style="background:${isApprove ? '#f0fdf4' : '#fef2f2'};border:1px solid ${isApprove ? '#86efac' : '#fca5a5'};border-radius:7px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:${isApprove ? '#166534' : '#991b1b'}">
      ${isApprove ? '✅' : '❌'} Is batch ka status <strong>${escapeHtml(newStatus)}</strong> kar diya jayega. Confirm karo.
    </div>`;
        const btn = document.getElementById('confirmIQCStatusBtn');
        btn.className = 'btn ' + (isApprove ? 'btn-primary' : 'btn-danger');
        btn.textContent = isApprove ? '✅ Yes, Approve' : '❌ Yes, Reject';
        document.getElementById('iqcStatusModal').classList.add('show');
      }

      async function confirmIQCStatusChange() {
        if (pendingIQCIdx === null) return;
        if (isSaving) { showToast('⏳ Wait karo', 'warn'); return }
        const r = receiving[pendingIQCIdx];
        const newStatus = pendingIQCStatus;
        const newR = [...receiving];
        newR[pendingIQCIdx] = { ...newR[pendingIQCIdx], status: newStatus, editedAt: new Date().toISOString() };
        const recalced = recalcRemaining(newR, issues);
        const btn = document.getElementById('confirmIQCStatusBtn');
        isSaving = true; btn.disabled = true; btn.textContent = '⏳ Saving...';
        const ok = await persist(recalced, issues, `Batch ${r.batchNo} ko ${newStatus} kiya ja raha hai...`);
        isSaving = false; btn.disabled = false;
        if (ok) {
          receiving = recalced;
          renderReceivingTable(); renderIssueTable(); renderRejectedTable(); renderIQCTable(); renderHoldTable(); populateSapDropdown();
          closeModal('iqcStatusModal');
          showToast(`✅ Batch ${r.batchNo} ab ${newStatus} hai`);
        } else {
          btn.textContent = newStatus === 'Approved' ? '✅ Yes, Approve' : '❌ Yes, Reject';
        }
      }

      function getFilteredHold() {
        const q = (document.getElementById('holdSearch').value || '').toLowerCase();
        const df = document.getElementById('holdDateFrom').value;
        const dt = document.getElementById('holdDateTo').value;
        const dtFrom = df && isValidDate(df) ? parseDMY(df) : null;
        const dtTo = dt && isValidDate(dt) ? parseDMY(dt) : null;
        return receiving.filter(r => {
          if (!isHold(r)) return false;
          if (q && !([r.batchNo, r.sapCode, r.description, r.docNumber, r.location, r.remark || '', String(r.qty)].join(' ').toLowerCase().includes(q))) return false;
          const rd = parseDMY(dateToDMY(r.recDate));
          if (dtFrom && rd && rd < dtFrom) return false;
          if (dtTo && rd && rd > dtTo) return false;
          return true;
        });
      }

      function renderHoldTable() {
        const body = document.getElementById('holdBody'); body.innerHTML = '';
        const filtered = getFilteredHold();
        const total = filtered.length;
        const allHold = receiving.filter(r => isHold(r)).length;
        const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (holdPage > maxPage) holdPage = maxPage;
        document.getElementById('holdCount').textContent = allHold ? `(${total} shown / ${allHold} total on hold)` : '';
        if (!allHold) { document.getElementById('alertHold').classList.add('show'); document.getElementById('holdTableWrap').style.display = 'none'; document.getElementById('holdPagination').innerHTML = ''; return }
        document.getElementById('alertHold').classList.remove('show'); document.getElementById('holdTableWrap').style.display = '';
        if (total === 0) { body.innerHTML = '<tr><td colspan="10" class="empty-state">No matching hold records found.</td></tr>'; renderPagination('hold', 0, 0); return }
        const start = (holdPage - 1) * PAGE_SIZE, end = Math.min(start + PAGE_SIZE, total);
        filtered.slice(start, end).forEach((r, i) => {
          const globalIdx = receiving.indexOf(r);
          const tr = document.createElement('tr');
          tr.innerHTML = `<td class="mono">${total - start - i}</td>
  <td class="mono">${dateToDMY(r.recDate) || '—'}</td>
  <td>${escapeHtml(r.docNumber) || '—'}</td>
  <td class="mono" style="color:var(--accent2)">
<span class="batch-tip" onclick="toggleTip(this,event)">${escapeHtml(r.batchNo)}
<span class="tip-box">${escapeHtml(r.remark) || 'No remark'}</span>
</span>
</td>
  <td class="mono" style="color:var(--yellow)">${escapeHtml(r.sapCode)}</td>
  <td style="max-width:160px">${escapeHtml(r.description)}</td>
 <td class="mono">${fmtKg(r.qty)}<small style="color:#5b21b6"> (rem:${fmtKg(r.remainQty)})</small></td>
  <td class="mono">${fmtNum(r.roll)}<small style="color:#5b21b6"> (rem:${fmtNum(r.remainRoll)})</small></td>
  <td>${escapeHtml(r.location) || '—'}</td>
  <td>
    <div class="action-btns">
      <button class="btn btn-sm" style="background:#f0fdf4;border:1px solid #86efac;color:#166534" onclick="openIQCStatusModal(${globalIdx},'Approved')">✅ Approve</button>
      <button class="btn btn-sm" style="background:#fef2f2;border:1px solid #fca5a5;color:#991b1b" onclick="openIQCStatusModal(${globalIdx},'Rejected')">❌ Reject</button>
      <button class="btn btn-sm" style="background:#f0fdf4;border:1px solid #86efac;color:#166534" onclick="openHoldSticker(${globalIdx})">🏷️ Sticker</button>
    </div>
  </td>`;
          body.appendChild(tr);
        });
        renderPagination('hold', total, maxPage);
      }

      function openHoldSticker(idx) {
        generateHoldSticker(receiving[idx]);
      }

      function openIQCSticker(idx) {
        generateIQCSticker(receiving[idx]);
      }

      function badgeHtml(s) {
        const c = { Pending: 'badge-pending', Testing: 'badge-testing', Approved: 'badge-approved', Rejected: 'badge-rejected', Returned: 'badge-returned', Hold: 'badge-hold' };
        const ic = { Pending: '⏳', Testing: '🔬', Approved: '✅', Hold: '⏸️', Rejected: '❌', Returned: '📦' };
        return `<span class="badge ${c[s] || 'badge-pending'}">${ic[s] || ''} ${s || 'Pending'}</span>`;
      }

      function openEdit(idx) {
        editIndex = idx; const r = receiving[idx];
        const dv = dateToDMY(r.recDate) || todayStr();
        document.getElementById('editFormContent').innerHTML = `
  <div class="form-grid">
    <div class="form-group"><label>Batch No</label><input readonly value="${escapeHtml(r.batchNo)}" class="mono"></div>
    <div class="form-group"><label>Date (dd-mm-yyyy)</label><input type="text" id="e_recDate" value="${escapeHtml(dv)}" maxlength="10" oninput="autoDateSlash(this)"></div>
    <div class="form-group"><label>Doc No</label><input id="e_docNumber" value="${escapeHtml(r.docNumber) || ''}"></div>
    <div class="form-group"><label>SAP Code</label><input id="e_sapCode" value="${escapeHtml(r.sapCode)}"></div>
    <div class="form-group wide"><label>Description</label><input id="e_description" value="${escapeHtml(r.description)}"></div>
    <div class="form-group"><label>Qty</label><input type="number" id="e_qty" value="${r.qty}" min="0" step="0.01" oninput="if(this.value<0)this.value=0"></div>
    <div class="form-group"><label>Roll</label><input type="number" id="e_roll" value="${r.roll}" min="0" oninput="if(this.value<0)this.value=0"></div>
    <div class="form-group"><label>Status</label><select id="e_status">${['Pending', 'Testing', 'Approved', 'Hold', 'Rejected', 'Returned'].map(s => `<option ${s === r.status ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}</select></div>
    <div class="form-group"><label>Location</label><input id="e_location" value="${escapeHtml(r.location) || ''}"></div>
    <div class="form-group wide"><label>Remark</label><input id="e_remark" value="${escapeHtml(r.remark) || ''}" oninput="this.value=sanitize(this.value).toUpperCase()"></div>
  </div>`;
        document.getElementById('editModal').classList.add('show');
        flatpickr('#e_recDate', fpConfig);
      }
      function closeModal(id) {
        document.getElementById(id).classList.remove('show');
        if (id !== 'statusWarnModal') { editIndex = null; }
        editIssueIndex = null; pendingPartyIdx = null; pendingCancelIssueIdx = null;
        pendingIQCIdx = null; pendingIQCStatus = null;
      }
      async function saveEdit() {
        if (isSaving) { showToast('⏳ Wait karo', 'warn'); return }
        const orig = receiving[editIndex];
        const dv = document.getElementById('e_recDate').value.trim();
        if (!isValidDate(dv)) { showToast('❌ Date format galat hai: dd-mm-yyyy', 'error'); return }

        // ── NEW: Issued qty/roll se kam edit na ho paye ──
        const newQty = Math.max(0, Math.min(round2(document.getElementById('e_qty').value), 99999));
        const newRoll = Math.max(0, Math.min(parseInt(document.getElementById('e_roll').value) || 0, 99999));
        const issuedQty = issues.filter(is => is.batchNo === orig.batchNo).reduce((s, x) => s + (Number(x.qty) || 0), 0);
        const issuedRoll = issues.filter(is => is.batchNo === orig.batchNo).reduce((s, x) => s + (Number(x.roll) || 0), 0);
        if (newQty < issuedQty) {
          showToast(`❌ Batch ${orig.batchNo} se pehle hi ${issuedQty} Kg issue ho chuka hai — Qty isse kam nahi ho sakti`, 'error');
          return;
        }
        if (newRoll < issuedRoll) {
          showToast(`❌ Batch ${orig.batchNo} se pehle hi ${issuedRoll} Roll issue ho chuke hain — Roll isse kam nahi ho sakta`, 'error');
          return;
        }

        const newStatus = document.getElementById('e_status').value;
        if (orig.status === 'Returned' && newStatus !== 'Returned') {
          document.getElementById('statusWarnContent').innerHTML = `
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:16px;font-size:12px">
      <div><span style="color:var(--text3)">Batch:</span> <strong class="mono">${escapeHtml(orig.batchNo)}</strong></div>
      <div style="margin-top:6px"><span style="color:var(--text3)">Current Status:</span> <strong>Returned</strong> → <span style="color:var(--text3)">New Status:</span> <strong style="color:var(--red)">${escapeHtml(newStatus)}</strong></div>
    </div>
    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:7px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#991b1b">
      ⚠️ Ye batch pehle hi Party ko <strong>RETURN</strong> ho chuki hai. Status "<strong>${escapeHtml(newStatus)}</strong>" karne se ye batch dobara stock me active ho jayegi aur FIFO/Special Issue ke liye eligible ho jayegi.
    </div>`;
          document.getElementById('statusWarnModal').classList.add('show');
          return;
        }
        await proceedSaveEdit();
      }

      async function proceedSaveEdit() {
        document.getElementById('statusWarnModal').classList.remove('show');
        const orig = receiving[editIndex];
        const dv = document.getElementById('e_recDate').value.trim();
        const r = { ...orig };
        r.recDate = dv;
        r.docNumber = sanitize(document.getElementById('e_docNumber').value.trim());
        r.sapCode = sanitize(document.getElementById('e_sapCode').value.trim());
        r.description = sanitize(document.getElementById('e_description').value.trim());
        r.qty = Math.max(0, Math.min(round2(document.getElementById('e_qty').value), 99999));
        r.roll = Math.max(0, Math.min(parseInt(document.getElementById('e_roll').value) || 0, 99999));
        r.status = document.getElementById('e_status').value;
        if (orig.status === 'Returned' && r.status !== 'Returned') {
          r.returnedToParty = false;
        }
        r.location = sanitize(document.getElementById('e_location').value.trim());
        r.remark = sanitize(document.getElementById('e_remark').value.trim());
        r.editedAt = new Date().toISOString();
        if (!r.origQty) r.origQty = r.qty;
        if (!r.origRoll) r.origRoll = r.roll;
        const newR = [...receiving];
        newR[editIndex] = r;
        const recalced = recalcRemaining(newR, issues);
        const btn = document.getElementById('saveEditBtn');
        isSaving = true; btn.disabled = true; btn.textContent = '⏳ Saving...';
        const ok = await persist(recalced, issues, 'Changes save ho rahi hain...');
        isSaving = false; btn.disabled = false; btn.textContent = '💾 Save';
        if (ok) { receiving = recalced; renderReceivingTable(); renderIssueTable(); renderRejectedTable(); renderIQCTable(); renderHoldTable(); populateSapDropdown(); closeModal('editModal'); showToast('✅ Entry update ho gayi') }
      }

      function openIssueEdit(idx) {
        editIssueIndex = idx; const is = issues[idx];
        document.getElementById('editIssueFormContent').innerHTML = `
  <div class="form-grid">
    <div class="form-group"><label>Issue Date (dd-mm-yyyy)</label><input type="text" id="ei_issueDate" value="${escapeHtml(dateToDMY(is.issueDate)) || ''}" maxlength="10" oninput="autoDateSlash(this)"></div>
    <div class="form-group"><label>Batch No</label><input readonly value="${escapeHtml(is.batchNo) || ''}" class="mono"></div>
    <div class="form-group"><label>SAP Code</label><input readonly value="${escapeHtml(is.sap) || ''}" class="mono"></div>
    <div class="form-group wide"><label>Description</label><input id="ei_description" value="${escapeHtml(is.description) || ''}" readonly class="mono"></div>
    <div class="form-group"><label>Issued To</label>
      <select id="ei_issueTo">${['Packing-C34A', 'Packing-C34', 'Packing-C3', 'Quality-C34A', 'Quality-C34', 'Quality-C3'].map(d => `<option ${d === is.issueTo ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')}</select>
    </div>
    <div class="form-group"><label>Qty</label><input type="number" id="ei_qty" value="${is.qty}" min="0" step="0.01" oninput="if(this.value<0)this.value=0"></div>
    <div class="form-group"><label>Roll</label><input type="number" id="ei_roll" value="${is.roll}" min="0" oninput="if(this.value<0)this.value=0"></div>
    <div class="form-group"><label>Type</label>
      <select id="ei_type" disabled><option ${is.type === 'FIFO' ? 'selected' : ''}>FIFO</option><option ${is.type === 'Special Approval' ? 'selected' : ''}>Special Approval</option></select>
    </div>
    <div class="form-group"><label>Location</label><input id="ei_location" value="${escapeHtml(is.location) || ''}"></div>
    <div class="form-group wide"><label>Remarks</label><input id="ei_remarks" value="${escapeHtml(is.remarks) || ''}" oninput="this.value=sanitize(this.value).toUpperCase()"></div>
  </div>`;
        document.getElementById('editIssueModal').classList.add('show');
        flatpickr('#ei_issueDate', fpConfig);
      }

      async function saveIssueEdit() {
        if (isSaving) { showToast('⏳ Wait karo', 'warn'); return }
        const orig = issues[editIssueIndex];
        const dv = document.getElementById('ei_issueDate').value.trim();
        if (!isValidDate(dv)) { showToast('❌ Date format galat hai: dd-mm-yyyy', 'error'); return }
        const newQty = Math.max(0, Math.min(round2(document.getElementById('ei_qty').value), 99999));
        const newRoll = Math.max(0, Math.min(parseInt(document.getElementById('ei_roll').value) || 0, 99999));
        const batchRec = receiving.find(r => r.batchNo === orig.batchNo);
        if (batchRec) {
          const otherIQ = issues.filter((_, i) => i !== editIssueIndex && issues[i].batchNo === orig.batchNo).reduce((s, x) => s + (Number(x.qty) || 0), 0);
          const otherIR = issues.filter((_, i) => i !== editIssueIndex && issues[i].batchNo === orig.batchNo).reduce((s, x) => s + (Number(x.roll) || 0), 0);
          if (newQty + otherIQ > batchRec.qty) { showToast(`❌ Qty zyada hai! Batch total: ${batchRec.qty}, already issued: ${otherIQ}`, 'error'); return }
          if (newRoll + otherIR > batchRec.roll) { showToast(`❌ Roll zyada hai! Batch total: ${batchRec.roll}, already issued: ${otherIR}`, 'error'); return }
        }
        const updated = { ...orig };
        updated.issueDate = dv;
        updated.description = sanitize(document.getElementById('ei_description').value.trim());
        updated.issueTo = document.getElementById('ei_issueTo').value;
        updated.qty = newQty; updated.roll = newRoll;
        updated.type = document.getElementById('ei_type').value;
        updated.location = sanitize(document.getElementById('ei_location').value.trim());
        updated.remarks = sanitize(document.getElementById('ei_remarks').value.trim());
        updated.editedAt = new Date().toISOString();
        const newI = [...issues];
        newI[editIssueIndex] = updated;
        const recalced = recalcRemaining(receiving, newI);
        const btn = document.getElementById('saveIssueEditBtn');
        isSaving = true; btn.disabled = true; btn.textContent = '⏳ Saving...';
        const ok = await persist(recalced, newI, 'Issue changes save ho rahi hain...');
        isSaving = false; btn.disabled = false; btn.textContent = '💾 Save';
        if (ok) {
          issues = newI; receiving = recalced;
          renderReceivingTable(); renderIssueTable(); renderRejectedTable(); renderIQCTable(); renderHoldTable();
          const sap = document.getElementById('issueSapCode').value;
          if (sap) refreshStockInfo(sap);
          closeModal('editIssueModal');
          showToast('✅ Issue update hui');
        }
      }

      async function saveAccountSettings() {
        if (isSaving) { showToast('⏳ Wait karo', 'warn'); return }
        const newUsername = document.getElementById('newUsername').value.trim();
        const currentPassword = document.getElementById('currentPassword').value;
        const newPassword = document.getElementById('newPassword').value;
        const confirmNewPassword = document.getElementById('confirmNewPassword').value;


        function showSettingsAlert(msg, type) {
          showToast(msg, type === 'error' ? 'error' : 'success');
        }

        if (!currentPassword) { showSettingsAlert('❌ Current password daalo', 'error'); return; }
        if (!newUsername && !newPassword) { showSettingsAlert('❌ Naya username ya password mein se kam se kam ek daalo', 'error'); return; }
        if (newPassword && newPassword !== confirmNewPassword) { showSettingsAlert('❌ New Password aur Confirm Password match nahi kar rahe', 'error'); return; }
        if (newPassword && newPassword.length < 4) { showSettingsAlert('❌ Naya password kam se kam 4 characters ka hona chahiye', 'error'); return; }

        const btn = document.getElementById('saveSettingsBtn');
        isSaving = true; btn.disabled = true; btn.textContent = '⏳ Updating...';

        try {
          const resp = await apiCall('updateCredentials', { currentPassword, newUsername, newPassword });
          if (resp.status === 'ok') {
            showSettingsAlert('✅ Credentials update ho gaye', 'info');
            showToast('✅ Account settings update ho gayi');
            if (newUsername) sessionStorage.setItem('username', resp.username);
            clearSettingsForm(false);
          } else {
            showSettingsAlert('❌ ' + (resp.msg || 'Update fail hua'), 'error');
          }
        } catch (e) {
          showSettingsAlert('❌ Network error: ' + e.message, 'error');
        } finally {
          isSaving = false; btn.disabled = false; btn.textContent = '💾 Update Credentials';
        }
      }

      function clearSettingsForm(clearAlert = true) {
        ['newUsername', 'currentPassword', 'newPassword', 'confirmNewPassword'].forEach(id => document.getElementById(id).value = '');
        if (clearAlert) document.getElementById('settingsAlert')?.classList.remove('show');
      }

      function openCancelIssue(idx) {
        pendingCancelIssueIdx = idx;
        const is = issues[idx];
        document.getElementById('cancelIssueFormContent').innerHTML = `
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:16px;font-size:12px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><span style="color:var(--text3)">Issue Date:</span> <strong class="mono">${escapeHtml(dateToDMY(is.issueDate)) || '—'}</strong></div>
        <div><span style="color:var(--text3)">Batch:</span> <strong class="mono">${escapeHtml(is.batchNo)}</strong></div>
        <div><span style="color:var(--text3)">SAP:</span> <strong style="color:var(--yellow)">${escapeHtml(is.sap)}</strong></div>
        <div><span style="color:var(--text3)">Issued To:</span> <strong>${escapeHtml(is.issueTo) || '—'}</strong></div>
        <div><span style="color:var(--text3)">Qty:</span> <strong class="mono">${is.qty} Kg</strong></div>
        <div><span style="color:var(--text3)">Roll:</span> <strong class="mono">${is.roll} Nos</strong></div>
      </div>
    </div>
    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:7px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#991b1b">
      ⚠️ Ye issue cancel karne par is entry ki Qty/Roll wapas Batch <strong>${escapeHtml(is.batchNo)}</strong> ke remaining stock me add ho jayegi. Ye action undo nahi ho sakta.
    </div>`;
        document.getElementById('cancelIssueModal').classList.add('show');
      }

      async function confirmCancelIssue() {
        if (pendingCancelIssueIdx === null) return;
        if (isSaving) { showToast('⏳ Wait karo', 'warn'); return }
        const newI = issues.filter((_, i) => i !== pendingCancelIssueIdx);
        const cancelled = issues[pendingCancelIssueIdx];
        const recalced = recalcRemaining(receiving, newI);
        const btn = document.getElementById('confirmCancelIssueBtn');
        isSaving = true; btn.disabled = true; btn.textContent = '⏳ Cancelling...';
        const ok = await persist(recalced, newI, 'Issue cancel ho raha hai...');
        isSaving = false; btn.disabled = false; btn.textContent = '✅ Yes, Cancel This Issue';
        if (ok) {
          issues = newI; receiving = recalced;
          renderReceivingTable(); renderIssueTable(); renderRejectedTable(); renderIQCTable(); renderHoldTable();
          const sap = document.getElementById('issueSapCode').value;
          if (sap) refreshStockInfo(sap);
          closeModal('cancelIssueModal');
          showToast(`✅ Issue cancel ho gaya — Batch ${cancelled.batchNo} ki ${cancelled.qty} Kg / ${cancelled.roll} Roll stock me wapas aa gayi`);
        }
      }

      // ── REJECTED TAB ──
      function getFilteredRejected() {
        const q = (document.getElementById('rejSearch').value || '').toLowerCase();
        const df = document.getElementById('rejDateFrom').value;
        const dt = document.getElementById('rejDateTo').value;
        const ret = document.getElementById('rejReturnedFilter').value;
        const dtFrom = df && isValidDate(df) ? parseDMY(df) : null;
        const dtTo = dt && isValidDate(dt) ? parseDMY(dt) : null;
        return receiving.filter(r => {
          if (!isRejected(r)) return false;
          if (q && !([r.batchNo, r.sapCode, r.description, r.docNumber, r.location, r.partyName || '', r.remark || '', String(r.qty)].join(' ').toLowerCase().includes(q))) return false;
          if (ret === 'yes' && r.status !== 'Returned') return false;
          if (ret === 'no' && r.status === 'Returned') return false;
          const rd = parseDMY(dateToDMY(r.recDate));
          if (dtFrom && rd && rd < dtFrom) return false;
          if (dtTo && rd && rd > dtTo) return false;
          return true;
        });
      }

      function renderRejectedTable() {
        const body = document.getElementById('rejectedBody'); body.innerHTML = '';
        const filtered = getFilteredRejected();
        const total = filtered.length;
        const allRej = receiving.filter(r => isRejected(r) || r.status === 'Returned').length;
        const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (rejPage > maxPage) rejPage = maxPage;
        document.getElementById('rejectedCount').textContent = allRej ? `(${total} shown / ${allRej} total rejected)` : '';
        if (!allRej) { document.getElementById('alertRejected').classList.add('show'); document.getElementById('rejectedTableWrap').style.display = 'none'; document.getElementById('rejPagination').innerHTML = ''; return }
        document.getElementById('alertRejected').classList.remove('show'); document.getElementById('rejectedTableWrap').style.display = '';
        if (total === 0) { body.innerHTML = '<tr><td colspan="12" class="empty-state">No matching rejected records found.</td></tr>'; renderPagination('rej', 0, 0); return }
        const start = (rejPage - 1) * PAGE_SIZE, end = Math.min(start + PAGE_SIZE, total);
        filtered.slice(start, end).forEach((r, i) => {
          const globalIdx = receiving.indexOf(r);
          const tr = document.createElement('tr');
          const returned = r.status === 'Returned';
          const retBadge = returned ? `<span class="badge badge-returned">📦 Returned</span>` : `<span class="badge badge-pending">⏳ Pending</span>`;
          const actionBtn = returned
            ? `<div class="action-btns">—</div>`
            : `<div class="action-btns"><button class="btn btn-orange btn-sm" onclick="openPartyModal(${globalIdx})">📦 Send to Party</button><button class="btn btn-sm" style="background:#f0fdf4;border:1px solid #86efac;color:#166534" onclick="openRejSticker(${globalIdx})">🏷️ Sticker</button></div>`;
          tr.innerHTML = `<td class="mono">${total - start - i}</td>
      <td class="mono">${dateToDMY(r.recDate) || '—'}</td>
      <td>${escapeHtml(r.docNumber) || '—'}</td>
     <td class="mono" style="color:var(--accent2)">
  <span class="batch-tip" onclick="toggleTip(this,event)">${escapeHtml(r.batchNo)}
    <span class="tip-box">${escapeHtml(r.remark) || 'No remark'}</span>
  </span>
</td>
      <td class="mono" style="color:var(--yellow)">${escapeHtml(r.sapCode)}</td>
      <td style="max-width:140px;font-size:11px">${escapeHtml(r.description)}</td>
     <td class="mono">${fmtKg(r.origQty || r.qty)}<small style="color:#5b21b6"> (rem:${fmtKg(r.remainQty)})</small></td>
<td class="mono">${fmtNum(r.origRoll || r.roll)}<small style="color:#5b21b6"> (rem:${fmtNum(r.remainRoll)})</small></td>
      <td>${escapeHtml(r.location) || '—'}</td>
      <td style="color:var(--text3);font-size:11px">${escapeHtml(r.remark) || '—'}</td>
      <td>${retBadge}</td>
<td>${actionBtn}</td>`;
          body.appendChild(tr);
        });
        renderPagination('rej', total, maxPage);
      }

      function openPartyModal(idx) {
        pendingPartyIdx = idx;
        const r = receiving[idx];
        document.getElementById('partyFormContent').innerHTML = `
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:16px;font-size:12px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><span style="color:var(--text3)">Batch:</span> <strong class="mono">${escapeHtml(r.batchNo)}</strong></div>
        <div><span style="color:var(--text3)">SAP:</span> <strong style="color:var(--yellow)">${escapeHtml(r.sapCode)}</strong></div>
        <div style="grid-column:span 2"><span style="color:var(--text3)">Description:</span> <strong>${escapeHtml(r.description)}</strong></div>
        <div><span style="color:var(--text3)">Qty:</span> <strong class="mono">${r.qty} Kg</strong></div>
        <div><span style="color:var(--text3)">Roll:</span> <strong class="mono">${r.roll} Nos</strong></div>
        <div><span style="color:var(--text3)">Location:</span> <strong>${escapeHtml(r.location) || '—'}</strong></div>
        <div><span style="color:var(--text3)">Remark:</span> <strong>${escapeHtml(r.remark) || '—'}</strong></div>
      </div>
    </div>
    
    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:7px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#991b1b">
      ⚠️ Party ko bhejne ke baad <strong>Curr Qty/Roll 0</strong> ho jayenge aur Return Stock ${r.remainQty} Kg, Return Roll ${r.remainRoll} Nos ke roop mein save ho jayega.
    </div>`;
        document.getElementById('partyModal').classList.add('show');
      }

      async function confirmSendToParty() {
        if (pendingPartyIdx === null) return;
        if (isSaving) { showToast('⏳ Wait karo', 'warn'); return }
        const newR = [...receiving];
        const r = { ...newR[pendingPartyIdx] };
        r.returnStock = r.remainQty;
        r.returnRoll = r.remainRoll;
        r.remainQty = 0; r.remainRoll = 0;
        r.returnedToParty = true;
        r.status = 'Returned';
        r.returnedAt = new Date().toISOString();
        newR[pendingPartyIdx] = r;
        const recalced = recalcRemaining(newR, issues);
        const btn = document.getElementById('sendPartyBtn');
        isSaving = true; btn.disabled = true; btn.textContent = '⏳ Saving...';
        const ok = await persist(recalced, issues, 'Party return save ho raha hai...');
        isSaving = false; btn.disabled = false; btn.textContent = '✅ Confirm Return to Party';
        if (ok) {
          receiving = recalced;
          renderReceivingTable(); renderIssueTable(); renderRejectedTable(); renderIQCTable(); renderHoldTable();
          closeModal('partyModal');
          showToast(`✅ Batch ${r.batchNo} return ho gayi — Return Stock: ${r.returnStock}, Return Roll: ${r.returnRoll}`);
        }
      }

      // ── SAP / ISSUE LOGIC ──
      function populateSapDropdown() {
        const sel = document.getElementById('issueSapCode'), prev = sel.value;
        sel.innerHTML = '<option value="">-- Select SAP Code --</option>';
        const uniq = [...new Set(receiving.map(r => r.sapCode).filter(Boolean))].sort();
        uniq.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o) });
        if (prev && uniq.includes(prev)) sel.value = prev;
      }
      function onSapSelect() {
        const sap = document.getElementById('issueSapCode').value;
        document.getElementById('stockInfo').style.display = sap ? '' : 'none';
        showIssueAlert('');
        if (!sap) return;
        refreshStockInfo(sap); populateSpecialBatch(sap);
      }
      function getApprovedBatches(sap, src) {
        return (src || receiving).filter(r => r.sapCode === sap && isApproved(r) && r.remainQty > 0).sort((a, b) => String(a.batchNo).localeCompare(String(b.batchNo)));
      }
      function refreshStockInfo(sap) {
        const approved = getApprovedBatches(sap);
        const totalQty = approved.reduce((s, r) => s + r.remainQty, 0);
        const totalRoll = approved.reduce((s, r) => s + r.remainRoll, 0);
        const active = approved[0];
        document.getElementById('siSap').textContent = sap;
        document.getElementById('siQty').textContent = fmtKg(totalQty);
        document.getElementById('siRoll').textContent = fmtNum(totalRoll);
        document.getElementById('siActiveBatch').innerHTML = active
          ? `<span class="batch-tip" onclick="toggleTip(this,event)">${escapeHtml(active.batchNo)}<span class="tip-box">${escapeHtml(active.remark) || 'No remark'}</span></span>`
          : 'N/A';
        const list = document.getElementById('batchQueueList'); list.innerHTML = '';
        if (!approved.length) { list.innerHTML = '<div class="empty-state">📭 Koi approved batch nahi — status Approved set karo receiving mein</div>'; return }
        approved.forEach((b, i) => {
          const div = document.createElement('div');
          div.className = 'batch-row' + (i === 0 ? ' active-batch' : '');
          div.innerHTML = `<div class="bno"><span class="batch-tip" onclick="toggleTip(this,event)">${escapeHtml(b.batchNo)}<span class="tip-box">${escapeHtml(b.remark) || 'No remark'}</span></span></div><div class="binfo">${b.description || '—'}</div><div class="bloc">📍 ${b.location || 'N/A'}</div><div class="bstock">Qty:${fmtKg(b.remainQty)} | Roll:${fmtNum(b.remainRoll)}</div>${i === 0 ? '<span class="badge badge-approved" style="font-size:10px">▶ Active</span>' : ''}`;
          list.appendChild(div);
        });
      }
      function populateSpecialBatch(sap) {
        const sel = document.getElementById('specialBatch');
        sel.innerHTML = '<option value="">-- Select Batch --</option>';
        receiving.filter(r => r.sapCode === sap && isIssuableForSpecial(r) && r.remainQty > 0)
          .sort((a, b) => String(a.batchNo).localeCompare(String(b.batchNo)))
          .forEach(r => {
            const o = document.createElement('option');
            o.value = r.batchNo;
            const statusTag = isTesting(r) ? ' ⚠️TESTING' : '';
            o.textContent = `${r.batchNo}${statusTag} | Loc:${r.location || '?'} | Qty:${fmtKg(r.remainQty)} | Roll:${r.remainRoll}`;
            sel.appendChild(o);
          });
      }
      function onSpecialToggle() { document.getElementById('specialBatchDiv').style.display = document.getElementById('specialApproval').checked ? '' : 'none' }
      function checkIssue() {
        const sap = document.getElementById('issueSapCode').value; if (!sap) return;
        const iq = round2(document.getElementById('issueQty').value);
        const ir = parseInt(document.getElementById('issueRoll').value) || 0;
        if (ir <= 0 && iq > 0) { showIssueAlert('⚠️ Roll 0 se zyada daalo', 'warn'); return }
        if (document.getElementById('specialApproval').checked) {
          const sb = document.getElementById('specialBatch').value;
          const infoBox = document.getElementById('specialBatchInfo');
          if (!sb) { infoBox.style.display = 'none'; return; }
          const b = receiving.find(r => r.batchNo === sb);
          if (!b) { infoBox.style.display = 'none'; return; }

          document.getElementById('specialBatchTipLabel').textContent = b.batchNo;
          document.getElementById('specialBatchTipText').textContent = b.remark || 'No remark';
          infoBox.style.display = 'block';

          if (iq > b.remainQty) { showIssueAlert(`❌ Qty zyada hai! Batch remaining: ${b.remainQty} Kg`, 'error'); return; }
          if (ir > b.remainRoll) { showIssueAlert(`❌ Roll zyada hai! Batch remaining: ${b.remainRoll} rolls`, 'error'); return; }
          if (isTesting(b)) { showIssueAlert(`⚠️ Ye batch abhi TESTING status me hai — sirf sample/QC purpose ke liye issue karo`, 'warn'); return; }
          showIssueAlert(''); return;
        }
        const batches = getApprovedBatches(sap);
        const totalQty = batches.reduce((s, r) => s + r.remainQty, 0);
        const totalRoll = batches.reduce((s, r) => s + r.remainRoll, 0);
        if (iq > totalQty) showIssueAlert(`❌ Qty kam hai! Available stock: ${totalQty} Kg`, 'error');
        else if (ir > totalRoll) showIssueAlert(`❌ Roll zyada hai! Available rolls: ${totalRoll}`, 'error');
        else showIssueAlert('');
      }
      function showIssueAlert(msg, type = 'warn') {
        const el = document.getElementById('issueAlert');
        if (!msg) { el.classList.remove('show'); return }
        el.className = 'alert alert-' + (type === 'error' ? 'error' : 'warn') + ' show'; el.textContent = msg;
      }
      async function processIssue() {
        if (isSaving) { showToast('⏳ Wait karo', 'warn'); return }
        const sap = document.getElementById('issueSapCode').value;
        const issueDate = document.getElementById('issueDate').value.trim();
        const issueTo = document.getElementById('issueTo').value;
        const iq = Math.max(0, Math.min(round2(document.getElementById('issueQty').value), 99999));
        const ir = Math.max(0, Math.min(parseInt(document.getElementById('issueRoll').value) || 0, 99999));
        const remarks = sanitize(document.getElementById('issueRemarks').value.trim());
        const special = document.getElementById('specialApproval').checked;
        if (!sap) { showToast('❌ SAP Code select karo', 'error'); return }
        if (!isValidDate(issueDate)) { showToast('❌ Issue date sahi format mein daalo: dd-mm-yyyy', 'error'); return }
        if (!issueTo) { showToast('❌ Issued To select karo', 'error'); return }
        if (iq <= 0) { showToast('❌ Qty 0 se zyada honi chahiye', 'error'); return }
        if (ir <= 0) { showToast('❌ Roll 0 se zyada hona chahiye', 'error'); return }
        let newIssues = null, msg = '';
        if (special) {
          const sb = document.getElementById('specialBatch').value;
          if (!sb) { showToast('❌ Batch select karo', 'error'); return }
          const batch = receiving.find(r => r.batchNo === sb);
          if (!batch) { showToast('❌ Batch nahi mili', 'error'); return }
          if (iq > batch.remainQty) { showToast(`❌ Qty zyada hai! Batch remaining: ${batch.remainQty} Kg`, 'error'); return }
          if (ir > batch.remainRoll) { showToast(`❌ Roll zyada hai! Batch remaining rolls: ${batch.remainRoll}`, 'error'); return }
          if (iq === batch.remainQty && ir !== batch.remainRoll) { showToast(`❌ Poori Qty (${batch.remainQty} Kg) le rahe ho — is batch ka Roll bhi pura (${batch.remainRoll}) daalna padega`, 'error'); return }
          if (ir === batch.remainRoll && iq !== batch.remainQty) { showToast(`❌ Poore Roll (${batch.remainRoll}) le rahe ho — is batch ki Qty bhi puri (${batch.remainQty} Kg) daalni padegi`, 'error'); return }
          newIssues = [{ issueDate, sap, batchNo: sb, description: batch.description || '', location: batch.location || '', issueTo, qty: iq, roll: ir, type: 'Special Approval', remarks, ts: new Date().toISOString() }, ...issues];
          msg = '⭐ Special issue done — Batch ' + sb;
        } else {
          const batches = getApprovedBatches(sap);
          const total = batches.reduce((s, r) => s + r.remainQty, 0);
          const totalRoll = batches.reduce((s, r) => s + r.remainRoll, 0);
          if (iq > total) { showToast(`❌ Qty kam hai! Available stock: ${total} Kg`, 'error'); return }
          if (ir > totalRoll) { showToast(`❌ Roll zyada hai! Available rolls: ${totalRoll}`, 'error'); return }
          let leftQty = iq, leftRoll = ir; const added = [], used = [];
          for (const b of batches) {
            if (leftQty <= 0) break;
            const tq = round2(Math.min(b.remainQty, leftQty)), tr2 = Math.min(b.remainRoll, leftRoll);
            leftQty = round2(leftQty - tq); leftRoll = Math.max(0, leftRoll - tr2);
            used.push(b.batchNo);
            added.push({ issueDate, sap, batchNo: b.batchNo, description: b.description || '', location: b.location || '', issueTo, qty: tq, roll: tr2, type: 'FIFO', remarks, ts: new Date().toISOString() });
          }
          for (const entry of added) {
            const origBatch = batches.find(b => b.batchNo === entry.batchNo);
            if (!origBatch) continue;
            const tookFullQty = entry.qty === origBatch.remainQty;
            const tookFullRoll = entry.roll === origBatch.remainRoll;
            if (tookFullQty && !tookFullRoll) { showToast(`❌ Batch ${entry.batchNo} ki poori Qty (${origBatch.remainQty} Kg) ja rahi hai lekin Roll adhoora reh gaya — Roll number adjust karke poora (${origBatch.remainRoll}) is batch ke liye dedo`, 'error'); return }
            if (tookFullRoll && !tookFullQty) { showToast(`❌ Batch ${entry.batchNo} ke poore Roll (${origBatch.remainRoll}) ja rahe hain lekin Qty adhoori reh gayi — Roll number adjust karo`, 'error'); return }
          }
          newIssues = [...added, ...issues]; msg = '✅ FIFO issue done — ' + used.join(', ');
        }
        const recalced = recalcRemaining(receiving, newIssues);
        const btn = document.getElementById('processIssueBtn');
        isSaving = true; btn.disabled = true; btn.textContent = '⏳ Saving...';
        const ok = await persist(recalced, newIssues, 'Issue sheet mein save ho raha hai...');
        isSaving = false; btn.disabled = false; btn.textContent = '✅ Process Issue';
        if (ok) { receiving = recalced; issues = newIssues; renderReceivingTable(); renderIssueTable(); renderRejectedTable(); renderIQCTable(); renderHoldTable(); const sap2 = document.getElementById('issueSapCode').value; if (sap2) refreshStockInfo(sap2); clearIssueForm(); showToast(msg) }
      }
      function clearIssueForm() {
        ['issueSapCode', 'issueTo', 'issueQty', 'issueRoll', 'issueRemarks'].forEach(id => document.getElementById(id).value = '');
        document.getElementById('specialApproval').checked = false;
        document.getElementById('specialBatchDiv').style.display = 'none';
        document.getElementById('stockInfo').style.display = 'none';
        document.getElementById('specialBatchInfo').style.display = 'none';
        showIssueAlert(''); setTodayDates();
      }

      function getFilteredIssues() {
        const q = (document.getElementById('issueSearch').value || '').toLowerCase();
        const df = document.getElementById('issueDateFrom').value;
        const dt = document.getElementById('issueDateTo').value;
        const typ = document.getElementById('issueTypeFilter').value;
        const dtFrom = df && isValidDate(df) ? parseDMY(df) : null;
        const dtTo = dt && isValidDate(dt) ? parseDMY(dt) : null;
        return issues.filter(is => {
          if (q && !([is.batchNo, is.sap, is.issueTo, is.description, is.location, is.remarks, String(is.qty)].join(' ').toLowerCase().includes(q))) return false;
          if (typ && is.type !== typ) return false;
          const rd = parseDMY(dateToDMY(is.issueDate));
          if (dtFrom && rd && rd < dtFrom) return false;
          if (dtTo && rd && rd > dtTo) return false;
          return true;
        });
      }
      function renderIssueTable() {
        const body = document.getElementById('issueBody'); body.innerHTML = '';
        const filtered = getFilteredIssues();
        const total = filtered.length;
        const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (issuePage > maxPage) issuePage = maxPage;
        if (!issues.length) { document.getElementById('alertIssue').classList.add('show'); document.getElementById('issueTableWrap').style.display = 'none'; document.getElementById('issuePagination').innerHTML = ''; return }
        document.getElementById('alertIssue').classList.remove('show'); document.getElementById('issueTableWrap').style.display = '';
        if (total === 0) { body.innerHTML = '<tr><td colspan="12" class="empty-state">No matching records found.</td></tr>'; renderPagination('issue', 0, 0); return }
        const start = (issuePage - 1) * PAGE_SIZE, end = Math.min(start + PAGE_SIZE, total);
        filtered.slice(start, end).forEach((is, i) => {
          const globalIdx = issues.indexOf(is);
          const tr = document.createElement('tr');
          tr.innerHTML = `<td class="mono">${total - start - i}</td>
      <td class="mono">${dateToDMY(is.issueDate) || '—'}</td>
      <td class="mono" style="color:var(--accent2)">
  <span class="batch-tip" onclick="toggleTip(this,event)">${escapeHtml(is.batchNo)}
    <span class="tip-box">${escapeHtml((receiving.find(r => r.batchNo === is.batchNo) || {}).remark) || 'No remark'}</span>
  </span>
</td>
      <td class="mono" style="color:var(--yellow)">${escapeHtml(is.sap)}</td>
      <td style="font-size:11px;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(is.description) || ''}">${escapeHtml(is.description) || '—'}</td>
      <td>${escapeHtml(is.issueTo) || '—'}</td>
      <td class="mono">${fmtKg(is.qty)}</td>
<td class="mono">${fmtNum(is.roll)}</td>
      <td><span class="badge ${is.type === 'FIFO' ? 'badge-fifo' : 'badge-special'}">${escapeHtml(is.type) || 'FIFO'}</span></td>
      <td style="color:var(--purple);font-weight:600">${escapeHtml(is.location) || '—'}</td>
      <td style="color:var(--text3)">${escapeHtml(is.remarks) || '—'}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-secondary btn-sm" onclick="openIssueEdit(${globalIdx})">✏️ Edit</button>
          <button class="btn btn-danger btn-sm" onclick="openCancelIssue(${globalIdx})">✕ Cancel</button>
        </div>
      </td>`;
          body.appendChild(tr);
        });
        renderPagination('issue', total, maxPage);
      }

      // ── STICKER for Receiving ──
      function openSticker(idx) {
        generateSticker(receiving[idx]);
      }



      function loadBatchMailTo() {
        return localStorage.getItem('batchMailTo') || '';
      }
      function saveBatchMailTo(val) {
        localStorage.setItem('batchMailTo', val);
      }

      function getLatestRecDate() {
        if (!receiving.length) return todayStr();
        let latest = null;
        receiving.forEach(r => {
          const d = parseDMY(dateToDMY(r.recDate));
          if (d && (!latest || d > latest)) latest = d;
        });
        if (!latest) return todayStr();
        return String(latest.getDate()).padStart(2, '0') + '-' + String(latest.getMonth() + 1).padStart(2, '0') + '-' + latest.getFullYear();
      }

      function openBatchMailModal() {
        batchMailExcluded = new Set();
        document.getElementById('batchMailTo').value = loadBatchMailTo();
        document.getElementById('batchMailDate').value = getLatestRecDate();
        document.getElementById('batchMailModal').classList.add('show');
        renderBatchMailPreview();
      }

      function renderBatchMailPreview() {
        const dateVal = document.getElementById('batchMailDate').value.trim();
        const body = document.getElementById('batchMailBody');
        const emptyEl = document.getElementById('batchMailEmpty');
        const wrap = document.getElementById('batchMailPreviewWrap');
        const btn = document.getElementById('sendBatchMailBtn');
        body.innerHTML = '';

        if (!isValidDate(dateVal)) {
          emptyEl.textContent = '⚠️ Sahi date format daalo: dd-mm-yyyy';
          emptyEl.classList.add('show'); wrap.style.display = 'none'; btn.disabled = true;
          return;
        }
        const allRows = receiving.filter(r => dateToDMY(r.recDate) === dateVal);
        const rows = allRows.filter(r => !batchMailExcluded.has(r.batchNo));
        if (!allRows.length) {
          emptyEl.textContent = 'ℹ️ Is date ka koi record nahi mila.';
          emptyEl.classList.add('show'); wrap.style.display = 'none'; btn.disabled = true;
          return;
        }
        if (!rows.length) {
          emptyEl.textContent = '⚠️ Saari rows hata di gayi hain — kam se kam ek rakho.';
          emptyEl.classList.add('show'); wrap.style.display = ''; btn.disabled = true;
          return;
        }
        emptyEl.classList.remove('show'); wrap.style.display = ''; btn.disabled = false;
        rows.forEach(r => {
          const tr = document.createElement('tr');
          tr.innerHTML = `<td class="mono">${escapeHtml(r.batchNo)}</td><td class="mono">${escapeHtml(r.sapCode)}</td><td>${escapeHtml(r.description)}</td><td class="mono">${fmtKg(r.qty)}</td><td class="mono">${fmtNum(r.roll)}</td>
      <td><span style="cursor:pointer;color:var(--red);font-weight:700" onclick="removeBatchMailRow('${escapeHtml(r.batchNo).replace(/'/g, "\\'")}')" title="Is row ko hatao">❌</span></td>`;
          body.appendChild(tr);
        });
      }

      function removeBatchMailRow(batchNo) {
        batchMailExcluded.add(batchNo);
        renderBatchMailPreview();
      }

      async function confirmSendBatchMail() {
        const dateVal = document.getElementById('batchMailDate').value.trim();
        if (!isValidDate(dateVal)) { showToast('❌ Sahi date daalo', 'error'); return; }
        const rows = receiving.filter(r => dateToDMY(r.recDate) === dateVal && !batchMailExcluded.has(r.batchNo));
        if (!rows.length) { showToast('❌ Bhejne ke liye koi row nahi bachi', 'error'); return; }

        const toRaw = document.getElementById('batchMailTo').value.trim();
        const toList = toRaw.split(',').map(x => x.trim()).filter(Boolean);
        if (!toList.length) { showToast('❌ Kam se kam ek mail ID daalo', 'error'); return; }
        saveBatchMailTo(toRaw);
        const to = toList.join(',');
        const subject = `Roll Receiving Notification – ${dateVal} (${rows.length} Batches)`;

        const tableRows = rows.map(r => `
    <tr>
      <td style="border:1px solid #333;padding:6px 10px">${escapeHtml(r.batchNo)}</td>
      <td style="border:1px solid #333;padding:6px 10px">${escapeHtml(r.sapCode)}</td>
      <td style="border:1px solid #333;padding:6px 10px">${escapeHtml(r.description)}</td>
      <td style="border:1px solid #333;padding:6px 10px">${fmtKg(r.qty)} Kg</td>
      <td style="border:1px solid #333;padding:6px 10px">${fmtNum(r.roll)} Nos</td>
      <td style="border:1px solid #333;padding:6px 10px">${escapeHtml(r.remark) || '—'}</td>
    </tr>`).join('');

        const bodyHtml = `
  <div style="font-family:Arial,sans-serif;font-size:13px;color:#222">
    <p>Dear Sir/Madam,</p>
    <p>Please be informed that the Store Department has received the following rolls on <strong>${dateVal}</strong>.</p>
    <table style="border-collapse:collapse;width:100%;margin:12px 0">
      <tr>
        <td style="border:1px solid #333;padding:6px 10px;background:#f2f2f2;font-weight:bold">Batch No</td>
        <td style="border:1px solid #333;padding:6px 10px;background:#f2f2f2;font-weight:bold">SAP Code</td>
        <td style="border:1px solid #333;padding:6px 10px;background:#f2f2f2;font-weight:bold">Description</td>
        <td style="border:1px solid #333;padding:6px 10px;background:#f2f2f2;font-weight:bold">Received Qty</td>
        <td style="border:1px solid #333;padding:6px 10px;background:#f2f2f2;font-weight:bold">Received Rolls</td>
        <td style="border:1px solid #333;padding:6px 10px;background:#f2f2f2;font-weight:bold">Remark</td>
      </tr>
      ${tableRows}
    </table>
    <p>Regards,<br>Store Department</p>
  </div>`;

        const btn = document.getElementById('sendBatchMailBtn');
        btn.disabled = true; btn.textContent = '⏳ Sending...';
        try {
          const resp = await apiCall('sendMail', { to, subject, bodyHtml });
          if (resp.status === 'ok') {
            showToast(`✅ Mail bhej diya — ${rows.length} batches (${dateVal})`);
            closeModal('batchMailModal');
          } else {
            showToast('❌ Mail bhejne mein error: ' + (resp.msg || 'unknown'), 'error');
          }
        } catch (e) {
          showToast('❌ Network error: ' + e.message, 'error');
        } finally {
          btn.disabled = false; btn.textContent = '✅ Send Mail';
        }
      }

      // ── STICKER for Rejected ──
      function openRejSticker(idx) {
        generateRejectedSticker(receiving[idx]);
      }

      // ════════════════════════════════════════════════
      // FIXED generateSticker — A4, 2×8 grid per page
      // ════════════════════════════════════════════════
      function generateSticker(r) {
        const area = document.getElementById('stickerPrintArea');
        const rollCount = Math.max(1, parseInt(r.roll) || 1);

        // Kitne blank cells chahiye taaki total 16 ka multiple ho
        const blanksNeeded = (16 - (rollCount % 16)) % 16;
        const totalCells = rollCount + blanksNeeded;

        function makeFilledCell() {
          return `<div style="
      width:99.1mm;
      height:33.9mm;
      box-sizing:border-box;
      padding:1mm 4mm;
      display:flex;
      flex-direction:column;
      justify-content:center;
      gap:1mm;
      font-family:Arial,Helvetica,sans-serif;
      text-align:left;
border:0.3mm dashed #ccc;
    ">
     <div style="font-size:3.5mm;font-weight:900;color:#1e2130;line-height:1.1">
        <span style="font-weight:600;color:#6b7280">BATCH : </span>${escapeHtml(r.batchNo)}&nbsp;&nbsp;&nbsp;
        <span style="font-weight:600;color:#6b7280">SAP : </span>${escapeHtml(r.sapCode)}
      </div>

      <div style="font-size:3.2mm;font-weight:900;color:#1e2130;line-height:1.1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">
        <span style="font-weight:600;color:#6b7280">DESC : </span>${escapeHtml(r.description)}
      </div>

      <div style="font-size:3.2mm;font-weight:900;color:#1e2130;line-height:1.1">
        <span style="font-weight:600;color:#6b7280">MIGO : </span>${escapeHtml(r.docNumber) || '—'}
      </div>

      <div style="font-size:3.2mm;font-weight:900;color:#1e2130;line-height:1.1">
        <span style="font-weight:600;color:#6b7280">DATE : </span>${dateToDMY(r.recDate) || '—'}&nbsp;&nbsp;&nbsp;
        <span style="font-weight:600;color:#6b7280">LOCATION : </span>${escapeHtml(r.location) || '—'}
      </div>

      ${r.remark ? `
      <div style="font-size:3.2mm;font-weight:900;color:#1e2130;line-height:1.1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">
        <span style="font-weight:600;color:#6b7280">REMARK : </span>${escapeHtml(r.remark)}
      </div>` : ''}
    </div>`;
        }

        function makeBlankCell() {
          return `<div style="width:99.1mm;height:33.9mm;box-sizing:border-box;border:0.3mm dashed #eee;"></div>`;
        }

        // Saare cells banao
        let allCells = '';
        for (let i = 0; i < rollCount; i++) {
          allCells += makeFilledCell();
        }
        for (let i = 0; i < blanksNeeded; i++) {
          allCells += makeBlankCell();
        }

        // Kitne pages?
        const totalPages = totalCells / 16;

        // Har page ke liye ek grid div banao
        let pagesHtml = '';
        for (let p = 0; p < totalPages; p++) {
          const pageCells = [];
          for (let c = 0; c < 16; c++) {
            const idx = p * 16 + c;
            // Cells already generated — slice kar lo
            pageCells.push(idx < rollCount ? makeFilledCell() : makeBlankCell());
          }
          pagesHtml += `<div style="
      width:210mm;
      height:297mm;
      padding-top:11mm;
      padding-left:8mm;
      box-sizing:border-box;
      display:grid;
      grid-template-columns:99.1mm 99.1mm;
      grid-template-rows:repeat(8,33.9mm);
      column-gap:2mm;
      row-gap:0mm;
      background:#fff;
      page-break-after:${p < totalPages - 1 ? 'always' : 'avoid'};
      overflow:hidden;
    ">${pageCells.join('')}</div>`;
        }

        area.innerHTML = pagesHtml;
        document.getElementById('stickerModal').classList.add('show');
      }

      // ════════════════════════════════════════════════
      // generateRejectedSticker — single A4 page, plain B/W
      // ════════════════════════════════════════════════
      function generateRejectedSticker(r) {
        const area = document.getElementById('stickerPrintArea');
        area.innerHTML = `
  <div style="
    width:210mm;height:297mm;
    box-sizing:border-box;
    padding:10mm;
    display:flex;flex-direction:column;
    font-family:Arial,Helvetica,sans-serif;
    background:#fff;color:#000;
    overflow:hidden;
  ">
    <div class="keep-border" style="border:2px solid #000;text-align:center;padding:6mm 4mm;margin-bottom:6mm;">
      <div style="font-size:13mm;font-weight:900;letter-spacing:2mm;line-height:1">REJECTED</div>
      <div style="font-size:5mm;font-weight:700;letter-spacing:1.5mm;margin-top:2mm;">DO NOT ISSUE</div>
    </div>

    <div class="keep-border" style="border:1.2px solid #000;">
      ${[
            ['Batch No. :', escapeHtml(r.batchNo), '9mm'],
            ['SAP Code :', escapeHtml(r.sapCode), '8mm'],
            ['Description :', escapeHtml(r.description) || '—', '7mm'],
            ['MIGO / Doc No. :', escapeHtml(r.docNumber) || '—', '6.5mm'],
            ['Rec. Date :', dateToDMY(r.recDate) || '—', '6.5mm'],
            ['Qty :', fmtKg(r.origQty || r.qty) + ' Kg (rem: ' + fmtKg(r.remainQty) + ')', '6.5mm'],
            ['Roll :', (r.origRoll || r.roll) + ' Nos (rem: ' + fmtNum(r.remainRoll) + ')', '6.5mm'],
            ['Location :', escapeHtml(r.location) || '—', '6.5mm'],
            ['Remark :', escapeHtml(r.remark) || '—', '6.5mm'],
          ].map(([label, val, sz], i) => `
        <div style="display:flex;align-items:center;padding:2.6mm 5mm;${i > 0 ? 'border-top:1px solid #000;' : ''}">
          <div style="width:50mm;font-size:4.2mm;font-weight:700;text-transform:uppercase;letter-spacing:.3mm;">${label}</div>
          <div style="flex:1;font-size:${sz};font-weight:900;font-family:monospace;line-height:1.2">${val}</div>
        </div>
      `).join('')}
    </div>
  </div>`;
        document.getElementById('stickerModal').classList.add('show');
      }

      function generateHoldSticker(r) {
        const area = document.getElementById('stickerPrintArea');
        area.innerHTML = `
<div style="
width:210mm;height:297mm;
box-sizing:border-box;
padding:10mm;
display:flex;flex-direction:column;
font-family:Arial,Helvetica,sans-serif;
background:#fff;color:#000;
overflow:hidden;
">
<div class="keep-border" style="border:2px solid #000;text-align:center;padding:6mm 4mm;margin-bottom:6mm;">
  <div style="font-size:13mm;font-weight:900;letter-spacing:2mm;line-height:1">HOLD BY USER</div>
  <div style="font-size:5mm;font-weight:700;letter-spacing:1.5mm;margin-top:2mm;">DO NOT ISSUE</div>
</div>

<div class="keep-border" style="border:1.2px solid #000;">
  ${[
            ['Batch No. :', escapeHtml(r.batchNo), '9mm'],
            ['SAP Code :', escapeHtml(r.sapCode), '8mm'],
            ['Description :', escapeHtml(r.description) || '—', '7mm'],
            ['MIGO / Doc No. :', escapeHtml(r.docNumber) || '—', '6.5mm'],
            ['Rec. Date :', dateToDMY(r.recDate) || '—', '6.5mm'],
            ['Qty :', fmtKg(r.qty) + ' Kg (rem: ' + fmtKg(r.remainQty) + ')', '6.5mm'],
            ['Roll :', r.roll + ' Nos (rem: ' + fmtNum(r.remainRoll) + ')', '6.5mm'],
            ['Location :', escapeHtml(r.location) || '—', '6.5mm'],
            ['Remark :', escapeHtml(r.remark) || '—', '6.5mm'],
          ].map(([label, val, sz], i) => `
    <div style="display:flex;align-items:center;padding:2.6mm 5mm;${i > 0 ? 'border-top:1px solid #000;' : ''}">
      <div style="width:50mm;font-size:4.2mm;font-weight:700;text-transform:uppercase;letter-spacing:.3mm;">${label}</div>
      <div style="flex:1;font-size:${sz};font-weight:900;font-family:monospace;line-height:1.2">${val}</div>
    </div>
  `).join('')}
</div>
</div>`;
        document.getElementById('stickerModal').classList.add('show');
      }

      function generateIQCSticker(r) {
        const area = document.getElementById('stickerPrintArea');
        area.innerHTML = `
<div style="
width:210mm;height:297mm;
box-sizing:border-box;
padding:10mm;
display:flex;flex-direction:column;
font-family:Arial,Helvetica,sans-serif;
background:#fff;color:#000;
overflow:hidden;
">
<div class="keep-border" style="border:2px solid #000;text-align:center;padding:6mm 4mm;margin-bottom:6mm;">
  <div style="font-size:13mm;font-weight:900;letter-spacing:2mm;line-height:1">UNDER IQC</div>
  <div style="font-size:5mm;font-weight:700;letter-spacing:1.5mm;margin-top:2mm;">TESTING — DO NOT ISSUE</div>
</div>

<div class="keep-border" style="border:1.2px solid #000;">
  ${[
            ['Batch No. :', escapeHtml(r.batchNo), '9mm'],
            ['SAP Code :', escapeHtml(r.sapCode), '8mm'],
            ['Description :', escapeHtml(r.description) || '—', '7mm'],
            ['MIGO / Doc No. :', escapeHtml(r.docNumber) || '—', '6.5mm'],
            ['Rec. Date :', dateToDMY(r.recDate) || '—', '6.5mm'],
            ['Qty :', fmtKg(r.qty) + ' Kg (rem: ' + fmtKg(r.remainQty) + ')', '6.5mm'],
            ['Roll :', r.roll + ' Nos (rem: ' + fmtNum(r.remainRoll) + ')', '6.5mm'],
            ['Location :', escapeHtml(r.location) || '—', '6.5mm'],
            ['Remark :', escapeHtml(r.remark) || '—', '6.5mm'],
          ].map(([label, val, sz], i) => `
    <div style="display:flex;align-items:center;padding:2.6mm 5mm;${i > 0 ? 'border-top:1px solid #000;' : ''}">
      <div style="width:50mm;font-size:4.2mm;font-weight:700;text-transform:uppercase;letter-spacing:.3mm;">${label}</div>
      <div style="flex:1;font-size:${sz};font-weight:900;font-family:monospace;line-height:1.2">${val}</div>
    </div>
  `).join('')}
</div>
</div>`;
        document.getElementById('stickerModal').classList.add('show');
      }

      function showToast(msg, type = 'success') {
        const wrap = document.getElementById('toastWrap');
        const d = document.createElement('div');
        d.className = 'toast t-' + type; d.textContent = msg;
        wrap.appendChild(d); setTimeout(() => d.remove(), 4000);
      }

      // Flatpickr init
      const fpConfig = { dateFormat: 'd-m-Y', allowInput: true };
      flatpickr('#recDate', fpConfig);
      flatpickr('#issueDate', fpConfig);
      flatpickr('#recDateFrom', fpConfig);
      flatpickr('#recDateTo', fpConfig);
      flatpickr('#issueDateFrom', fpConfig);
      flatpickr('#issueDateTo', fpConfig);
      flatpickr('#rejDateFrom', fpConfig);
      flatpickr('#rejDateTo', fpConfig);
      flatpickr('#iqcDateFrom', fpConfig);
      flatpickr('#iqcDateTo', fpConfig);
      flatpickr('#holdDateFrom', fpConfig);
      flatpickr('#holdDateTo', fpConfig);
      flatpickr('#repDateFrom', fpConfig);
      flatpickr('#repDateTo', fpConfig);
      flatpickr('#batchMailDate', fpConfig);


      // Block '-', '+', 'e' keys on all number inputs (qty/roll fields etc.)
      document.addEventListener('keydown', function (e) {
        if (e.target.tagName === 'INPUT' && e.target.type === 'number') {
          if (e.key === '-' || e.key === '+' || e.key === 'e' || e.key === 'E') {
            e.preventDefault();
          }
        }
      });

      // Also block pasting a negative number
      document.addEventListener('paste', function (e) {
        if (e.target.tagName === 'INPUT' && e.target.type === 'number') {
          const text = (e.clipboardData || window.clipboardData).getData('text');
          if (/[-eE+]/.test(text)) e.preventDefault();
        }
      });

      function fmtNum(n) {
        n = Number(n) || 0;
        const rounded = Math.round(n * 100) / 100;
        return rounded % 1 === 0 ? String(rounded) : rounded.toFixed(2);
      }
      function fmtKg(n) {
        n = Number(n) || 0;
        return (Math.round(n * 100) / 100).toFixed(2);
      }
      function round2(n) {
        return Math.round((parseFloat(n) || 0) * 100) / 100;
      }


      // ── REPORT TAB LOGIC ──
      let currentReportData = [], currentReportHeaders = [];

      function clearReportFilters() {
        ['repSearch', 'repDateFrom', 'repDateTo', 'repSapFilter', 'repBatchFilter'].forEach(id => document.getElementById(id).value = '');
        document.getElementById('repStatusFilter').value = '';
        document.getElementById('reportType').value = 'batch';
        currentReportData = []; currentReportHeaders = []; currentReportSummary = {};
        reportPage = 1;
        document.getElementById('alertReport').classList.add('show');
        document.getElementById('alertReport').textContent = 'ℹ️ Report generate karne ke liye upar options select karke "Generate Report" click karo.';
        document.getElementById('reportTableWrap').style.display = 'none';
        document.getElementById('reportSummaryCards').innerHTML = '';
        document.getElementById('reportCount').textContent = '';
        document.getElementById('reportPagination').innerHTML = '';
      }

      function getReportFilteredReceiving() {
        const q = (document.getElementById('repSearch').value || '').toLowerCase().trim();
        const df = document.getElementById('repDateFrom').value;
        const dt = document.getElementById('repDateTo').value;
        const sap = (document.getElementById('repSapFilter').value || '').toLowerCase().trim();
        const batch = (document.getElementById('repBatchFilter').value || '').toLowerCase().trim();
        const st = document.getElementById('repStatusFilter').value;
        const dtFrom = df && isValidDate(df) ? parseDMY(df) : null;
        const dtTo = dt && isValidDate(dt) ? parseDMY(dt) : null;
        return receiving.filter(r => {
          if (q && !([r.batchNo, r.sapCode, r.description, r.docNumber, r.location, r.remark || '', String(r.qty)].join(' ').toLowerCase().includes(q))) return false;
          if (sap && !String(r.sapCode).toLowerCase().includes(sap)) return false;
          if (batch && !String(r.batchNo).toLowerCase().includes(batch)) return false;
          if (st && r.status !== st) return false;
          const rd = parseDMY(dateToDMY(r.recDate));
          if (dtFrom && rd && rd < dtFrom) return false;
          if (dtTo && rd && rd > dtTo) return false;
          return true;
        });
      }

      function getReportFilteredIssues() {
        const q = (document.getElementById('repSearch').value || '').toLowerCase().trim();
        const df = document.getElementById('repDateFrom').value;
        const dt = document.getElementById('repDateTo').value;
        const sap = (document.getElementById('repSapFilter').value || '').toLowerCase().trim();
        const batch = (document.getElementById('repBatchFilter').value || '').toLowerCase().trim();
        const dtFrom = df && isValidDate(df) ? parseDMY(df) : null;
        const dtTo = dt && isValidDate(dt) ? parseDMY(dt) : null;
        return issues.filter(is => {
          if (q && !([is.batchNo, is.sap, is.issueTo, is.description, is.location, is.remarks, String(is.qty)].join(' ').toLowerCase().includes(q))) return false;
          if (sap && !String(is.sap).toLowerCase().includes(sap)) return false;
          if (batch && !String(is.batchNo).toLowerCase().includes(batch)) return false;
          const rd = parseDMY(dateToDMY(is.issueDate));
          if (dtFrom && rd && rd < dtFrom) return false;
          if (dtTo && rd && rd > dtTo) return false;
          return true;
        });
      }

      function generateReport() {
        const type = document.getElementById('reportType').value;
        const filteredRec = getReportFilteredReceiving();
        const filteredIssues = getReportFilteredIssues();
        const dateFilterActive = document.getElementById('repDateFrom').value || document.getElementById('repDateTo').value;
        let headers = [], rows = [], summary = {};

        if (type === 'batch') {
          headers = ['Batch No', 'Rec. Date', 'SAP Code', 'Description', 'Location', 'Status', 'Rec Qty', 'Rec Roll',
            dateFilterActive ? 'Issued Qty (in range)' : 'Issued Qty',
            dateFilterActive ? 'Issued Roll (in range)' : 'Issued Roll',
            'Remain Qty (current)', 'Remain Roll (current)', 'Remark'];
          rows = filteredRec.map(r => {
            const issuedQty = filteredIssues.filter(is => is.batchNo === r.batchNo).reduce((s, x) => s + (Number(x.qty) || 0), 0);
            const issuedRoll = filteredIssues.filter(is => is.batchNo === r.batchNo).reduce((s, x) => s + (Number(x.roll) || 0), 0);
            return [r.batchNo, dateToDMY(r.recDate), r.sapCode, r.description, r.location || '—', r.status, fmtKg(r.qty), fmtNum(r.roll), fmtKg(issuedQty), fmtNum(issuedRoll), fmtKg(r.remainQty), fmtNum(r.remainRoll), r.remark || '—'];
          });
          summary = {
            'Total Batches': filteredRec.length,
            'Total Rec Qty': fmtKg(filteredRec.reduce((s, r) => s + r.qty, 0)),
            'Total Rec Roll': fmtNum(filteredRec.reduce((s, r) => s + r.roll, 0)),
            'Total Remain Qty': fmtKg(filteredRec.reduce((s, r) => s + r.remainQty, 0))
          };
        } else if (type === 'sap') {
          const map = {};
          const filteredBatchSet = new Set(filteredRec.map(r => r.batchNo));   // ⬅️ NEW LINE
          filteredRec.forEach(r => {
            if (!map[r.sapCode]) map[r.sapCode] = { sapCode: r.sapCode, description: r.description, batches: 0, recQty: 0, recRoll: 0, remainQty: 0, remainRoll: 0, issuedQty: 0, issuedRoll: 0 };
            map[r.sapCode].batches++; map[r.sapCode].recQty += r.qty; map[r.sapCode].recRoll += r.roll;
            map[r.sapCode].remainQty += r.remainQty; map[r.sapCode].remainRoll += r.remainRoll;
          });
          filteredIssues.forEach(is => {
            if (!filteredBatchSet.has(is.batchNo)) return;   // ⬅️ NEW LINE — skip issues jinki batch current filters (status/sap/batch/date) pass nahi karti
            if (!map[is.sap]) {
              const anyRec = receiving.find(r => r.sapCode === is.sap);
              map[is.sap] = { sapCode: is.sap, description: anyRec ? anyRec.description : (is.description || ''), batches: 0, recQty: 0, recRoll: 0, remainQty: 0, remainRoll: 0, issuedQty: 0, issuedRoll: 0 };
            }
            map[is.sap].issuedQty += Number(is.qty) || 0; map[is.sap].issuedRoll += Number(is.roll) || 0;
          });
          headers = ['SAP Code', 'Description', 'Batches', 'Rec Qty', 'Rec Roll',
            dateFilterActive ? 'Issued Qty (in range)' : 'Issued Qty',
            dateFilterActive ? 'Issued Roll (in range)' : 'Issued Roll',
            'Remain Qty (current)', 'Remain Roll (current)'];
          rows = Object.values(map).map(m => [m.sapCode, m.description, m.batches, fmtKg(m.recQty), fmtNum(m.recRoll), fmtKg(m.issuedQty), fmtNum(m.issuedRoll), fmtKg(m.remainQty), fmtNum(m.remainRoll)]);
          summary = {
            'Total SAP Codes': Object.keys(map).length,
            'Total Rec Qty': fmtKg(Object.values(map).reduce((s, m) => s + m.recQty, 0)),
            'Total Issued Qty': fmtKg(Object.values(map).reduce((s, m) => s + m.issuedQty, 0))
          };
        } else if (type === 'status') {
          const map = {};
          filteredRec.forEach(r => {
            const s = r.status || 'Pending';
            if (!map[s]) map[s] = { status: s, count: 0, qty: 0, roll: 0 };
            map[s].count++; map[s].qty += r.qty; map[s].roll += r.roll;
          });
          headers = ['Status', 'Batch Count', 'Total Qty', 'Total Roll'];
          rows = Object.values(map).map(m => [m.status, m.count, fmtKg(m.qty), fmtNum(m.roll)]);
          summary = { 'Total Batches': filteredRec.length, 'Statuses': Object.keys(map).length };
        } else if (type === 'daily') {
          const map = {}, issueMap = {};
          filteredRec.forEach(r => {
            const d = dateToDMY(r.recDate);
            if (!map[d]) map[d] = { recQty: 0, recRoll: 0, batches: 0 };
            map[d].recQty += r.qty; map[d].recRoll += r.roll; map[d].batches++;
          });
          filteredIssues.forEach(is => {
            const d = dateToDMY(is.issueDate);
            if (!issueMap[d]) issueMap[d] = { issuedQty: 0, issuedRoll: 0 };
            issueMap[d].issuedQty += Number(is.qty) || 0; issueMap[d].issuedRoll += Number(is.roll) || 0;
          });
          const allDates = [...new Set([...Object.keys(map), ...Object.keys(issueMap)])].sort((a, b) => {
            const da = parseDMY(a), db = parseDMY(b); return (da && db) ? da - db : 0;
          });
          headers = ['Date', 'Rec Qty', 'Rec Roll', 'Batches Rec', 'Issued Qty', 'Issued Roll'];
          rows = allDates.map(d => [d, fmtKg(map[d]?.recQty || 0), fmtNum(map[d]?.recRoll || 0), map[d]?.batches || 0, fmtKg(issueMap[d]?.issuedQty || 0), fmtNum(issueMap[d]?.issuedRoll || 0)]);
          summary = {
            'Total Days': allDates.length,
            'Total Rec Qty': fmtKg(filteredRec.reduce((s, r) => s + r.qty, 0)),
            'Total Issued Qty': fmtKg(filteredIssues.reduce((s, i) => s + (Number(i.qty) || 0), 0))
          };
        } else if (type === 'issueLog') {
          headers = ['Issue Date', 'Batch', 'SAP Code', 'Description', 'Issued To', 'Qty', 'Roll', 'Type', 'Location', 'Issue Remark', 'Batch Remark'];
          rows = filteredIssues.map(is => {
            const batchRec = receiving.find(r => r.batchNo === is.batchNo);
            return [dateToDMY(is.issueDate), is.batchNo, is.sap, is.description, is.issueTo, fmtKg(is.qty), fmtNum(is.roll), is.type, is.location, is.remarks || '—', (batchRec && batchRec.remark) || '—'];
          });
          summary = {
            'Total Issues': filteredIssues.length,
            'Total Qty Issued': fmtKg(filteredIssues.reduce((s, i) => s + (Number(i.qty) || 0), 0)),
            'Total Roll Issued': fmtNum(filteredIssues.reduce((s, i) => s + (Number(i.roll) || 0), 0))
          };
        } else if (type === 'activeBatches') {
          const uniqSaps = [...new Set(filteredRec.map(r => r.sapCode).filter(Boolean))].sort();
          headers = ['SAP Code', 'Description', 'Batch No', 'Location', 'Remain Qty', 'Remain Roll', 'Position', 'Remark'];
          rows = [];
          uniqSaps.forEach(sap => {
            const batches = getApprovedBatches(sap, filteredRec).slice(0, 3);
            batches.forEach((b, i) => {
              rows.push([sap, b.description, b.batchNo, b.location || '—', fmtKg(b.remainQty), fmtNum(b.remainRoll), i === 0 ? 'Active' : `Next ${i}`, b.remark || '—']);
            });
          });
          summary = {
            'Total SAP Codes': uniqSaps.length,
            'SAP with Active Stock': [...new Set(rows.map(r => r[0]))].length
          };
        } else if (type === 'locationStock') {
          const batchesWithStock = filteredRec.filter(r => r.remainQty > 0)
            .sort((a, b) => String(a.location || '').localeCompare(String(b.location || '')) || String(a.batchNo).localeCompare(String(b.batchNo)));
          headers = ['Location', 'Batch No', 'SAP Code', 'Description', 'Status', 'Rec Qty', 'Rec Roll', 'Remain Qty', 'Remain Roll', 'Remark'];
          rows = batchesWithStock.map(r => [r.location || '—', r.batchNo, r.sapCode, r.description, r.status, fmtKg(r.qty), fmtNum(r.roll), fmtKg(r.remainQty), fmtNum(r.remainRoll), r.remark || '—']);
          summary = {
            'Total Locations': [...new Set(batchesWithStock.map(r => r.location || '—'))].length,
            'Total Batches': batchesWithStock.length,
            'Total Remain Qty': fmtKg(batchesWithStock.reduce((s, r) => s + r.remainQty, 0))
          };
        }

        currentReportHeaders = headers; currentReportData = rows; currentReportSummary = summary;
        reportPage = 1;
        renderReportTable(headers, rows, summary);
      }

      function renderReportTable(headers, rows, summary) {
        document.getElementById('reportSummaryCards').innerHTML = Object.entries(summary).map(([k, v]) =>
          `<div class="stock-item"><label>${escapeHtml(k)}</label><div class="val accent">${escapeHtml(String(v))}</div></div>`
        ).join('');

        document.getElementById('reportTableHead').innerHTML = '<tr><th>#</th>' + headers.map(h => `<th>${escapeHtml(h)}</th>`).join('') + '</tr>';

        const tbody = document.getElementById('reportBody');
        const total = rows.length;
        if (total === 0) {
          document.getElementById('alertReport').classList.add('show');
          document.getElementById('alertReport').textContent = 'ℹ️ Koi data nahi mila in filters ke saath.';
          document.getElementById('reportTableWrap').style.display = 'none';
          document.getElementById('reportCount').textContent = '';
          document.getElementById('reportPagination').innerHTML = '';
          return;
        }
        document.getElementById('alertReport').classList.remove('show');
        document.getElementById('reportTableWrap').style.display = '';
        document.getElementById('reportCount').textContent = `(${total} rows)`;

        const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (reportPage > maxPage) reportPage = maxPage;
        const start = (reportPage - 1) * PAGE_SIZE, end = Math.min(start + PAGE_SIZE, total);

        const batchColIdx = headers.findIndex(h => h === 'Batch No' || h === 'Batch');
        const remarkColIdx = headers.findIndex(h => h === 'Remark' || h === 'Issue Remark');
        const batchRemarkColIdx = headers.findIndex(h => h === 'Batch Remark');

        tbody.innerHTML = rows.slice(start, end).map((row, i) => '<tr><td class="mono">' + (total - start - i) + '</td>' + row.map((cell, ci) => {
          if (batchColIdx !== -1 && ci === batchColIdx) {
            const rec = receiving.find(r => r.batchNo === cell);
            const remark = rec ? rec.remark : '';
            return `<td class="mono" style="color:var(--accent2)">
        <span class="batch-tip" onclick="toggleTip(this,event)">${escapeHtml(cell)}
          <span class="tip-box">${escapeHtml(remark) || 'No remark'}</span>
        </span>
      </td>`;
          }
          if (remarkColIdx !== -1 && ci === remarkColIdx) {
            return `<td style="color:var(--text3);font-size:11px">${escapeHtml(String(cell))}</td>`;
          }
          if (batchRemarkColIdx !== -1 && ci === batchRemarkColIdx) {
            return `<td style="color:var(--purple);font-size:11px">${escapeHtml(String(cell))}</td>`;
          }
          return `<td class="mono">${escapeHtml(String(cell))}</td>`;
        }).join('') + '</tr>').join('');

        renderPagination('report', total, maxPage);
      }

      function exportReportCSV() {
        if (!currentReportData.length) { showToast('❌ Pehle report generate karo', 'error'); return }
        let csv = currentReportHeaders.map(h => `"${h.replace(/"/g, '""')}"`).join(',') + '\n';
        currentReportData.forEach(row => { csv += row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',') + '\n' });
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `report_${document.getElementById('reportType').value}_${todayStr()}.csv`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('✅ CSV export ho gaya');
      }


      function toggleTip(el, e) {
        e.stopPropagation();
        document.querySelectorAll('.batch-tip.show-tip').forEach(t => { if (t !== el) t.classList.remove('show-tip') });
        el.classList.toggle('show-tip');
      }
      document.addEventListener('click', function () {
        document.querySelectorAll('.batch-tip.show-tip').forEach(t => t.classList.remove('show-tip'));
      });

      if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
          navigator.serviceWorker.register('./service-worker.js').catch(err => console.log('SW failed:', err));
        });
      }