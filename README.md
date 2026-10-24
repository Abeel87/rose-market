# ROSE Market

Polska przeglądarka publicznych danych o sklepach graczy **ROSE Online Global**. Pomaga znaleźć oferty i ostatnio zaobserwowane położenie sprzedawcy w **Junon Polis**.

- **Strona:** https://abeel87.github.io/rose-market/
- **Repozytorium:** https://github.com/Abeel87/rose-market

## Co pokazuje aplikacja

- Oferty sprzedaży i skupu, nazwę przedmiotu oraz cenę oferty w Zulie.
- Nazwę gracza prowadzącego sklep, jego współrzędne i miejsce na mapie Junon Polis.
- Datę ostatniej obserwacji sklepu i datę kopii danych dostawcy.
- Wyszukiwanie i filtrowanie ofert oraz ulubione zapisywane w tej przeglądarce.
- Status ostatniej próby pobrania danych, również gdy odświeżenie się nie powiodło.

To zapis obserwacji. **Pozycja na mapie nie potwierdza, że sklep nadal działa w tym miejscu ani że przedmiot jest jeszcze dostępny.** Dane nie obejmują innych map. Aplikacja nie łączy się z kontem w grze i nie prowadzi transakcji.

### Znaczenie ceny

Kwota jest opisana jako **cena oferty**. Źródło nie podaje ilości przedmiotów i nie pozwala potwierdzić, czy cena dotyczy jednej sztuki, czy całego stosu. Aplikacja nie przelicza jej automatycznie na cenę jednostkową ani nie dopisuje liczby sztuk.

## Dane i atrybucja

Źródłem pliku jest publiczny [marketStalls.json w ROSE Online Toolbox](https://roseonlinetoolbox.com/data/marketStalls.json). Metadane tego pliku wskazują [ROSE Utils Market](https://roseutils.com/market) jako źródło rynku. Ikony przedmiotów są dostarczane przez ROSE Online Toolbox. Nazwy i grafiki gry oraz dane zewnętrznych serwisów należą do ich właścicieli; to niezależny projekt fanowski.

Kopia początkowa z **24 października 2026 r.** zawierała 284 rekordy sklepów, 1196 wpisów w słowniku przedmiotów i 2222 oferty. Są to liczby opisujące tę konkretną kopię, a nie stałe ani gwarantowane aktualne liczby sklepów online.

Zachowujemy daty `_meta.fetchedAt`, `_meta.date` i `seenAt` dokładnie tak, jak przekazuje je dostawca. Udane pobranie pliku nie oznacza nowej obserwacji graczy. Własny czas próby pobrania znajduje się osobno w `dist/data/sync-status.json`.

## Odświeżanie i publikacja

GitHub Actions publikuje katalog `dist/` przez GitHub Pages:

- po zmianach kodu, danych lub konfiguracji na gałęzi `main`;
- po ręcznym uruchomieniu workflow **Publish ROSE Market**;
- według harmonogramu o **08:37 i 20:37 UTC** każdego dnia.

Przy publikacji skrypt `scripts/sync-market.mjs` wykonuje jedno pobranie HTTPS ze wskazanego źródła, z limitem czasu 25 sekund i rozmiaru 8 MiB. Sprawdza schemat przez `normalizeSnapshot`, odrzuca puste lub starsze kopie i dopiero potem atomowo zastępuje plik danych. Nie zmienia czasów obserwacji na czas uruchomienia skryptu.

Jeśli pobranie lub walidacja się nie powiedzie, skrypt zachowuje dostępną kopię i zapisuje status błędu. Workflow może wtedy opublikować zweryfikowaną **kopię zapasową z repozytorium** wraz z tym statusem. Nowe dane trafiają do publikowanej strony; automatyczne uruchomienia nie dopisują commitów do repozytorium. Częstsze uruchomienie workflow nie przyspiesza aktualizacji danych u dostawcy.

## Uruchomienie lokalnie

Aplikacja jest statyczna i nie wymaga instalowania pakietów ani budowania. Z katalogu projektu uruchom serwer HTTP, na przykład:

```sh
python3 -m http.server 8000 --directory dist
```

Otwórz http://localhost:8000/. Serwer HTTP jest potrzebny do wczytania modułów JavaScript i pliku JSON.

Sprawdzenie kodu i testów wymaga Node.js:

```sh
npm test
npm run check
```

Ręczne pobranie danych:

```sh
npm run sync
```

Przy błędzie pobrania lub walidacji polecenie kończy się kodem różnym od zera; poprawna istniejąca kopia pozostaje na miejscu, a status opisuje nieudaną próbę.

## Prywatność i ograniczenia

Ulubione są przechowywane lokalnie w przeglądarce. Nie synchronizują się automatycznie pomiędzy urządzeniami. Informacje o sklepach pochodzą z publicznej bazy; aplikacja nie określa czasu pojawienia się gracza online ani nie śledzi go w czasie rzeczywistym.

Projekt nie jest oficjalnym produktem Rednim Games ani Gravity. Repozytorium nie nadaje dodatkowych praw do grafik gry ani danych zewnętrznych źródeł.
