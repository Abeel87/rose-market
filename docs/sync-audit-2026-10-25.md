# ROSE Market — kontrola synchronizacji 25 października 2026

## Zweryfikowany stan przed poprawką

Sprawdzono publiczne pliki GitHub Pages, źródło rynku, pierwszą stronę API historii oraz logi [workflow 40197085333](https://github.com/Abeel87/rose-market/actions/runs/40197085333). Odczyt publicznych plików: około 22:35 UTC. Nie oceniano świeżości wyłącznie na podstawie plików zapisanych w `main`.

| Element | Wynik |
| --- | --- |
| Publikacja | Sukces, 25.10.2026 około 13:19 UTC |
| Pobranie rynku na runnerze | Sukces, 25.10.2026 13:19:39.782 UTC |
| Data pliku u dostawcy | 24.10.2026 08:00:51.920 UTC |
| Najnowsza obserwacja sklepu | 24.10.2026 06:17:11 UTC, czyli 08:17:11 w Polsce tego dnia |
| Zawartość rynku | 284 sklepy, 1196 pozycji słownika, 2222 oferty |
| Pobranie historii na runnerze | Sukces, zakończone 25.10.2026 13:19:49.119 UTC |
| Zawartość historii | 4728 rekordów, 1449 przedmiotów, 48 stron API |
| Dni obserwacji cen | 20 i 24 października 2026 UTC |

Opublikowany rynek jest identyczny ze źródłem po sparsowaniu JSON. Pozycje historii są identyczne z wcześniejszą kopią w repozytorium; zmienił się tylko czas pobrania. Zatem pobieranie działało, ale nie dostarczyło nowych obserwacji. Błąd zapisany w repozytorium z 24 października nie opisuje ostatniego wdrożenia.

Źródła kontrolne:

- [Opublikowany status rynku](https://abeel87.github.io/rose-market/data/sync-status.json)
- [Opublikowany status historii](https://abeel87.github.io/rose-market/data/history-status.json)
- [Opublikowany rynek](https://abeel87.github.io/rose-market/data/market-stalls.json)
- [Opublikowana historia](https://abeel87.github.io/rose-market/data/price-history.json)
- [Źródło rynku](https://roseonlinetoolbox.com/data/marketStalls.json)
- [API cen](https://api.roseonlinetoolbox.com/api/v1/prices?per_page=100&page=1&days=90&server_id=rose-online)

Te adresy pokazują bieżący stan i po kolejnej publikacji mogą zawierać późniejsze czasy.

## Harmonogram a rzeczywiste wykonanie

Cron pozostaje `37 8,20 * * *`: 08:37 i 20:37 UTC, zimą 09:37 i 21:37 w Polsce, latem 10:37 i 22:37. Push na `main` oraz ręczne wywołanie również uruchamiają publikację. To harmonogram dwóch prób dziennie, nie gwarancja wykonania dokładnie co 12 godzin.

Ostatnie dwa zaplanowane uruchomienia wystartowały 24.10 o 22:41:22 UTC oraz 25.10 o 13:19:32 UTC. Były opóźnione względem harmonogramu. [Dokumentacja GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) przewiduje opóźnienia zadań `schedule`.

## Wykryte problemy i poprawka

1. Każdy runner zaczynał od kopii z repozytorium, nie od poprzedniej publikacji. Awaria lub cofnięcie źródła po udanym imporcie mogły więc cofnąć dane na stronie i utracić część zapamiętanej historii. Teraz przed odświeżaniem odtwarzane są zweryfikowane dane oraz statusy ostatniej publikacji. Nieudana odbudowa zatrzymuje wdrożenie, zostawiając stronę bez zmian.
2. Sukces HTTP/importu nie rozróżniał zmienionych i identycznych obserwacji. Nowe pole `dataChanged` oraz osobne daty obserwacji są używane w statusach, logach i interfejsie. Sam nowy czas pobrania nie oznacza świeżych ofert.
3. `continue-on-error` umożliwiało całkowicie zielony workflow mimo awarii źródła. Zachowano możliwość publikacji poprawnej kopii z widocznym błędem, ale końcowa kontrola oznacza taki workflow jako nieudany. Stary status pozostały po przerwanym skrypcie nie przechodzi walidacji nowej próby.
4. Brakowało testów samych skryptów synchronizacji. Dodano testy pobrań, paginacji, limitów, niepoprawnych odpowiedzi, identycznych danych, cofnięć źródła oraz odtwarzania kolejnych publikacji. Dane testowe pozostają wyłącznie w `tests/` i katalogach tymczasowych.

Żadne oferty ani ceny w plikach `dist/data/` nie zostały ręcznie zmienione lub wygenerowane. Poprawka nie może wymusić nowych obserwacji u zewnętrznego dostawcy.
