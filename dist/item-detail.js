import { calculateProfitability } from './profit.js?v=1';
import { buildItemHistory } from './chart-data.js?v=1';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = value => value === null || value === undefined ? '—' : new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 }).format(value);
const compact = value => new Intl.NumberFormat('pl-PL', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const day = value => new Intl.DateTimeFormat('pl-PL', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
const dated = value => new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Warsaw' }).format(new Date(value));
const STORE = 'rose-market-profit-v1';
let saved = Object.create(null);
try {
  const parsed = JSON.parse(localStorage.getItem(STORE) || '{}');
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = Object.assign(Object.create(null), parsed);
} catch { /* Optional persistence is unavailable in some browsers. */ }
let historyPromise;
async function fetchHistory() {
  if (!historyPromise) historyPromise = (async () => {
    const [historyResult, statusResult] = await Promise.allSettled([
      fetch(new URL('./data/price-history.json', import.meta.url), { cache: 'no-store', signal: AbortSignal.timeout(20000) }).then(r => { if (!r.ok) throw new Error('history unavailable'); return r.json(); }),
      fetch(new URL('./data/history-status.json', import.meta.url), { cache: 'no-store', signal: AbortSignal.timeout(10000) }).then(r => r.ok ? r.json() : null),
    ]);
    if (historyResult.status !== 'fulfilled') return { data: null, status: null, error: true };
    const data = historyResult.value;
    if (data?.version !== 1 || !data.items || typeof data.items !== 'object') return { data: null, status: null, error: true };
    return { data, status: statusResult.status === 'fulfilled' ? statusResult.value : null, error: false };
  })().then(result => {
    if (result.error) historyPromise = null;
    return result;
  });
  return historyPromise;
}

/** A dialog with real daily observations and a user-defined profit model. */
export function createItemDetail({ onClose, onSelectOffer, onSearchItem }) {
  const dialog = document.querySelector('#item-dialog');
  const $ = selector => dialog.querySelector(selector);
  let item = null;
  let offers = [];
  let selectedOffer = null;
  let history = null;
  let historyLoading = false;
  let period = 30;
  let currentSeries = null;
  let lookupGeneration = 0;
  let storageNotice = false;
  let returnFocus = null;

  function open(nextItem, currentOffers, chosenOffer = null) {
    if (!nextItem) return;
    if (!dialog.open) returnFocus = document.activeElement;
    item = nextItem;
    offers = currentOffers.filter(o => o.itemId === item.id);
    selectedOffer = chosenOffer?.itemId === item.id ? chosenOffer : offers.find(o => o.type === 'sell') || offers[0] || null;
    const config = Object.hasOwn(saved, item.id) && saved[item.id] && typeof saved[item.id] === 'object' ? saved[item.id] : {};
    $('#detail-name').textContent = item.name;
    $('#detail-icon').src = item.icon || './assets/item.svg';
    $('#detail-icon').dataset.fallback = '';
    $('#detail-cost').value = typeof config.cost === 'string' ? config.cost.slice(0, 100) : '';
    $('#detail-extra').value = typeof config.extraCost === 'string' ? config.extraCost.slice(0, 100) : '0';
    $('#detail-fee').value = typeof config.feePercent === 'string' ? config.feePercent.slice(0, 100) : '0';
    $('#detail-target').value = typeof config.targetProfit === 'string' ? config.targetProfit.slice(0, 100) : '0';
    $('#detail-sale').value = selectedOffer ? String(selectedOffer.price) : '';
    $('#detail-reference').textContent = selectedOffer
      ? `Cena z odczytanej oferty ${selectedOffer.type === 'buy' ? 'kupna' : 'sprzedaży'} · ${selectedOffer.player}. Możesz wpisać własną cenę.`
      : 'Wpisz cenę, dla której chcesz policzyć wynik.';
    $('#detail-save-note').textContent = 'Twoje koszty zapamiętujemy dla tego przedmiotu na tym urządzeniu.';
    const sell = offers.filter(o => o.type === 'sell');
    const buy = offers.filter(o => o.type === 'buy');
    const lowest = sell.length ? Math.min(...sell.map(o => o.price)) : null;
    const highest = buy.length ? Math.max(...buy.map(o => o.price)) : null;
    $('#detail-ask').textContent = lowest === null ? 'Brak ofert' : `${fmt(lowest)} Z`;
    $('#detail-bid').textContent = highest === null ? 'Brak ofert' : `${fmt(highest)} Z`;
    $('#use-market-cost').disabled = lowest === null;
    $('#use-market-cost').dataset.price = lowest === null ? '' : String(lowest);
    const latest = offers.length ? offers.map(o => o.seenAt).sort().at(-1) : null;
    $('#detail-observed').textContent = latest ? `Odczyt sklepów: ${dated(latest)} (PL)` : 'Brak aktualnego odczytu sklepów';
    renderOffers();
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
    historyLoading = true;
    const generation = ++lookupGeneration;
    update();
    fetchHistory().then(result => {
      if (generation !== lookupGeneration) return;
      history = result;
      historyLoading = false;
      update();
    });
  }
  function close() { if (dialog.open) dialog.close(); }
  function persist() {
    if (!item) return;
    saved[item.id] = {
      cost: $('#detail-cost').value,
      extraCost: $('#detail-extra').value,
      feePercent: $('#detail-fee').value,
      targetProfit: $('#detail-target').value,
    };
    try { localStorage.setItem(STORE, JSON.stringify(saved)); }
    catch {
      if (!storageNotice) $('#detail-save-note').textContent = 'Przeglądarka zablokowała zapis. Ustawienia działają w tej sesji.';
      storageNotice = true;
    }
  }
  function update() {
    if (!item) return;
    const input = {
      cost: $('#detail-cost').value,
      extraCost: $('#detail-extra').value.trim() || 0,
      feePercent: $('#detail-fee').value.trim() || 0,
      targetProfit: $('#detail-target').value.trim() || 0,
      sellPrice: $('#detail-sale').value,
    };
    const result = calculateProfitability(input);
    $('#detail-break-even').textContent = result.valid ? `${fmt(result.breakEvenPrice)} Z` : 'Podaj koszt';
    $('#detail-target-price').textContent = result.valid ? `${fmt(result.targetPrice)} Z` : '—';
    const error = $('#detail-form-error');
    error.hidden = result.status !== 'invalid';
    error.textContent = result.errors.map(e => e.message).filter((v, i, a) => a.indexOf(v) === i).join(' ');
    const fields = { cost: '#detail-cost', extraCost: '#detail-extra', feePercent: '#detail-fee', targetProfit: '#detail-target', sellPrice: '#detail-sale' };
    for (const [key, selector] of Object.entries(fields)) $(selector).setAttribute('aria-invalid', String(result.errors.some(e => e.field === key)));
    const outcome = $('#detail-outcome');
    outcome.classList.toggle('loss', result.profit !== null && result.profit < 0);
    outcome.classList.toggle('gain', result.profit !== null && result.profit >= 0);
    $('#detail-profit').textContent = result.profit === null ? '—' : `${result.profit > 0 ? '+' : ''}${fmt(result.profit)} Z`;
    $('#detail-roi').textContent = result.roiPercent === null ? 'ROI: —' : `ROI: ${result.roiPercent > 0 ? '+' : ''}${fmt(result.roiPercent)}%`;
    $('#detail-outcome-note').textContent = result.status === 'needs-cost'
      ? 'Podaj koszt zakupu lub craftingu, aby zobaczyć progi na wykresie.'
      : result.status === 'invalid'
        ? 'Popraw wartości, aby obliczyć wynik.'
        : result.profit === null
          ? 'Podaj cenę sprzedaży, aby porównać ją z kosztami.'
          : result.meetsTarget
            ? 'Przy tej cenie pokrywasz koszty i osiągasz założony zysk.'
            : result.meetsBreakEven
              ? 'Przy tej cenie pokrywasz koszty, ale jeszcze nie osiągasz celu.'
              : 'Przy tej cenie nie odzyskujesz całego kosztu.';
    const label = $('#detail-history-status');
    currentSeries = buildItemHistory(history?.data || null, item.name, offers, { days: period });
    if (historyLoading) label.textContent = 'Wczytujemy historię. Widoczny punkt pochodzi z odczytu sklepów.';
    else if (history?.error) label.textContent = 'Historia jest chwilowo niedostępna. Pokazujemy wyłącznie dostępne odczyty sklepów.';
    else if (history?.status?.success === false) label.textContent = 'Ostatnie pobranie historii nie powiodło się. Pokazujemy zachowane dane i odczyt sklepów.';
    else if (currentSeries.points.length === 0) label.textContent = 'Brak odczytów w tym zakresie. Wybierz dłuższy okres.';
    else if (currentSeries.points.length === 1) label.textContent = 'Dostępny jest jeden dzień obserwacji. Nie dopisujemy wcześniejszych cen.';
    else label.textContent = `${currentSeries.points.length} dni z odczytami · ${day(currentSeries.points[0].date)}–${day(currentSeries.points.at(-1).date)}. Brakujących dni nie uzupełniamy.`;
    $('#detail-threshold-hint').hidden = result.status !== 'needs-cost';
    renderChart(currentSeries.points, result);
    renderHistoryTable(currentSeries.points);
  }
  function renderChart(points, result) {
    const chart = $('#detail-chart');
    if (!points.length) {
      chart.innerHTML = '<div class="chart-empty"><span aria-hidden="true">∿</span><strong>Brak cen w wybranym okresie</strong><p>Zmień zakres. Twoje progi pozostają widoczne w kalkulatorze.</p></div>';
      return;
    }
    const showSell = $('#show-sell').checked;
    const showBuy = $('#show-buy').checked;
    const sellPoints = points.filter(p => p.sellMin !== null);
    const buyPoints = points.filter(p => p.buyMax !== null);
    const values = points.flatMap(p => [showSell ? p.sellMin : null, showSell ? p.sellMax : null, showBuy ? p.buyMax : null]).filter(v => v !== null);
    if (result.valid) values.push(result.breakEvenPrice, result.targetPrice);
    if (!values.length) values.push(0, 1);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const padding = Math.max((maximum - minimum) * .14, maximum * .06, 1);
    const low = Math.max(0, minimum - padding);
    const high = Math.max(low + 1, maximum + padding);
    const W = 760, H = 310;
    const box = { x: 78, y: 23, w: 590, h: 226 };
    const times = points.map(p => Date.parse(`${p.date}T00:00:00Z`));
    let start = Math.min(...times), end = Math.max(...times);
    if (start === end) { start -= 43200000; end += 43200000; }
    const sx = date => box.x + (Date.parse(`${date}T00:00:00Z`) - start) / (end - start) * box.w;
    const sy = price => box.y + (high - price) / (high - low) * box.h;
    const pt = (p, key) => `${sx(p.date).toFixed(2)},${sy(p[key]).toFixed(2)}`;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="price-chart-title price-chart-description" xmlns="http://www.w3.org/2000/svg"><title id="price-chart-title">Ceny ${esc(item.name)} i progi opłacalności</title><desc id="price-chart-description">Najniższa odczytana sprzedaż, najwyższe kupno oraz progi obliczone z Twoich kosztów. Dane każdego dnia są dostępne w tabeli pod wykresem.</desc>`;
    for (let i = 0; i <= 4; i++) {
      const val = low + (high - low) * i / 4;
      const y = sy(val);
      svg += `<line class="chart-grid-line" x1="${box.x}" x2="${box.x + box.w}" y1="${y}" y2="${y}"/><text class="chart-axis-text" x="${box.x - 13}" y="${y + 4}" text-anchor="end">${esc(compact(Math.round(val)))}</text>`;
    }
    svg += `<text class="chart-axis-title" x="${box.x}" y="11">CENA OFERTY · ZULIE</text>`;
    const labelIndexes = new Set(points.length <= 5 ? points.map((_, i) => i) : [0, Math.round((points.length - 1) / 4), Math.round((points.length - 1) / 2), Math.round((points.length - 1) * 3 / 4), points.length - 1]);
    for (const i of labelIndexes) svg += `<text class="chart-axis-text" x="${sx(points[i].date)}" y="${box.y + box.h + 25}" text-anchor="middle">${day(points[i].date)}</text>`;
    svg += `<text class="chart-axis-title" x="${box.x + box.w}" y="${H - 8}" text-anchor="end">DNI ODCZYTÓW (UTC)</text>`;
    if (showSell && sellPoints.length > 1) {
      const upper = sellPoints.map(p => pt(p, 'sellMax')).join(' ');
      const lower = [...sellPoints].reverse().map(p => pt(p, 'sellMin')).join(' ');
      svg += `<polygon class="chart-sell-range" points="${upper} ${lower}"/>`;
    }
    function series(data, key, cls, description) {
      if (!data.length) return '';
      const connected = data.length > 1 ? `<polyline class="${cls}" fill="none" points="${data.map(p => pt(p, key)).join(' ')}"/>` : '';
      return connected + data.map(p => `<circle class="${cls}-point" cx="${sx(p.date)}" cy="${sy(p[key])}" r="4.3" tabindex="0" aria-label="${esc(p.date)}: ${description} ${fmt(p[key])} Zulie"><title>${esc(p.date)} · ${description}: ${fmt(p[key])} Zulie${key === 'sellMin' ? ` · zakres sprzedaży ${fmt(p.sellMin)}–${fmt(p.sellMax)} Z` : ''}</title></circle>`).join('');
    }
    if (showSell) svg += series(sellPoints, 'sellMin', 'chart-sell', 'najniższa sprzedaż');
    if (showBuy) svg += series(buyPoints, 'buyMax', 'chart-buy', 'najwyższe kupno');
    if (result.valid) {
      const y = sy(result.breakEvenPrice);
      svg += `<line class="chart-break-even" x1="${box.x}" x2="${box.x + box.w}" y1="${y}" y2="${y}"/><text class="chart-threshold-label threshold-cost" x="${box.x + box.w + 8}" y="${y + 4}">KOSZT</text>`;
      if (result.targetPrice !== result.breakEvenPrice) {
        const targetY = sy(result.targetPrice);
        const labelY = Math.abs(targetY - y) < 17 ? Math.max(box.y + 10, targetY - 10) : targetY + 4;
        svg += `<line class="chart-target" x1="${box.x}" x2="${box.x + box.w}" y1="${targetY}" y2="${targetY}"/><text class="chart-threshold-label threshold-target" x="${box.x + box.w + 8}" y="${labelY}">CEL</text>`;
      }
    }
    svg += '</svg>';
    chart.innerHTML = svg;
  }
  function renderHistoryTable(points) {
    $('#detail-history-rows').innerHTML = points.map(p => `<tr><th scope="row">${esc(p.date)}</th><td>${fmt(p.sellMin)}</td><td>${fmt(p.sellMax)}</td><td>${fmt(p.buyMax)}</td></tr>`).join('');
    $('#detail-history-table').hidden = !points.length;
  }
  function renderOffers() {
    const sorted = [...offers].sort((a, b) => a.type.localeCompare(b.type) || (a.type === 'buy' ? b.price - a.price : a.price - b.price));
    $('#detail-offer-count').textContent = `${offers.length}`;
    $('#detail-offers').innerHTML = sorted.slice(0, 10).map(o => `<button class="detail-offer" data-detail-offer="${esc(o.id)}"><span><strong>${esc(o.player)}</strong><small>${o.type === 'sell' ? 'Sprzedaje' : 'Kupuje'} · X ${fmt(o.x)} / Y ${fmt(o.y)}</small></span><span><b>${fmt(o.price)} Z</b><small>Pokaż sklep ↗</small></span></button>`).join('') || '<p class="detail-muted">Brak ofert tego przedmiotu w odczycie sklepów.</p>';
    $('#detail-all-offers').textContent = offers.length > 10 ? `Pokaż wszystkie oferty (${offers.length}) →` : 'Pokaż oferty w wyszukiwarce →';
  }
  $('#detail-close').addEventListener('click', close);
  dialog.addEventListener('close', () => {
    ++lookupGeneration;
    onClose?.();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  });
  dialog.addEventListener('click', event => {
    if (event.target === dialog) {
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
    }
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.days) {
      period = Number(button.dataset.days);
      for (const option of dialog.querySelectorAll('[data-days]')) option.setAttribute('aria-pressed', String(Number(option.dataset.days) === period));
      update();
    }
    if (button.dataset.detailOffer) {
      const id = button.dataset.detailOffer;
      close(); onSelectOffer?.(id);
    }
  });
  for (const id of ['detail-cost', 'detail-extra', 'detail-fee', 'detail-target', 'detail-sale']) {
    $('#' + id).addEventListener('input', () => {
      if (id === 'detail-sale') $('#detail-reference').textContent = 'Porównujesz własną cenę sprzedaży z podanymi kosztami.';
      persist(); update();
    });
  }
  $('#show-sell').addEventListener('change', update);
  $('#show-buy').addEventListener('change', update);
  $('#use-market-cost').addEventListener('click', () => {
    const value = $('#use-market-cost').dataset.price;
    if (value === '') return;
    $('#detail-cost').value = value;
    persist(); update();
  });
  $('#detail-reset').addEventListener('click', () => {
    $('#detail-cost').value = '';
    for (const id of ['detail-extra', 'detail-fee', 'detail-target']) $('#' + id).value = '0';
    persist(); update();
  });
  $('#detail-all-offers').addEventListener('click', () => { const name = item?.name; close(); if (name) onSearchItem?.(name); });
  $('#detail-icon').addEventListener('error', () => {
    if (!$('#detail-icon').dataset.fallback) { $('#detail-icon').dataset.fallback = '1'; $('#detail-icon').src = './assets/item.svg'; }
  });
  return { open, close, isOpen: () => dialog.open, resetHistory: () => { historyPromise = null; history = null; } };
}
