const state = {
  data: null,
  view: 'dashboard',
  dashboardMonth: null,
  selectedDUs: new Set(),
  comparisonRates: [],
  comparisonBusy: false,
  coverageByMonth: {},
  regionId: sessionStorage.getItem('gridwatch-region') || null,
  adminToken: sessionStorage.getItem('gridwatch-admin-token') || ''
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function currentMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}`;
}

function monthLabel(month) {
  if (!month) return 'No month available';
  const [year, number] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, number - 1, 1)));
}

function monthList(start, end) {
  if (!start || !end || start > end) return [];
  let [year, month] = start.split('-').map(Number);
  const [endYear, endMonth] = end.split('-').map(Number);
  const list = [];
  while (year < endYear || (year === endYear && month <= endMonth)) {
    list.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    if (list.length > 72) break;
  }
  return list;
}

function recentMonths(count = 30) {
  const output = [];
  const [year0, month0] = (state.data?.current_month || currentMonth()).split('-').map(Number);
  for (let i = 0; i < count; i += 1) {
    const date = new Date(Date.UTC(year0, month0 - 1 - i, 1));
    output.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return output;
}

function money(value, digits = 4) {
  if (value == null || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: digits }).format(number);
}

function publishedAmount(rate) {
  return esc(rate?.published_total_original || money(rate?.published_total));
}

function componentAmount(component) {
  return esc(component?.original_value || money(component?.value));
}

function formatDate(value, includeTime = false) {
  if (!value) return 'Never checked';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const options = includeTime
    ? { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' }
    : { dateStyle: 'medium', timeZone: 'Asia/Manila' };
  return new Intl.DateTimeFormat('en-PH', options).format(date);
}

function latestDate(rates) {
  const latest = rates.map((rate) => rate.retrieved_at).filter(Boolean).sort().at(-1);
  return latest ? formatDate(latest) : 'No reviewed rates yet';
}

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) };
  if (options.admin) {
    if (!state.adminToken) throw new Error('Enter the administrator token first.');
    headers['x-admin-token'] = state.adminToken;
  }
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

async function reloadData() {
  state.data = await api('/api/bootstrap');
  state.coverageByMonth = { [state.data.current_month]: state.data.coverage };
  if (state.dashboardMonth && state.dashboardMonth !== state.data.current_month) await loadCoverage(state.dashboardMonth);
}

async function loadData() {
  try {
    await reloadData();
    state.dashboardMonth = state.dashboardMonth || state.data.latest_available_month || state.data.current_month;
    state.coverageByMonth[state.data.current_month] = state.data.coverage;
    if (!state.regionId || !state.data.regions.some((region) => region.id === state.regionId)) {
      state.regionId = state.data.regions.find((region) => region.region_code === 'Region III')?.id || state.data.regions[0]?.id;
    }
    if (!state.selectedDUs.size) defaultComparisonDUIds().forEach((duId) => state.selectedDUs.add(duId));
    initializeControls();
    renderAll();
  } catch (error) {
    $('#appContent').innerHTML = `<div class="fatal-state"><span>!</span><h1>Gridwatch could not load.</h1><p>${esc(error.message)}</p><button class="button button-primary" id="retryLoad">Try again</button></div>`;
    $('#retryLoad')?.addEventListener('click', loadData);
  }
}

function initializeControls() {
  $('#regionSelect').innerHTML = state.data.regions.map((region) => `<option value="${esc(region.id)}">${esc(region.region_code)} · ${esc(region.name)}</option>`).join('');
  $('#regionSelect').value = state.regionId;
  updateRegionLabels();
  const monthChoices = [...new Set([...recentMonths(30), ...(state.data.months || []), state.data.latest_available_month].filter(Boolean))].sort().reverse();
  const options = monthChoices.map((month) => `<option value="${esc(month)}">${esc(monthLabel(month))}</option>`).join('');
  $('#globalMonth').innerHTML = options;
  $('#globalMonth').value = state.dashboardMonth;
  $('#breakdownMonth').innerHTML = options;
  $('#breakdownMonth').value = state.dashboardMonth;
  $('#headingMonth').textContent = monthLabel(state.dashboardMonth);
  $('#sourceMonthLabel').textContent = monthLabel(state.dashboardMonth);
  $('#manualRateMonth').value = state.data.current_month;
  const availableMonths = availableMonthsForRegion();
  $('#comparisonFrom').value = availableMonths[0] || recentMonths(12).at(-1);
  $('#comparisonTo').value = availableMonths.at(-1) || state.data.current_month;

  const classOptions = state.data.customer_classes.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
  $('#comparisonClass').innerHTML = classOptions;
  $('#manualRateClass').innerHTML = classOptions;
  $('#comparisonClass').value = 'residential';
  $('#manualRateClass').value = 'residential';

  const duOptions = state.data.utilities.map((du) => `<option value="${esc(du.id)}">${esc(du.acronym)} · ${esc(du.full_name)}</option>`).join('');
  $('#editDuSelect').innerHTML = duOptions;
  $('#manualRateDu').innerHTML = duOptions;
  $('#newDuRegion').innerHTML = state.data.regions.map((region) => `<option value="${esc(region.id)}">${esc(region.region_code)} · ${esc(region.name)}</option>`).join('');
  renderComparisonPicker();
  renderAdminFields();
  fillManualRateForm();
}

function regionUtilities() {
  return (state.data?.utilities || []).filter((du) => du.region_id === state.regionId && du.active);
}

function availableMonthsForRegion() {
  const ids = new Set(regionUtilities().map((du) => du.id));
  return [...new Set((state.data?.rates || [])
    .filter((rate) => ids.has(rate.du_id) && rate.customer_class_id === 'residential')
    .map((rate) => rate.effective_month))].sort();
}

function defaultComparisonDUIds() {
  const utilities = regionUtilities();
  const latestMonth = availableMonthsForRegion().at(-1);
  const withLatestRate = utilities.filter((du) => state.data.rates.some((rate) =>
    rate.du_id === du.id && rate.effective_month === latestMonth && rate.customer_class_id === 'residential'));
  const withAnyRate = utilities.filter((du) => state.data.rates.some((rate) =>
    rate.du_id === du.id && rate.customer_class_id === 'residential'));
  return (withLatestRate.length ? withLatestRate : withAnyRate).slice(0, 5).map((du) => du.id);
}

function selectedRegion() {
  return state.data?.regions.find((region) => region.id === state.regionId) || state.data?.regions[0];
}

function updateRegionLabels() {
  const region = selectedRegion();
  if (!region) return;
  $('#regionCode').textContent = region.region_code.replace('Region ', 'R');
  $('#breadcrumbRegion').textContent = region.region_code;
  $('#dashboardRegionName').textContent = `${region.region_code} / ${region.name}`;
  $('#regionCoverageTitle').textContent = `${region.name} coverage`;
  document.title = `Gridwatch — ${region.name} electricity rates`;
}

function latestAvailableForRegion() {
  const ids = new Set(regionUtilities().map((du) => du.id));
  return state.data.rates.filter((rate) => ids.has(rate.du_id) && rate.customer_class_id === 'residential').map((rate) => rate.effective_month).sort().at(-1) || null;
}

function coverageForMonth(month) {
  if (state.coverageByMonth[month]) return state.coverageByMonth[month];
  return deriveCoverageForMonth(month);
}

async function loadCoverage(month) {
  if (state.coverageByMonth[month]) return;
  try {
    const result = await api(`/api/coverage?month=${encodeURIComponent(month)}`);
    state.coverageByMonth[month] = result.coverage;
  } catch { state.coverageByMonth[month] = deriveCoverageForMonth(month); }
}

function renderAll() {
  if (!state.data) return;
  $('#globalMonth').value = state.dashboardMonth;
  $('#breakdownMonth').value = state.dashboardMonth;
  $('#headingMonth').textContent = monthLabel(state.dashboardMonth);
  $('#sourceMonthLabel').textContent = monthLabel(state.dashboardMonth);
  updateRegionLabels();
  renderDashboard();
  renderBreakdown();
  renderSources();
  updateNav();
}

function selectedMonthRates(month) {
  return state.data.rates.filter((rate) => rate.effective_month === month && rate.customer_class_id === 'residential');
}

function statusLabel(status) {
  return ({ current: 'Current', needs_review: 'Needs review', pending: 'Pending', unavailable: 'Unavailable' })[status] || status;
}

function statusBadge(status) {
  return `<span class="status-label status-${esc(status)}"><i class="status-dot ${esc(status)}"></i>${esc(statusLabel(status))}</span>`;
}

function sourceCheckStatus(source) {
  const value = source.last_check_status;
  if (!value) return '<span class="muted-copy">Not checked</span>';
  const labels = { checked: 'Match found', not_found: 'No month match', fetch_failed: 'Fetch failed', parse_failed: 'Parse failed' };
  const kind = value === 'checked' ? 'needs_review' : value === 'not_found' ? 'pending' : 'unavailable';
  return `<span class="status-label status-${kind}"><i class="status-dot ${kind}"></i>${labels[value] || esc(value)}</span>`;
}

function sourceLink(url, label = 'View source') {
  if (!url) return '<span class="muted-copy">No link registered</span>';
  return `<a class="source-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} <span aria-hidden="true">↗</span></a>`;
}

function readableSourceType(type) {
  return ({
    official_website: 'Official website',
    official_social: 'Official social media',
    regulatory_reference: 'Regulatory reference',
    third_party_lead: 'Third-party lead',
    unknown: 'Unknown source'
  })[type] || String(type || 'unknown').replaceAll('_', ' ');
}

function sourceTypeBadge(type) {
  const label = readableSourceType(type);
  return `<span class="source-type source-type-${esc(type || 'unknown')}">${esc(label)}</span>`;
}

function rateCitation(rate, label = 'Source') {
  return `<span class="rate-citation">${sourceLink(rate?.resolved_source_url || rate?.source_url, label)}${sourceTypeBadge(rate?.source_type)}</span>`;
}

function renderDashboard() {
  const month = state.dashboardMonth;
  const monthCoverage = coverageForMonth(month).filter((item) => item.region_id === state.regionId);
  const regionIds = new Set(regionUtilities().map((du) => du.id));
  const rates = selectedMonthRates(month).filter((rate) => regionIds.has(rate.du_id));
  const totalUtilities = regionUtilities().length;
  const latestRegionMonth = latestAvailableForRegion();
  const counts = Object.fromEntries(['current', 'needs_review', 'pending', 'unavailable'].map((key) => [key, monthCoverage.filter((item) => item.status === key).length]));
  const coveragePercentage = totalUtilities ? Math.round((counts.current / totalUtilities) * 100) : 0;

  $('#dashboardStats').innerHTML = `
    <article class="stat-card stat-featured"><div class="stat-top"><span class="stat-symbol">⌂</span><span class="stat-label">Latest available</span><span class="stat-flag">Source-linked</span></div><strong class="stat-value">${esc(latestRegionMonth ? monthLabel(latestRegionMonth) : 'Awaiting first rate')}</strong><small>${latestRegionMonth ? `Published rates · last retrieved ${esc(latestDate(state.data.rates.filter((rate) => regionIds.has(rate.du_id))))}` : 'No rate values have been prefilled or estimated.'}</small></article>
    <article class="stat-card"><div class="stat-top"><span class="stat-symbol">▦</span><span class="stat-label">Utilities tracked</span></div><strong class="stat-value">${totalUtilities}<em> DUs</em></strong><small>${esc(selectedRegion()?.name || '')} · ${esc(selectedRegion()?.region_code || '')}</small></article>
    <article class="stat-card"><div class="stat-top"><span class="stat-symbol">◉</span><span class="stat-label">Rates for ${esc(month)}</span></div><strong class="stat-value">${counts.current}<em> / ${totalUtilities}</em></strong><small>${counts.needs_review} awaiting review · ${counts.pending + counts.unavailable} uncovered</small></article>
    <article class="stat-card"><div class="stat-top"><span class="stat-symbol">↻</span><span class="stat-label">Last retrieval</span></div><strong class="stat-value stat-date">${esc(latestDate(state.data.rates))}</strong><small>Based on available records</small></article>`;

  $('#coveragePercent').textContent = `${coveragePercentage}%`;
  $('#coverageBar').style.width = `${coveragePercentage}%`;
  $('#coverageLegend').innerHTML = [
    ['current', counts.current], ['needs_review', counts.needs_review], ['pending', counts.pending], ['unavailable', counts.unavailable]
  ].map(([status, count]) => `<div class="legend-row"><span class="legend-name"><i class="status-dot ${status}"></i>${statusLabel(status)}</span><b>${count}</b></div>`).join('');
  $('#dashboardChart').innerHTML = renderDashboardBars(rates);
  $('#leadersContent').innerHTML = renderLeaderCards(rates);
  $('#changesContent').innerHTML = renderChanges(state.data.rates.filter((rate) => regionIds.has(rate.du_id)), latestRegionMonth);
  renderCoverageTable(monthCoverage);
}

function deriveCoverageForMonth(month) {
  return state.data.utilities.filter((du) => du.active).map((du) => {
    const rate = state.data.rates.find((item) => item.du_id === du.id && item.effective_month === month && item.customer_class_id === 'residential');
    const isCurrent = month === state.data.current_month;
    const latest = state.data.coverage.find((item) => item.du_id === du.id);
    return { ...latest, status: rate ? 'current' : isCurrent ? latest?.status || 'pending' : 'pending', rate: rate?.published_total || null, rate_id: rate?.id || null };
  });
}

function renderDashboardBars(rates) {
  if (!rates.length) return `<div class="empty-chart"><div class="empty-icon">▥</div><h3>No sourced rate figures for ${esc(monthLabel(state.dashboardMonth))}</h3><p>Official announcements and clearly labeled third-party reports appear after their source and residential per kWh basis are checked. Coverage gaps stay blank.</p><button class="text-button" data-navigate="sources" type="button">Check source coverage <span>→</span></button></div>`;
  const sorted = rates.slice().sort((a, b) => Number(a.published_total) - Number(b.published_total));
  const max = Math.max(...sorted.map((rate) => Number(rate.published_total))) || 1;
  const width = 740;
  const rowHeight = 30;
  const labelWidth = 105;
  const valueWidth = 72;
  const barWidth = width - labelWidth - valueWidth - 16;
  const height = Math.max(145, sorted.length * rowHeight + 25);
  const bars = sorted.map((rate, index) => {
    const y = 15 + index * rowHeight;
    const widthValue = Math.max(3, Number(rate.published_total) / max * barWidth);
    const isHighest = index === sorted.length - 1;
    const xValue = Math.min(labelWidth + widthValue + 10, width - valueWidth + 4);
    return `<g class="bar-row"><title>${esc(rate.acronym)}: PHP ${publishedAmount(rate)} per kWh</title><text class="bar-label" x="0" y="${y + 13}">${esc(rate.acronym)}</text><rect class="bar-track" x="${labelWidth}" y="${y}" width="${barWidth}" height="16" rx="4"/><rect class="rate-bar ${isHighest ? 'bar-high' : ''}" x="${labelWidth}" y="${y}" width="${widthValue.toFixed(1)}" height="16" rx="4"/><text class="bar-value" x="${xValue}" y="${y + 13}">${publishedAmount(rate)}</text></g>`;
  }).join('');
  const axis = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const x = labelWidth + barWidth * ratio;
    return `<line class="chart-grid" x1="${x}" y1="6" x2="${x}" y2="${height - 8}"/><text class="axis-label" x="${x}" y="${height - 1}">${(max * ratio).toFixed(0)}</text>`;
  }).join('');
  return `<div class="chart-scroll"><svg class="rate-bars" role="img" aria-label="Residential published rate by utility for ${esc(monthLabel(state.dashboardMonth))}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMinYMin meet"><title>Residential published rate comparison in PHP per kWh</title>${axis}${bars}</svg></div>`;
}

function renderLeaderCards(rates) {
  if (!rates.length) return `<div class="empty-inline"><span>↗</span><p>Highest and lowest ranks will appear when comparable, reviewed rates are available.</p></div>`;
  const sorted = rates.slice().sort((a, b) => Number(a.published_total) - Number(b.published_total));
  const low = sorted[0];
  const high = sorted.at(-1);
  return `<div class="leader-cards"><div class="leader-item lowest"><span class="leader-kicker">Lowest reported</span><strong>${esc(low.acronym)}</strong><span class="leader-rate">₱${publishedAmount(low)}<small>/kWh</small></span><small class="rate-basis-note">Residential · published total</small><small class="rate-retrieved">Retrieved ${esc(formatDate(low.retrieved_at))}</small>${rateCitation(low)}</div><div class="leader-item highest"><span class="leader-kicker">Highest reported</span><strong>${esc(high.acronym)}</strong><span class="leader-rate">₱${publishedAmount(high)}<small>/kWh</small></span><small class="rate-basis-note">Residential · published total</small><small class="rate-retrieved">Retrieved ${esc(formatDate(high.retrieved_at))}</small>${rateCitation(high)}</div></div>`;
}

function renderChanges(allRates, month) {
  if (!month) return `<div class="empty-inline"><span>↔</span><p>Month-over-month changes will show once two adjacent reviewed months are available.</p></div>`;
  const [year, m] = month.split('-').map(Number);
  const priorDate = new Date(Date.UTC(year, m - 2, 1));
  const prior = `${priorDate.getUTCFullYear()}-${String(priorDate.getUTCMonth() + 1).padStart(2, '0')}`;
  const changes = allRates.filter((rate) => rate.effective_month === month && rate.customer_class_id === 'residential').map((rate) => {
    const old = allRates.find((item) => item.du_id === rate.du_id && item.effective_month === prior && item.customer_class_id === rate.customer_class_id);
    return old ? { rate, change: Number(rate.published_total) - Number(old.published_total) } : null;
  }).filter(Boolean).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  if (!changes.length) return `<div class="empty-inline"><span>↔</span><p>Comparable rates for adjacent months are not available yet.</p></div>`;
  return `<div class="change-list">${changes.slice(0, 5).map(({ rate, change }) => `<div class="change-item"><div><strong>${esc(rate.acronym)}</strong><small>${esc(prior)} → ${esc(month)}</small></div><span class="change-value ${change > 0 ? 'up' : change < 0 ? 'down' : ''}">${change > 0 ? '↑' : change < 0 ? '↓' : '·'} ₱${money(Math.abs(change))}</span></div>`).join('')}</div>`;
}

function renderCoverageTable(coverage) {
  const filter = ($('#duSearch')?.value || '').trim().toLowerCase();
  const list = coverage.filter((item) => `${item.acronym} ${item.full_name}`.toLowerCase().includes(filter));
  if (!list.length) { $('#duCoverageTable').innerHTML = '<div class="empty-table">No matching utilities.</div>'; return; }
  $('#duCoverageTable').innerHTML = `<div class="scroll-table"><table><thead><tr><th>Utility</th><th>Type</th><th>Month status</th><th>Residential published total</th><th>Class and basis</th><th>Last retrieved or checked</th><th></th></tr></thead><tbody>${list.map((du) => {
    const rate = state.data.rates.find((item) => item.du_id === du.du_id && item.effective_month === state.dashboardMonth && item.customer_class_id === 'residential');
    return `<tr><td><div class="du-name-cell"><span class="du-monogram">${esc(du.acronym.slice(0, 2))}</span><span><strong>${esc(du.acronym)}</strong><small>${esc(du.full_name)}</small></span></div></td><td><span class="type-label">${esc(du.du_type)}</span></td><td>${statusBadge(du.status)}</td><td class="rate-cell">${rate ? `₱${publishedAmount(rate)} <small>/kWh</small>` : '<span class="muted-copy">—</span>'}</td><td class="basis-cell">${rate ? `Residential · ${esc(rate.basis || 'Published rate per kWh')}` : '—'}</td><td class="date-cell">${esc(formatDate(rate?.retrieved_at || du.last_checked_at))}</td><td>${rate ? rateCitation(rate) : ''}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function renderComparisonPicker() {
  const utilities = regionUtilities();
  $('#comparisonDuList').innerHTML = `<div class="picker-tools"><button data-picker="all" type="button">Select all</button><button data-picker="none" type="button">Clear</button></div>${utilities.map((du) => `<label class="picker-option"><input type="checkbox" value="${esc(du.id)}" ${state.selectedDUs.has(du.id) ? 'checked' : ''}/><span class="picker-check"></span><span>${esc(du.acronym)}<small>${esc(du.full_name)}</small></span></label>`).join('')}`;
  updatePickerSummary();
}

function updatePickerSummary() {
  const count = $$('#comparisonDuList input:checked').length;
  $('#duPickerSummary').textContent = count === regionUtilities().length ? `All ${count} utilities` : `${count} selected`;
}

function updateNav() {
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${state.view}`));
  const names = { dashboard: 'Overview', comparison: 'Monthly comparison', breakdown: 'Rate breakdown', sources: 'Sources and coverage' };
  $('#breadcrumbView').textContent = names[state.view] || 'Overview';
}

function navigate(view) {
  if (!['dashboard', 'comparison', 'breakdown', 'sources'].includes(view)) return;
  state.view = view;
  updateNav();
  if (view === 'comparison') updateComparison();
  if (view === 'breakdown') renderBreakdown();
  if (view === 'sources') renderSources();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function updateComparison() {
  if (state.comparisonBusy) return;
  const checked = $$('#comparisonDuList input:checked');
  state.selectedDUs = new Set(checked.map((input) => input.value));
  const from = $('#comparisonFrom').value;
  const to = $('#comparisonTo').value;
  if (!from || !to || from > to) { toast('Choose a valid month range.', 'error'); return; }
  if (!state.selectedDUs.size) {
    $('#comparisonChart').innerHTML = '<div class="empty-chart bar-empty"><div class="empty-icon">▥</div><h3>Select at least one utility</h3><p>Use the utility picker to choose a series for this comparison.</p></div>';
    $('#comparisonTable').innerHTML = '';
    return;
  }
  const classId = $('#comparisonClass').value;
  state.comparisonBusy = true;
  $('#comparisonChart').innerHTML = '<div class="loading-state"><span class="spinner"></span>Loading published rates…</div>';
  try {
    const query = new URLSearchParams({ from, to, customer_class_id: classId });
    if (state.selectedDUs.size) query.set('dus', [...state.selectedDUs].join(','));
    const result = await api(`/api/rates?${query}`);
    state.comparisonRates = result.rates;
    renderComparisonResults(from, to, classId, result.rates);
  } catch (error) {
    $('#comparisonChart').innerHTML = `<div class="empty-table">${esc(error.message)}</div>`;
  } finally {
    state.comparisonBusy = false;
  }
}

function renderComparisonResults(from, to, classId, rates) {
  const months = monthList(from, to);
  $('#comparisonChart').innerHTML = renderBarChart(months, rates);
  const chosen = [...state.selectedDUs].map((id) => state.data.utilities.find((du) => du.id === id)).filter(Boolean);
  const className = state.data.customer_classes.find((item) => item.id === classId)?.name || 'Customer class';
  if (!rates.length) {
    $('#comparisonTable').innerHTML = `<div class="empty-table">No ${esc(className.toLowerCase())} rates were found for this month range. Missing months remain blank.</div>`;
    return;
  }
  const lookup = new Map(rates.map((rate) => [`${rate.du_id}:${rate.effective_month}`, rate]));
  const rows = [...months].reverse().map((month) => chosen.map((du) => {
    const rate = lookup.get(`${du.id}:${month}`);
    return `<tr><td>${esc(monthLabel(month))}</td><td><strong>${esc(du.acronym)}</strong></td><td>${esc(className)}</td><td>${esc(rate?.basis || 'Published rate per kWh')}</td><td class="rate-cell">${rate ? `₱${publishedAmount(rate)} <small>/kWh</small>` : '<span class="not-reported">Not reported</span>'}</td><td>${rate ? rateCitation(rate) : '<span class="muted-copy">—</span>'}</td><td class="date-cell">${rate ? esc(formatDate(rate.retrieved_at)) : '—'}</td></tr>`;
  }).join('')).join('');
  $('#comparisonTable').innerHTML = `<div class="scroll-table"><table><thead><tr><th>Month</th><th>Utility</th><th>Customer class</th><th>Published basis</th><th>Published total</th><th>Source</th><th>Retrieved</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderBarChart(months, rates) {
  if (!rates.length) return `<div class="empty-chart bar-empty"><div class="empty-icon">▥</div><h3>No published rates in this range</h3><p>Choose a wider date range or select utilities with available rates.</p></div>`;
  const series = [...state.selectedDUs].map((duId) => ({
    du: state.data.utilities.find((item) => item.id === duId),
    rates: new Map(rates.filter((rate) => rate.du_id === duId).map((rate) => [rate.effective_month, rate]))
  })).filter((item) => item.du);
  const values = rates.map((item) => Number(item.published_total));
  const max = Math.max(2, Math.ceil(Math.max(...values) / 2) * 2);
  const groupWidth = Math.max(78, series.length * 16 + 18);
  const width = Math.max(640, months.length * groupWidth + 62);
  const height = 300;
  const pad = { top: 20, right: 12, bottom: 48, left: 48 };
  const innerHeight = height - pad.top - pad.bottom;
  const colors = ['#ef8b44', '#257d78', '#839241', '#47698b', '#cb6346', '#576b50', '#bd9a44', '#6e779d', '#a85c45', '#5c9c9a', '#c37292', '#987d43', '#4377a5', '#b37242', '#647b4a', '#806a9c', '#408d80', '#bf665f', '#6886a3', '#9c8738', '#be7597'];
  const yAt = (value) => pad.top + innerHeight - (value / max) * innerHeight;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = max * index / 4;
    const y = yAt(value);
    return `<line class="history-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y}" y2="${y}"/><text class="history-axis" x="${pad.left - 8}" y="${y + 4}" text-anchor="end">${value.toFixed(0)}</text>`;
  }).join('');
  const barGap = series.length > 10 ? 1 : 2;
  const barWidth = Math.max(2, Math.min(14, (groupWidth - 22 - barGap * Math.max(0, series.length - 1)) / series.length));
  const bars = months.map((month, monthIndex) => {
    const groupStart = pad.left + monthIndex * groupWidth;
    const groupContentsWidth = series.length * barWidth + Math.max(0, series.length - 1) * barGap;
    const groupOffset = (groupWidth - groupContentsWidth) / 2;
    const monthBars = series.map((item, seriesIndex) => {
      const rate = item.rates.get(month);
      if (!rate) return '';
      const value = Number(rate.published_total);
      const y = yAt(value);
      const x = groupStart + groupOffset + seriesIndex * (barWidth + barGap);
      const basis = rate.basis || 'Published residential rate per kWh';
      return `<rect class="history-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${(pad.top + innerHeight - y).toFixed(1)}" rx="2" fill="${colors[seriesIndex % colors.length]}"><title>${esc(item.du.acronym)} · ${esc(monthLabel(month))}: ₱${publishedAmount(rate)}/kWh · ${esc(basis)}</title></rect>`;
    }).join('');
    return `<g>${monthBars}<text class="history-month" x="${groupStart + groupWidth / 2}" y="${height - 14}" text-anchor="middle"><title>${esc(monthLabel(month))}</title>${esc(month.slice(2))}</text></g>`;
  }).join('');
  const legend = series.map((item, index) => `<span class="series-legend"><i style="--series:${colors[index % colors.length]}"></i>${esc(item.du.acronym)}</span>`).join('');
  return `<div class="bar-chart-scroll" tabindex="0" aria-label="Scrollable monthly rate bar chart"><svg class="history-bars" role="img" aria-label="Grouped monthly bars for selected utilities. Published residential totals in Philippine pesos per kilowatt-hour. Missing rates are blank; the equivalent rate table follows." viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMinYMin meet"><title>Published residential rates by month and utility</title>${grid}${bars}</svg></div><div class="series-legend-list">${legend}</div>`;
}

function renderBreakdown() {
  if (!state.data) return;
  const month = $('#breakdownMonth').value || state.dashboardMonth;
  const regionIds = new Set(regionUtilities().map((du) => du.id));
  const rates = state.data.rates.filter((rate) => rate.effective_month === month && rate.customer_class_id === 'residential' && regionIds.has(rate.du_id));
  const primary = ['generation', 'transmission', 'distribution', 'system_loss'];
  const labels = { generation: 'Generation', transmission: 'Transmission', distribution: 'Distribution', system_loss: 'System loss' };
  const rows = regionUtilities().map((du) => {
    const rate = rates.find((item) => item.du_id === du.id);
    const components = rate?.components || [];
    const valueCell = (category) => {
      const found = components.filter((item) => item.normalized_category === category);
      if (!found.length) return '<span class="not-reported" title="This source did not provide this component">Not provided</span>';
      return found.map((item) => `<span class="component-value" title="Original label and value: ${esc(item.original_label)} ${componentAmount(item)}">${item.value_state === 'zero' ? `₱${componentAmount(item)}` : item.value_state === 'not_published' ? 'Not published' : item.value_state === 'missing' ? 'Missing' : `₱${componentAmount(item)}`}</span>`).join('<br>');
    };
    const otherComponents = components.filter((item) => !primary.includes(item.normalized_category));
    const other = otherComponents.length ? otherComponents.map((item) => `<span class="other-component"><small>${esc(item.original_label)}</small>${item.value_state === 'zero' ? `₱${componentAmount(item)}` : item.value_state === 'not_published' ? 'Not published' : item.value_state === 'missing' ? 'Missing' : `₱${componentAmount(item)}`}</span>`).join('') : '<span class="not-reported">Not provided</span>';
    return `<tr><td><div class="du-name-cell"><span class="du-monogram">${esc(du.acronym.slice(0, 2))}</span><span><strong>${esc(du.acronym)}</strong><small>${esc(du.full_name)}</small></span></div></td>${primary.map((category) => `<td>${valueCell(category)}</td>`).join('')}<td><div class="other-components">${other}</div></td><td class="basis-cell">${rate ? `${esc(rate.customer_class)} · ${esc(rate.basis)}` : '—'}</td><td class="rate-cell">${rate ? `₱${publishedAmount(rate)} <small>/kWh</small>` : '<span class="not-reported">No reviewed total</span>'}</td><td>${rate ? rateCitation(rate) : '<span class="muted-copy">—</span>'}</td></tr>`;
  }).join('');
  $('#breakdownContent').innerHTML = `<div class="scroll-table"><table class="breakdown-table"><thead><tr><th>Utility</th><th>Generation</th><th>Transmission</th><th>Distribution</th><th>System loss</th><th>Other published charges</th><th>Class and basis</th><th>Published total</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const available = primary.map((category) => {
    const items = rates.flatMap((rate) => rate.components.filter((part) => part.normalized_category === category && ['value', 'zero'].includes(part.value_state)).map((part) => Number(part.value)));
    const avg = items.length ? items.reduce((sum, value) => sum + value, 0) / items.length : null;
    return `<article class="category-card"><span>${labels[category]}</span><strong>${avg == null ? '—' : `₱${money(avg)}`}</strong><small>${items.length} of ${regionUtilities().length} published components</small></article>`;
  }).join('');
  $('#categoryCards').innerHTML = available;
}

function renderSources() {
  if (!state.data) return;
  const coverage = coverageForMonth(state.dashboardMonth).filter((item) => item.region_id === state.regionId);
  $('#sourceCoverageTable').innerHTML = `<div class="scroll-table"><table><thead><tr><th>Utility</th><th>Month status</th><th>Residential published rate</th><th>Registered sources</th><th>Last retrieval</th></tr></thead><tbody>${coverage.map((du) => {
    const rate = state.data.rates.find((item) => item.du_id === du.du_id && item.effective_month === state.dashboardMonth && item.customer_class_id === 'residential');
    const count = state.data.sources.filter((source) => source.du_id === du.du_id && source.enabled).length;
    return `<tr><td><div class="du-name-cell"><span class="du-monogram">${esc(du.acronym.slice(0, 2))}</span><span><strong>${esc(du.acronym)}</strong><small>${esc(du.full_name)}</small></span></div></td><td>${statusBadge(du.status)}</td><td class="rate-cell">${rate ? `₱${publishedAmount(rate)} <small>/kWh</small><br>${rateCitation(rate)}` : '<span class="muted-copy">No reviewed rate</span>'}</td><td>${count} sources</td><td class="date-cell">${esc(formatDate(rate?.retrieved_at || du.last_checked_at, true))}</td></tr>`;
  }).join('')}</tbody></table></div>`;

  const regionIds = new Set(regionUtilities().map((du) => du.id));
  $('#sourceRegistryTable').innerHTML = `<div class="scroll-table"><table><thead><tr><th>Utility or source</th><th>Type</th><th>Link</th><th>Last retrieval</th><th>Check status</th></tr></thead><tbody>${state.data.sources.filter((source) => !source.du_id || regionIds.has(source.du_id)).map((source) => `<tr><td><div class="source-name-cell"><strong>${esc(source.acronym || 'Gridwatch reference')}</strong><small>${esc(source.label)}</small></div></td><td><span class="source-type source-type-${esc(source.source_type)}">${esc(readableSourceType(source.source_type))}</span></td><td>${sourceLink(source.url, 'Open link')}</td><td class="date-cell">${esc(formatDate(source.last_checked_at, true))}</td><td>${sourceCheckStatus(source)}<small class="source-message">${esc(source.last_check_message || source.notes || '')}</small></td></tr>`).join('')}</tbody></table></div>`;
}

function renderAdminFields() {
  if (!state.data) return;
  $('#adminToken').value = state.adminToken;
  fillUtilityEditor();
}

function fillUtilityEditor() {
  const du = state.data.utilities.find((item) => item.id === $('#editDuSelect').value) || state.data.utilities[0];
  if (!du) return;
  $('#editDuSelect').value = du.id;
  $('#editDuName').value = du.full_name;
  $('#editDuAcronym').value = du.acronym;
  if (![...$('#editDuType').options].some((option) => option.value === du.du_type)) {
    $('#editDuType').add(new Option(du.du_type, du.du_type));
  }
  $('#editDuType').value = du.du_type;
  if (!$('#editDuType').value) $('#editDuType').value = 'Other distribution utility';
  $('#editDuNotes').value = du.service_area_notes || '';
  $('#editDuIdentityUrl').value = du.identity_source_url || '';
  $('#editDuActive').checked = Boolean(du.active);
  const sources = state.data.sources.filter((source) => source.du_id === du.id);
  $('#editSourceSelect').innerHTML = `<option value="">Add source…</option>${sources.map((source) => `<option value="${esc(source.id)}">${esc(source.label)}</option>`).join('')}`;
  const source = sources.find((item) => item.source_type.startsWith('official')) || sources[0];
  $('#editSourceSelect').value = source?.id || '';
  $('#editSourceUrl').value = source?.url || '';
  $('#editSourceType').value = source?.source_type || 'official_website';
  $('#editSourceIngest').checked = Boolean(source?.ingest_enabled);
}

function fillSourceEditor() {
  const source = state.data.sources.find((item) => item.id === $('#editSourceSelect').value);
  $('#editSourceUrl').value = source?.url || '';
  $('#editSourceType').value = source?.source_type || 'official_website';
  $('#editSourceIngest').checked = Boolean(source?.ingest_enabled);
}

function fillManualRateForm() {
  if (!state.data) return;
  const form = $('#manualRateForm');
  const existing = state.data.rates.find((rate) => rate.du_id === $('#manualRateDu').value
    && rate.effective_month === $('#manualRateMonth').value
    && rate.customer_class_id === $('#manualRateClass').value);
  form.elements.published_total.value = existing?.published_total ?? '';
  form.elements.source_url.value = existing?.source_url || existing?.resolved_source_url || '';
  form.elements.source_type.value = existing?.source_type || 'official_website';
  form.elements.publication_date.value = existing?.publication_date || '';
  form.elements.components.value = existing?.components.length
    ? JSON.stringify(existing.components.map((item) => ({
      normalized_category: item.normalized_category, original_label: item.original_label,
      original_value: item.original_value, value: item.value, value_state: item.value_state,
      currency: item.currency, unit: item.unit, sort_order: item.sort_order
    })), null, 2)
    : '';
}

function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  $('#toastRegion').append(el);
  setTimeout(() => el.remove(), 4200);
}

function adminMessage(message, error = false) {
  $('#adminMessage').textContent = message;
  $('#adminMessage').classList.toggle('error-text', error);
}

async function refreshSources() {
  const button = $('#refreshButton');
  button.disabled = true;
  button.innerHTML = '<span class="spinner spinner-small"></span> Checking sources…';
  try {
    const result = await api('/api/admin/refresh', { method: 'POST', body: JSON.stringify({ month: state.dashboardMonth }), admin: true });
    toast(`Checked ${result.checked} sources · ${result.candidates} candidate${result.candidates === 1 ? '' : 's'} staged.`);
    await reloadData();
    renderAll();
    await loadCandidates();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = '<span class="refresh-symbol">↻</span> Refresh registered sources';
  }
}

async function unlockAdmin() {
  state.adminToken = $('#adminToken').value.trim();
  sessionStorage.setItem('gridwatch-admin-token', state.adminToken);
  try {
    await api('/api/admin/candidates', { admin: true });
    adminMessage('Tools unlocked for this tab.');
    toast('Administrator tools unlocked.');
  } catch (error) {
    adminMessage(error.message, true);
    toast(error.message, 'error');
  }
}

async function loadCandidates() {
  try {
    const result = await api('/api/admin/candidates', { admin: true });
    if (!result.candidates.length) {
      $('#candidateQueue').innerHTML = '<div class="empty-queue"><span>✓</span><p>No rate candidates are waiting for review.</p></div>';
      return;
    }
    $('#candidateQueue').innerHTML = result.candidates.map((candidate) => `<article class="candidate-card"><div class="candidate-head"><div><span class="candidate-status">Needs review</span><h3>${esc(candidate.acronym)} <small>· ${esc(monthLabel(candidate.effective_month))}</small></h3></div><strong>₱${publishedAmount(candidate)}<small>/kWh</small></strong></div><p class="candidate-warning">Candidate only — not included in public comparisons.</p><blockquote>${esc(candidate.raw_excerpt)}</blockquote><div class="candidate-meta">${sourceLink(candidate.source_url, 'Open announcement')}${sourceTypeBadge(candidate.source_type)}<span>Retrieved ${esc(formatDate(candidate.retrieved_at, true))}</span><span>Confidence ${Math.round(Number(candidate.confidence) * 100)}%</span></div><div class="candidate-components">${(candidate.parsed.components || []).map((item) => `<span>${esc(item.original_label)}: ₱${componentAmount(item)}</span>`).join('') || '<span>No components extracted</span>'}</div><div class="candidate-actions"><button class="button button-primary" data-candidate-approve="${esc(candidate.id)}" type="button">Approve reviewed rate</button><button class="button button-quiet" data-candidate-reject="${esc(candidate.id)}" type="button">Dismiss candidate</button></div></article>`).join('');
  } catch (error) {
    $('#candidateQueue').innerHTML = `<p class="error-text">${esc(error.message)}</p>`;
  }
}

async function saveUtilityAndSource() {
  const du = state.data.utilities.find((item) => item.id === $('#editDuSelect').value);
  if (!du) return;
  const body = {
    full_name: $('#editDuName').value.trim(), acronym: $('#editDuAcronym').value.trim(),
    du_type: $('#editDuType').value, service_area_notes: $('#editDuNotes').value.trim(),
    identity_source_url: $('#editDuIdentityUrl').value.trim(), active: $('#editDuActive').checked
  };
  try {
    await api(`/api/admin/dus/${encodeURIComponent(du.id)}`, { method: 'PUT', body: JSON.stringify(body), admin: true });
    const sourceId = $('#editSourceSelect').value;
    const sourceUrl = $('#editSourceUrl').value.trim();
    if (sourceId) {
      const source = state.data.sources.find((item) => item.id === sourceId);
      await api(`/api/admin/sources/${encodeURIComponent(sourceId)}`, {
        method: 'PUT', admin: true,
        body: JSON.stringify({ label: source?.label || `${body.acronym} official source`, source_type: $('#editSourceType').value, url: sourceUrl, notes: source?.notes || '', enabled: true, ingest_enabled: $('#editSourceIngest').checked })
      });
    } else if (sourceUrl) {
      await api('/api/admin/sources', { method: 'POST', admin: true, body: JSON.stringify({ du_id: du.id, label: `${body.acronym} official source`, source_type: $('#editSourceType').value, url: sourceUrl, enabled: true, ingest_enabled: $('#editSourceIngest').checked }) });
    }
    await reloadData();
    initializeControls();
    renderAll();
    toast('Utility profile and source saved.');
  } catch (error) { toast(error.message, 'error'); }
}

async function addRegion(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api('/api/admin/regions', { method: 'POST', admin: true, body: JSON.stringify(Object.fromEntries(form)) });
    await reloadData();
    initializeControls();
    renderAll();
    event.currentTarget.reset();
    toast('Region added to the roster.');
  } catch (error) { toast(error.message, 'error'); }
}

async function addUtility(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api('/api/admin/dus', { method: 'POST', admin: true, body: JSON.stringify(Object.fromEntries(form)) });
    await reloadData();
    initializeControls();
    renderAll();
    event.currentTarget.reset();
    toast('Utility added to the roster.');
  } catch (error) { toast(error.message, 'error'); }
}

async function saveManualRate(event) {
  event.preventDefault();
  const formData = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const componentsText = formData.components.trim();
    const components = componentsText ? JSON.parse(componentsText) : [];
    const payload = { ...formData, published_total: formData.published_total || null, components, publication_date: formData.publication_date || null, review_status: 'approved' };
    delete payload.components_text;
    await api('/api/admin/rates', { method: 'POST', admin: true, body: JSON.stringify(payload) });
    await reloadData();
    renderAll();
    toast('Reviewed rate saved to the history.');
  } catch (error) { toast(error instanceof SyntaxError ? 'Components JSON is invalid.' : error.message, 'error'); }
}

async function reviewCandidate(id, action) {
  try {
    await api(`/api/admin/candidates/${encodeURIComponent(id)}/${action}`, { method: 'POST', admin: true, body: '{}' });
    await reloadData();
    renderAll();
    await loadCandidates();
    toast(action === 'approve' ? 'Rate approved and published.' : 'Candidate dismissed.');
  } catch (error) { toast(error.message, 'error'); }
}

async function loadAudit() {
  try {
    const { events } = await api('/api/admin/audit', { admin: true });
    $('#auditHistory').innerHTML = events.length ? `<div class="audit-list">${events.slice(0, 16).map((event) => {
      const before = event.before || {};
      const after = event.after || {};
      const record = after.published_total !== undefined ? after : before;
      const du = state.data.utilities.find((item) => item.id === record.du_id);
      const detail = record.published_total !== undefined
        ? `${du?.acronym || record.du_id} · ${record.effective_month || ''} · PHP ${before.published_total ?? '—'} → PHP ${after.published_total ?? '—'} per kWh`
        : after.full_name !== undefined ? `${after.acronym || ''} · ${after.full_name}`
          : after.url !== undefined ? (after.url || 'Source URL cleared')
            : event.entity_id;
      return `<div><span class="audit-action">${esc(event.action)}</span><span>${esc(event.entity_type)} · ${esc(detail)}</span><small>${esc(formatDate(event.changed_at, true))} · ${esc(event.changed_by)}</small></div>`;
    }).join('')}</div>` : '<p class="muted-copy">No changes recorded yet.</p>';
  } catch (error) { toast(error.message, 'error'); }
}

function attachEvents() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view)));
  $$('[data-navigate]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.navigate)));
  $('#regionSelect').addEventListener('change', () => {
    state.regionId = $('#regionSelect').value;
    sessionStorage.setItem('gridwatch-region', state.regionId);
    state.selectedDUs = new Set(defaultComparisonDUIds());
    renderComparisonPicker();
    const availableMonths = availableMonthsForRegion();
    $('#comparisonFrom').value = availableMonths[0] || recentMonths(12).at(-1);
    $('#comparisonTo').value = availableMonths.at(-1) || state.data.current_month;
    renderAll();
  });
  $('#globalMonth').addEventListener('change', async () => {
    state.dashboardMonth = $('#globalMonth').value;
    await loadCoverage(state.dashboardMonth);
    renderAll();
  });
  $('#breakdownMonth').addEventListener('change', async () => {
    state.dashboardMonth = $('#breakdownMonth').value;
    $('#globalMonth').value = state.dashboardMonth;
    await loadCoverage(state.dashboardMonth);
    renderAll();
  });
  $('#duSearch').addEventListener('input', () => renderCoverageTable(state.dashboardMonth === state.data.current_month ? state.data.coverage : deriveCoverageForMonth(state.dashboardMonth)));
  $('#refreshIcon').addEventListener('click', loadData);
  $('#refreshButton').addEventListener('click', refreshSources);
  $('#applyComparison').addEventListener('click', updateComparison);
  $('#comparisonDuList').addEventListener('change', updatePickerSummary);
  $('#comparisonDuList').addEventListener('click', (event) => {
    const action = event.target.closest('[data-picker]')?.dataset.picker;
    if (!action) return;
    $$('#comparisonDuList input[type="checkbox"]').forEach((input) => { input.checked = action === 'all'; });
    updatePickerSummary();
  });
  $('#saveAdminToken').addEventListener('click', unlockAdmin);
  $('#adminToken').addEventListener('keydown', (event) => { if (event.key === 'Enter') unlockAdmin(); });
  $('#loadCandidates').addEventListener('click', loadCandidates);
  $('#editDuSelect').addEventListener('change', fillUtilityEditor);
  $('#editSourceSelect').addEventListener('change', fillSourceEditor);
  $('#manualRateDu').addEventListener('change', fillManualRateForm);
  $('#manualRateMonth').addEventListener('change', fillManualRateForm);
  $('#manualRateClass').addEventListener('change', fillManualRateForm);
  $('#saveDuProfile').addEventListener('click', saveUtilityAndSource);
  $('#addRegionForm').addEventListener('submit', addRegion);
  $('#addDuForm').addEventListener('submit', addUtility);
  $('#manualRateForm').addEventListener('submit', saveManualRate);
  $('#loadAudit').addEventListener('click', loadAudit);
  $('#candidateQueue').addEventListener('click', (event) => {
    const approve = event.target.closest('[data-candidate-approve]')?.dataset.candidateApprove;
    const reject = event.target.closest('[data-candidate-reject]')?.dataset.candidateReject;
    if (approve) reviewCandidate(approve, 'approve');
    if (reject) reviewCandidate(reject, 'reject');
  });
}

attachEvents();
loadData();
