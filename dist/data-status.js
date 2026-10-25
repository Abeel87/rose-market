/** A successful HTTP fetch says nothing about new observations at the source. */
export function syncLabel(status) {
  if (status?.success === false) return 'błąd — pokazujemy zachowaną kopię';
  if (status?.success !== true) return 'status pobrania niedostępny';
  if (status.dataChanged === false) return 'pobrano poprawnie — dane źródłowe bez zmian';
  if (status.dataChanged === true) return 'pobrano zmienione dane';
  return 'plik pobrany poprawnie — sprawdź datę obserwacji';
}

export function latestObservationDate(history) {
  let latest = null;
  for (const item of Object.values(history?.items ?? {})) {
    for (const point of item?.points ?? []) {
      if (typeof point.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(point.date)
        && (!latest || point.date > latest)) latest = point.date;
    }
  }
  return latest;
}
