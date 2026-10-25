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
- Historię minimalnych i maksymalnych cen sprzedaży oraz skupu, rozdzieloną według dni UTC.

To zapis obserwacji. **Pozycja na mapie nie potwierdza, że sklep nadal działa w tym miejscu ani że przedmiot jest jeszcze dostępny.** Mapa sklepów obejmuje tylko Junon Polis. Historia cen jest odrębnym zbiorem notowań dla serwera ROSE Online; jej rekordy nie potwierdzają miejsca oferty. Aplikacja nie łączy się z kontem w grze i nie prowadzi transakcji.

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
- według harmonogramu o **08:37 i 20:37 UTC** każdego dnia, czyli zimą o 09:37 i 21:37, a latem o 10:37 i 22:37 w Polsce.

To godziny harmonogramu, a nie gwarantowane terminy wykonania. GitHub Actions może opóźniać zadania. Przycisk „Odśwież” pobiera aktualną publikację Pages; nie uruchamia skanowania gry ani workflow.

Przy publikacji skrypt `scripts/sync-market.mjs` wykonuje jedno pobranie HTTPS ze wskazanego źródła, z limitem czasu 25 sekund i rozmiaru 8 MiB. Sprawdza schemat przez `normalizeSnapshot`, odrzuca puste lub starsze kopie i dopiero potem atomowo zastępuje plik danych. Nie zmienia czasów obserwacji na czas uruchomienia skryptu.

Przed pobieraniem ze źródeł `scripts/published-data.mjs` odtwarza **ostatnią poprawną kopię z opublikowanej strony**, razem ze statusami rynku i historii. Sprawdza wszystkie cztery pliki oraz zgodność dat statusu z danymi. Kopia z czystego checkoutu nie zastępuje nowszego opublikowanego stanu. Jeśli nie można odczytać lub zweryfikować publikacji, workflow zatrzymuje się przed wdrożeniem i zostawia działającą stronę. Nowszy ręczny import historii w repozytorium wymaga uzgodnienia z publikacją, aby nie zgubić żadnej historii.

Jeśli pobranie ze źródła lub walidacja się nie powiedzie, skrypt zachowuje odtworzoną kopię i zapisuje nowy status błędu. Workflow publikuje zweryfikowane dane zapasowe wraz z tym statusem, a potem oznacza uruchomienie jako nieudane. Błąd synchronizacji nie jest więc ukryty za udaną publikacją strony. Nie wolno publikować statusu z poprzedniego uruchomienia, jeżeli nowy skrypt przerwał pracę bez zapisania wyniku.

`success` oznacza udane pobranie i walidację; `dataChanged` rozróżnia zmienione dane (`true`), identyczne obserwacje (`false`) i nieudaną próbę (`null`). `latestObservationAt` rynku oraz `latestObservationDate` historii wskazują czas rzeczywistych obserwacji, niezależny od czasu pobrania. Stare obserwacje generują ostrzeżenie, nawet kiedy pobranie jest udane. Nowe dane trafiają do publikowanej strony; automatyczne uruchomienia nie dopisują commitów do repozytorium. Częstsze uruchomienie workflow nie przyspiesza aktualizacji danych u dostawcy.

## Historia cen

Historię w `dist/data/price-history.json` tworzy skrypt `scripts/sync-history.mjs` z publicznego [API cen ROSE Online Toolbox](https://api.roseonlinetoolbox.com/api/v1/prices). Pobiera wyłącznie serwer `rose-online`, z zapytaniem o ostatnie 90 dni. Dopasowanie przedmiotów wymaga tej samej nazwy po normalizacji Unicode NFC, usunięciu skrajnych spacji i zamianie liter na małe; warianty przedmiotu nie są łączone przez częściowe podobieństwo nazw.

Pierwszy pełny import wykonany **24 października 2026 r. o 09:58 UTC** obejmował 4728 rekordów cen na 48 stronach API i 1449 przedmiotów. Dostawca zwrócił wtedy obserwacje z **20 i 24 października 2026 r.** Zapytanie o 90 dni nie oznacza, że źródło ma notowania z każdego z tych dni.

Każdy punkt oznacza **dzień obserwacji w UTC**, wyznaczony z `submitted_at`. Dla tego dnia osobno obliczamy minimum i maksimum rekordów sprzedaży (`sellMin`, `sellMax`) oraz skupu (`buyMin`, `buyMax`). Brak strony rynku daje wartości `null`; brak notowań w danym dniu nie oznacza ceny zero. Nie korzystamy z API dziennych średnich, które łączy oferty kupna i sprzedaży.

Są to **notowania ofert, a nie potwierdzone transakcje**. Pola `sellCount` i `buyCount` liczą rekordy cen dostawcy; nie oznaczają liczby sprzedawców, transakcji ani wolumenu. Pole ilości z API nie jest używane do obliczania wolumenu ani ceny jednostkowej, ponieważ nie potwierdza porównywalnej jednostki ceny i może występować w powtórzonych raportach granicznych cen.

Pobranie obejmuje wszystkie strony odpowiedzi: po 100 rekordów, maksymalnie 100 stron i 10 000 rekordów. Działają najwyżej dwa równoległe zapytania. Skrypt sprawdza spójność paginacji, unikalność identyfikatorów rekordów, serwer, typ oferty, nazwę i identyfikator przedmiotu, całkowitą nieujemną cenę oraz datę obserwacji. Każde zapytanie ma limit 25 sekund, całość pięć minut. Przy HTTP 429 respektuje krótki `Retry-After`, z ograniczoną liczbą ponowień; dłuższe ograniczenie kończy próbę i zachowuje poprzednią kopię.

Nowa kompletna odpowiedź zastępuje nakładające się koszyki dnia i typu oferty, aby ponowne pobranie nie podwajało liczników. Starsze punkty dostępne w zapisanej kopii są zachowywane, jeżeli API już ich nie zwraca; pozostaje najwyżej 90 dni. Kopia początkowa i przyszłe aktualizacje zawierają tylko rzeczywiście dostarczone notowania — aplikacja nie dopisuje sztucznych dni ani nie prowadzi niezależnego zapisu wszystkich codziennych sklepów. GitHub Actions aktualizuje publikowaną stronę bez automatycznych commitów. Kolejny import korzysta z ostatniej opublikowanej historii i zachowuje dostępne wcześniejsze punkty w oknie 90 dni, nawet jeśli źródło już ich nie zwraca.

Status pobrania historii jest oddzielony od statusu mapy sklepów i zapisany w `dist/data/history-status.json`. Błąd sieci, niepełna odpowiedź lub zmiana schematu nie nadpisują dobrej historii i nie oznaczają jej jako odświeżonej.

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

Testy synchronizacji używają wyłącznie izolowanych katalogów tymczasowych i odpowiedzi testowych. Obejmują pełną paginację, powtórny import, rozdzielenie kupna i sprzedaży, niepełne/niepoprawne dane, HTTP 429/503, stare kopie, daty z przyszłości oraz kolejne publikacje po awarii. Testy PR nie kontaktują się ze źródłami i nie publikują strony.

Ręczne pobranie danych:

```sh
npm run sync
```

Ręczne pobranie historii cen:

```sh
node scripts/sync-history.mjs
```

Przy błędzie pobrania lub walidacji polecenie kończy się kodem różnym od zera; poprawna istniejąca kopia pozostaje na miejscu, a status opisuje nieudaną próbę.

## Prywatność i ograniczenia

Ulubione są przechowywane lokalnie w przeglądarce. Nie synchronizują się automatycznie pomiędzy urządzeniami. Informacje o sklepach pochodzą z publicznej bazy; aplikacja nie określa czasu pojawienia się gracza online ani nie śledzi go w czasie rzeczywistym.

Projekt nie jest oficjalnym produktem Rednim Games ani Gravity. Repozytorium nie nadaje dodatkowych praw do grafik gry ani danych zewnętrznych źródeł.
