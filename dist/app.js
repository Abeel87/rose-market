import { normalizeSnapshot, filterOffers, worldToMap } from './market.js';
import { createItemDetail } from './item-detail.js?v=archive-1';
import { syncLabel } from './data-status.js?v=archive-1';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = value => new Intl.NumberFormat('pl-PL').format(value);
const plural = (value, one, few, many) => value === 1 ? one : value % 10 >= 2 && value % 10 <= 4 && (value % 100 < 12 || value % 100 > 14) ? few : many;
const coord = value => new Intl.NumberFormat('pl-PL', { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const fullDate = value => value ? new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Warsaw' }).format(new Date(value)) + ' (PL)' : 'Brak informacji';
const shortDate = value => value ? new Intl.DateTimeFormat('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' }).format(new Date(value)) : 'Brak odczytu';
const PAGE_SIZE = 18;
const STORAGE_KEY = 'rose-market-v1';
const CITY_VIEW = [200, 100, 300, 300];
const FALLBACK_ICON = './assets/item.svg';
let dataset = null;
let filtered = [];
let syncStatus = null;
let busy = false;
let toastTimer;
let viewBox = [...CITY_VIEW];
let dragging = null;
let suppressMapClick = false;
let favorites = new Set();
try {
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  if (Array.isArray(stored.favorites)) favorites = new Set(stored.favorites.filter(v => typeof v === 'string' && v.length < 160).slice(0, 5000));
} catch { /* A private browser may not have local storage. */ }

const state = { query: '', type: 'sell', sort: 'price-asc', view: 'offers', page: 1, stall: null, offer: null, item: null };
const itemDetail = createItemDetail({
  onClose: () => { state.item = null; writeHash(); },
  onSelectOffer: id => {
    const offer = dataset?.offers.find(o => o.id === id);
    if (offer) selectShop(offer.stallId, offer.id, true);
  },
  onSearchItem: name => {
    state.query = name;
    state.type = 'all';
    state.view = 'offers';
    state.page = 1;
    render();
  },
});
function openItem(itemId, offerId = null) {
  const item = dataset?.items.find(i => i.id === itemId);
  if (!item) { state.item = null; itemDetail.close(); writeHash(); return; }
  state.item = item.id;
  writeHash();
  itemDetail.open(item, dataset.offers, dataset.offers.find(o => o.id === offerId));
}
function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  state.query = (params.get('q') || '').slice(0, 500);
  state.type = ['sell', 'buy', 'all'].includes(params.get('type')) ? params.get('type') : 'sell';
  state.view = ['offers', 'map', 'favorites', 'about'].includes(params.get('view')) ? params.get('view') : 'offers';
  state.sort = ['price-asc', 'price-desc', 'name', 'recent'].includes(params.get('sort')) ? params.get('sort') : 'price-asc';
  state.stall = params.get('shop') || null;
  state.item = params.get('item') || null;
  state.offer = null;
  state.page = 1;
}
function writeHash() {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.type !== 'sell') params.set('type', state.type);
  if (state.view !== 'offers') params.set('view', state.view);
  if (state.sort !== 'price-asc') params.set('sort', state.sort);
  if (state.stall) params.set('shop', state.stall);
  if (state.item) params.set('item', state.item);
  const hash = params.toString();
  history.replaceState(null, '', `${location.pathname}${location.search}${hash ? '#' + hash : ''}`);
}
function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3400);
}
function ageLabel(value) {
  if (!value) return 'Czas obserwacji nieznany';
  const age = Math.max(0, Date.now() - new Date(value).getTime());
  if (age < 60 * 60 * 1000) return `Około ${Math.max(1, Math.floor(age / 60000))} min temu`;
  if (age < 48 * 60 * 60 * 1000) return `Około ${Math.floor(age / 3600000)} godz. temu`;
  return `Około ${Math.floor(age / 86400000)} dni temu`;
}
function renderMetadata() {
  if (!dataset) return;
  const { stats, meta } = dataset;
  $('#stat-stalls').textContent = number(stats.stalls);
  $('#stat-items').textContent = number(stats.items);
  $('#stat-sell').textContent = number(stats.sellOffers);
  $('#stat-buy').textContent = number(stats.buyOffers);
  $('#scan-time').textContent = shortDate(stats.lastSeenAt) + ' (PL)';
  $('#scan-age').textContent = `Archiwum · ${ageLabel(stats.lastSeenAt).toLowerCase()}`;
  $('#scan-time').title = fullDate(stats.lastSeenAt);
  $('#source-observed').textContent = fullDate(stats.lastSeenAt);
  $('#source-fetched').textContent = fullDate(meta.fetchedAt);
  $('#source-synced').textContent = syncStatus?.attemptedAt
    ? `${fullDate(syncStatus.attemptedAt)} · ${syncLabel(syncStatus, { sourceRetired: true })}`
    : 'Archiwum — źródło zakończyło aktualizacje 24.10.2026';
  $('#data-notice p').textContent = `Archiwalny odczyt sklepów: ${fullDate(stats.lastSeenAt)}. Ceny i miejsca nie potwierdzają obecnej dostępności ofert.`;
}
function renderNavigation() {
  document.body.classList.toggle('mode-map', state.view === 'map');
  $('#market-panel').hidden = state.view === 'about';
  $('#about-panel').hidden = state.view !== 'about';
  for (const button of $$('.nav-link')) {
    const active = button.dataset.view === state.view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  $('#favorite-count').textContent = number(favorites.size);
  $('#favorites-indicator').hidden = state.view !== 'favorites';
  if ($('#search').value !== state.query) $('#search').value = state.query;
  $('#sort').value = state.sort;
  for (const button of $$('[data-type]')) {
    button.classList.toggle('active', button.dataset.type === state.type);
    button.setAttribute('aria-pressed', String(button.dataset.type === state.type));
  }
}
function renderResults() {
  if (!dataset) return;
  const options = { query: state.query, favorites, onlyFavorites: state.view === 'favorites', sort: state.sort };
  filtered = filterOffers(dataset.offers, { ...options, type: state.type });
  const matchingAll = filterOffers(dataset.offers, { ...options, type: 'all' });
  $('#sell-filter-count').textContent = number(matchingAll.filter(o => o.type === 'sell').length);
  $('#buy-filter-count').textContent = number(matchingAll.filter(o => o.type === 'buy').length);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  state.page = Math.min(Math.max(1, state.page), pages);
  const start = (state.page - 1) * PAGE_SIZE;
  const page = filtered.slice(start, start + PAGE_SIZE);
  $('#results-title').textContent = state.view === 'favorites' ? 'Obserwowane · archiwum' : state.type === 'sell' ? 'Archiwum sprzedaży' : state.type === 'buy' ? 'Archiwum kupna' : 'Archiwum ofert';
  const shops = new Set(filtered.map(o => o.stallId)).size;
  $('#results-count').textContent = `${number(filtered.length)} ${plural(filtered.length, 'oferta', 'oferty', 'ofert')} · ${number(shops)} ${plural(shops, 'sklep', 'sklepy', 'sklepów')}${state.query ? ` · „${state.query}”` : ''}`;
  $('#offer-rows').innerHTML = page.map(offer => {
    const selected = offer.id === state.offer || offer.stallId === state.stall;
    const favorite = favorites.has(offer.itemId);
    return `<tr class="${selected ? 'selected' : ''}" data-offer-row="${esc(offer.id)}">
      <td><button class="item-cell item-open" data-item="${esc(offer.itemId)}" data-item-offer="${esc(offer.id)}" aria-label="Pokaż wykres cen: ${esc(offer.itemName)}" title="Kliknij, aby zobaczyć ceny i opłacalność"><img class="item-icon" src="${esc(offer.icon || FALLBACK_ICON)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span><span class="item-name">${esc(offer.itemName)}<span class="chart-link-icon" aria-hidden="true">↗</span></span><span class="item-sub ${offer.type}">${offer.type === 'sell' ? 'Sprzedaż' : 'Kupno'} · Junon</span></span></button></td>
      <td><span class="price">${number(offer.price)}<span class="price-mini" title="${esc(fullDate(offer.seenAt))}">${esc(shortDate(offer.seenAt))}</span></span></td>
      <td><button class="vendor-button" data-shop="${esc(offer.stallId)}" title="Pokaż sklep ${esc(offer.player)} na mapie">${esc(offer.player)}</button><span class="coords-mini">${coord(offer.x)} · ${coord(offer.y)}</span></td>
      <td><div class="row-actions"><button class="map-button" data-offer="${esc(offer.id)}" aria-label="Pokaż ${esc(offer.itemName)} u ${esc(offer.player)} na mapie">Mapa</button><button class="favorite-button ${favorite ? 'on' : ''}" data-favorite="${esc(offer.itemId)}" aria-label="${favorite ? 'Usuń z obserwowanych' : 'Obserwuj'}: ${esc(offer.itemName)}" aria-pressed="${favorite}">${favorite ? '★' : '☆'}</button></div></td>
    </tr>`;
  }).join('');
  $('#empty-state').hidden = filtered.length !== 0;
  $('.offer-table').hidden = filtered.length === 0;
  if (state.view === 'favorites' && favorites.size === 0) {
    $('#empty-title').textContent = 'Twoja lista dopiero powstaje';
    $('#empty-message').textContent = 'Kliknij gwiazdkę przy przedmiocie. Jego oferty znajdziesz tutaj przy następnej wizycie na tym urządzeniu.';
  } else {
    $('#empty-title').textContent = 'Nie ma takiej oferty w tym odczycie';
    $('#empty-message').textContent = 'Spróbuj skrócić nazwę albo zmienić rodzaj ofert. Brak wyniku nie oznacza, że nikt nie sprzedaje tego przedmiotu w grze.';
  }
  $('#page-info').textContent = filtered.length ? `${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} z ${number(filtered.length)} ${filtered.length === 1 ? 'oferty' : 'ofert'} · strona ${state.page}/${pages}` : '0 ofert';
  $('#prev-page').disabled = state.page <= 1;
  $('#next-page').disabled = state.page >= pages;
  renderMap();
}
function point(stall) {
  const { px, py } = worldToMap(stall.x, stall.y);
  return { x: px, y: py };
}
function updateMapView() { $('#junon-map').setAttribute('viewBox', viewBox.join(' ')); }
function focusStall(stall, zoom = true) {
  if (!stall) return;
  const p = point(stall);
  const size = zoom ? Math.min(viewBox[2], 170) : viewBox[2];
  viewBox = [Math.max(0, Math.min(576 - size, p.x - size / 2)), Math.max(0, Math.min(512 - size, p.y - size / 2)), size, size];
  updateMapView();
}
function renderMap() {
  if (!dataset) return;
  const matchedIds = new Set(filtered.map(o => o.stallId));
  const stalls = dataset.stalls.filter(s => matchedIds.has(s.id));
  const selected = dataset.stalls.find(s => s.id === state.stall);
  // A selected location remains visible while a search changes; it is labeled
  // in the details panel even if it no longer matches the table filters.
  if (selected && !matchedIds.has(selected.id)) stalls.push(selected);
  $('#map-count').textContent = `${number(matchedIds.size)} ${plural(matchedIds.size, 'sklep', 'sklepy', 'sklepów')}`;
  const ordered = [...stalls].sort((a, b) => Number(a.id === state.stall) - Number(b.id === state.stall));
  $('#map-markers').innerHTML = ordered.map(stall => {
    const p = point(stall);
    const chosen = stall.id === state.stall;
    return `<g class="map-marker ${chosen ? 'selected' : ''}" data-shop="${esc(stall.id)}" role="button" tabindex="0" aria-label="Sklep ${esc(stall.player)}, X ${coord(stall.x)}, Y ${coord(stall.y)}" transform="translate(${p.x} ${p.y})"><title>${esc(stall.player)} · X ${coord(stall.x)} / Y ${coord(stall.y)}</title>${chosen ? '<circle class="marker-selected-ring" r="6.5"/>' : ''}<circle class="marker-ring" r="${chosen ? 3.5 : 2.4}"/></g>`;
  }).join('');
  updateMapView();
  renderShop(selected);
}
function renderShop(stall) {
  if (!stall) {
    $('#shop-details').innerHTML = '<div class="shop-empty"><span aria-hidden="true">⌖</span><h3>Dokąd ruszamy?</h3><p>Wybierz „Mapa” przy ofercie lub kliknij znacznik, aby zobaczyć nick i współrzędne sklepu.</p></div>';
    return;
  }
  const inFilter = filtered.some(o => o.stallId === stall.id);
  const offers = [...stall.offers].sort((a, b) => a.type.localeCompare(b.type) || a.itemName.localeCompare(b.itemName, 'pl'));
  $('#shop-details').innerHTML = `<div class="shop-header"><div><p class="eyebrow">WYBRANY SKLEP</p><h3>${esc(stall.player)}</h3></div><button class="share-button" id="share-shop">Link ↗</button></div>
    <span class="small-pill">City of Junon Polis</span>
    <div class="shop-coords"><span class="coordinate-box"><span>X</span> ${coord(stall.x)}</span><span class="coordinate-box"><span>Y</span> ${coord(stall.y)}</span><button class="copy-button" id="copy-position">Kopiuj miejsce</button></div>
    <p class="shop-seen">◷ Archiwalne miejsce: ${esc(fullDate(stall.seenAt))}<br>${esc(ageLabel(stall.seenAt))}${inFilter ? '' : ' · Sklep poza aktualnym filtrem'}</p>
    <p class="shop-list-title">Archiwalne oferty sklepu · ${number(offers.length)}</p>
    <ul class="shop-list">${offers.map(o => `<li><button data-item="${esc(o.itemId)}" data-item-offer="${esc(o.id)}" title="Wykres cen i opłacalność"><span>${esc(o.itemName)}<small>${o.type === 'sell' ? 'Gracz sprzedaje' : 'Gracz kupuje'} · wykres ↗</small></span><strong>${number(o.price)} Z</strong></button></li>`).join('')}</ul>`;
}
function render() {
  renderNavigation();
  renderResults();
  writeHash();
}
function selectShop(stallId, offerId = null, scroll = false) {
  const stall = dataset?.stalls.find(s => s.id === stallId);
  if (!stall) return;
  state.stall = stall.id;
  state.offer = offerId;
  focusStall(stall);
  render();
  if (scroll && matchMedia('(max-width: 730px)').matches) $('.map-panel').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}
function changeView(view) {
  state.view = view;
  state.page = 1;
  render();
  if (view === 'map' && matchMedia('(max-width: 730px)').matches) $('.map-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function clearFilters() {
  state.query = '';
  state.type = 'sell';
  state.sort = 'price-asc';
  state.page = 1;
  state.stall = null;
  state.offer = null;
  viewBox = [...CITY_VIEW];
  if (state.view === 'favorites') state.view = 'offers';
  render();
}
async function copyText(value, success) {
  try { await navigator.clipboard.writeText(value); showToast(success); }
  catch { showToast('Nie udało się skopiować. Zaznacz współrzędne lub skopiuj adres z paska przeglądarki.'); }
}
async function loadData() {
  if (busy) return;
  itemDetail.resetHistory();
  busy = true;
  $('#refresh').disabled = true;
  try {
    const [dataResult, statusResult] = await Promise.allSettled([
      fetch(new URL('./data/market-stalls.json', import.meta.url), { cache: 'no-store', signal: AbortSignal.timeout(20000) }).then(r => { if (!r.ok) throw new Error('snapshot unavailable'); return r.json(); }),
      fetch(new URL('./data/sync-status.json', import.meta.url), { cache: 'no-store', signal: AbortSignal.timeout(10000) }).then(r => r.ok ? r.json() : null)
    ]);
    if (dataResult.status !== 'fulfilled') throw new Error('snapshot unavailable');
    const parsed = normalizeSnapshot(dataResult.value);
    if (parsed.meta.mapId !== 'city_of_junon_polis') throw new Error('unsupported map');
    if (!parsed.offers.length) throw new Error('empty snapshot');
    dataset = parsed;
    syncStatus = statusResult.status === 'fulfilled' ? statusResult.value : null;
    if (syncStatus && (typeof syncStatus.success !== 'boolean' || !Number.isFinite(Date.parse(syncStatus.attemptedAt)))) syncStatus = null;
    if (state.stall && !dataset.stalls.some(s => s.id === state.stall)) {
      state.stall = null;
      showToast('Tego sklepu nie ma we wczytanym archiwum. Pokazujemy pozostałe oferty.');
    }
    $('#load-error').hidden = true;
    renderMetadata();
    render();
    if (state.stall) focusStall(dataset.stalls.find(s => s.id === state.stall));
    if (state.item) openItem(state.item);
  } catch {
    $('#load-error').hidden = false;
    $('#load-error').textContent = dataset
      ? 'Nie udało się ponownie wczytać archiwum. Nadal widzisz poprzednio wczytane dane. Spróbuj przyciskiem „Wczytaj ponownie”.'
      : 'Nie udało się wczytać archiwum sklepów. Sprawdź połączenie i użyj przycisku „Wczytaj ponownie”.';
    if (!dataset) {
      $('#results-count').textContent = 'Dane chwilowo niedostępne';
      $('#scan-time').textContent = 'Brak danych';
      $('#scan-age').textContent = 'Archiwum · spróbuj wczytać ponownie';
      $('#prev-page').disabled = true;
      $('#next-page').disabled = true;
    }
  } finally {
    busy = false;
    $('#refresh').disabled = false;
  }
}

document.addEventListener('click', event => {
  const target = event.target.closest('button, [data-shop]');
  if (!target) return;
  if (target.dataset.item) { openItem(target.dataset.item, target.dataset.itemOffer); return; }
  if (target.dataset.view) { changeView(target.dataset.view); return; }
  if (target.dataset.type) {
    state.type = target.dataset.type;
    state.sort = state.type === 'buy' ? 'price-desc' : 'price-asc';
    state.page = 1;
    render(); return;
  }
  if (target.dataset.favorite) {
    const id = target.dataset.favorite;
    if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ favorites: [...favorites] })); }
    catch { showToast('Obserwowane działają w tej sesji. Przeglądarka zablokowała trwały zapis.'); }
    render(); return;
  }
  if (target.dataset.offer) {
    const offer = dataset?.offers.find(o => o.id === target.dataset.offer);
    if (offer) selectShop(offer.stallId, offer.id, true);
    return;
  }
  if (target.dataset.shop) {
    if (suppressMapClick && target.classList.contains('map-marker')) { suppressMapClick = false; return; }
    selectShop(target.dataset.shop, null, !target.classList.contains('map-marker'));
    return;
  }
  if (target.dataset.searchItem) {
    if (state.view === 'favorites') state.view = 'offers';
    state.query = target.dataset.searchItem;
    state.type = target.dataset.itemType;
    state.page = 1;
    state.sort = state.type === 'buy' ? 'price-desc' : 'price-asc';
    render();
    return;
  }
  if (target.id === 'copy-position') {
    const stall = dataset?.stalls.find(s => s.id === state.stall);
    if (stall) copyText(`${stall.player} · Junon Polis · X: ${stall.x.toFixed(2)}, Y: ${stall.y.toFixed(2)} · ostatnio widziany ${fullDate(stall.seenAt)}`, 'Skopiowano nick, współrzędne i czas odczytu.');
  }
  if (target.id === 'share-shop') copyText(location.href, 'Skopiowano link do wybranego sklepu.');
});
$('#search').addEventListener('input', event => {
  state.query = event.target.value;
  state.page = 1;
  state.offer = null;
  render();
});
$('#sort').addEventListener('change', event => { state.sort = event.target.value; state.page = 1; render(); });
$('#clear-filters').addEventListener('click', clearFilters);
$('#empty-clear').addEventListener('click', clearFilters);
$('#refresh').addEventListener('click', loadData);
$('#prev-page').addEventListener('click', () => { state.page--; renderResults(); $('.results-panel').scrollIntoView({ block: 'start' }); });
$('#next-page').addEventListener('click', () => { state.page++; renderResults(); $('.results-panel').scrollIntoView({ block: 'start' }); });
document.addEventListener('error', event => {
  if (event.target instanceof HTMLImageElement && event.target.classList.contains('item-icon') && !event.target.dataset.fallback) {
    event.target.dataset.fallback = '1';
    event.target.src = FALLBACK_ICON;
  }
}, true);
document.addEventListener('keydown', event => {
  if (itemDetail.isOpen()) return;
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
    event.preventDefault();
    if (state.view === 'about') changeView('offers');
    $('#search').focus();
  }
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.map-marker')) {
    event.preventDefault(); selectShop(event.target.dataset.shop);
  }
});
function zoom(factor) {
  const width = Math.max(60, Math.min(576, viewBox[2] * factor));
  const height = Math.max(60, Math.min(512, viewBox[3] * factor));
  const cx = viewBox[0] + viewBox[2] / 2;
  const cy = viewBox[1] + viewBox[3] / 2;
  viewBox = [Math.max(0, Math.min(576 - width, cx - width / 2)), Math.max(0, Math.min(512 - height, cy - height / 2)), width, height];
  updateMapView();
}
$('#zoom-in').addEventListener('click', () => zoom(.72));
$('#zoom-out').addEventListener('click', () => zoom(1.4));
$('#reset-map').addEventListener('click', () => { viewBox = [0, 0, 576, 512]; updateMapView(); });
const map = $('#junon-map');
map.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  dragging = { id: event.pointerId, x: event.clientX, y: event.clientY, box: [...viewBox], moved: false };
  suppressMapClick = false;
});
map.addEventListener('pointermove', event => {
  if (!dragging || dragging.id !== event.pointerId) return;
  const dx = event.clientX - dragging.x;
  const dy = event.clientY - dragging.y;
  if (!dragging.moved && Math.hypot(dx, dy) < 5) return;
  dragging.moved = true;
  map.classList.add('dragging');
  if (!map.hasPointerCapture(event.pointerId)) map.setPointerCapture(event.pointerId);
  const rect = map.getBoundingClientRect();
  const scale = Math.min(rect.width / dragging.box[2], rect.height / dragging.box[3]);
  viewBox = [Math.max(0, Math.min(576 - dragging.box[2], dragging.box[0] - dx / scale)), Math.max(0, Math.min(512 - dragging.box[3], dragging.box[1] - dy / scale)), dragging.box[2], dragging.box[3]];
  updateMapView();
});
function endDrag(event) {
  if (!dragging || dragging.id !== event.pointerId) return;
  suppressMapClick = dragging.moved;
  if (map.hasPointerCapture(event.pointerId)) map.releasePointerCapture(event.pointerId);
  dragging = null;
  map.classList.remove('dragging');
}
map.addEventListener('pointerup', endDrag);
map.addEventListener('pointercancel', endDrag);
map.addEventListener('pointerleave', event => { if (dragging && !dragging.moved) endDrag(event); });
window.addEventListener('hashchange', () => {
  readHash(); render();
  if (dataset && state.stall) focusStall(dataset.stalls.find(s => s.id === state.stall));
  if (dataset && state.item) openItem(state.item);
  else itemDetail.close();
});
readHash();
renderNavigation();
loadData();
setInterval(renderMetadata, 60000);
