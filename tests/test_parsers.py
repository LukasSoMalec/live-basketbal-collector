import unittest
import os
from unittest import mock
from collector import Match, Source, parse_synot, parse_football, parse_fonbet, parse_1xbit, split_teams, reconcile_fonbet_references, reconcile_1xbit_references, team_equivalent, reconcile_semantic_references


class ParserTests(unittest.TestCase):
    def test_synot_zero_eventcount_but_events_present(self):
        payload = {
            "Result": 1,
            "ReturnValue": [
                {"Name": "Fotbal", "DisciplineID": 12, "Events": []},
                {"Name": "Basketbal", "DisciplineID": 21, "EventCount": 0,
                 "Events": [{"ID": 3926125, "ExternalID": "74131950",
                             "Name": "Dubai Basketball - KK Zadar",
                             "Date": "2026-11-02T16:30:00+01:00",
                             "CategoryPath": "Mezinárodní / ABA Liga",
                             "SportExtId": "sr:sport:2", "StateName": "2. čtvrtina",
                             "Results": [{"MainResult": True, "Score": "35:36"}]}]},
            ]}
        parsed = parse_synot(payload)
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0].eventId, "sr:match:74131950")
        self.assertEqual(parsed[0].date, "2026-11-02")
        self.assertEqual(parsed[0].score, "35:36")

    def test_football_filters_simulated_and_future(self):
        payload = {"data": [
            {"name": "Liga ABA", "events": [
                {"eventId":"sr:match:74131950", "status": 1, "matchStatus": "Q2",
                 "sport":{"id":"sr:sport:2"}, "homeTeamName":"Dubai Basketball",
                 "awayTeamName":"KK Zadar", "estimateStartTime":1793633400000,
                 "setScore":"35:36"},
                {"eventId":"sr:match:10000", "status": 0, "matchStatus": "NS",
                 "sport":{"id":"sr:sport:2"}, "homeTeamName":"Soon","awayTeamName":"Later"},
            ]},
            {"name": "BSKT CUP International", "events": [
                {"eventId":"sr:match:20000", "status": 1, "matchStatus": "Q3",
                 "sport":{"id":"sr:sport:2"}, "homeTeamName":"Faux","awayTeamName":"Ghost"},
            ]},
        ]}
        matches = parse_football(payload)
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].eventId, "sr:match:74131950")

    def test_real_bskt_cup_with_opaque_ids_is_gated_until_apps_script_update(self):
        events = [
            {"eventId": "sr:match:BAaGde|NHdp-rkVS9wMWaBw", "gameId": "33827",
             "status": 1, "matchStatus": "Q2", "sport": {"id": "sr:sport:2"},
             "homeTeamName": "Alligators", "awayTeamName": "Lions",
             "estimateStartTime": 1793691000000, "setScore": "32:32"},
            {"eventId": "sr:match:BAaGde|differentMatchAbc", "gameId": "33841",
             "status": 1, "matchStatus": "Q1", "sport": {"id": "sr:sport:2"},
             "homeTeamName": "Alligators", "awayTeamName": "Lions",
             "estimateStartTime": 1793691000000, "setScore": "10:8"},
        ]
        payload = {"data": [{"name": "BSKT CUP", "events": events}]}
        with mock.patch.dict(os.environ, {"ENABLE_BSKT_CUP": "0"}):
            self.assertEqual(parse_football(payload), [])
        with mock.patch.dict(os.environ, {"ENABLE_BSKT_CUP": "1"}):
            parsed = parse_football(payload)
        self.assertEqual(len(parsed), 2)
        self.assertEqual([x.eventId for x in parsed],
                         [x["eventId"] for x in events])
        self.assertEqual(parsed[0].home, "Alligators")
        self.assertEqual(parsed[0].date, "2026-11-03")

    def test_invalid_synot_is_distinct_from_empty(self):
        self.assertIsNone(parse_synot({"Result": 0}))
        self.assertEqual(parse_synot({"Result": 1, "ReturnValue": [
            {"Name": "Basketbal", "DisciplineID": 21, "Events": []}]}), [])

    def test_fonbet_live_basketball_only(self):
        data = {
            "fromVersion": 0, "packetVersion": 123456,
            "sports": [
                {"id": 1, "kind": "sport", "alias": "basketball", "name": "Basketball"},
                {"id": 11, "parentId": 1, "name": "EuroCup Women"},
                {"id": 2, "kind": "sport", "alias": "football", "name": "Football"},
                {"id": 12, "parentId": 2, "name": "Premier League"},
                {"id": 13, "parentId": 1, "name": "NBA 2K EsportsBattle"},
            ],
            "events": [
                {"id": 999, "sportId": 11, "level": 1, "kind": 1, "place": "live",
                 "team1": "TTT Riga", "team2": "Elizur Ramla",
                 "startTime": 1793633400},
                {"id": 1000, "sportId": 11, "level": 1, "kind": 1, "place": "line",
                 "team1": "Soon", "team2": "Later", "startTime": 1793633400},
                {"id": 1001, "sportId": 11, "level": 2, "kind": 100401, "place": "live",
                 "team1": "Quarter", "team2": "Event", "startTime": 1793633400},
                {"id": 1002, "sportId": 12, "level": 1, "kind": 1, "place": "live",
                 "team1": "Arsenal", "team2": "Chelsea", "startTime": 1793633400},
                {"id": 1003, "sportId": 13, "level": 1, "kind": 1, "place": "live",
                 "team1": "LA Lakers (Panda)", "team2": "Boston (Ghost)",
                 "startTime": 1793633400},
            ],
            "eventMiscs": [{"eventId": 999, "score1": 55, "score2": 50}],
        }
        parsed = parse_fonbet(data)
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0].providerId, "999")
        self.assertEqual(parsed[0].competition, "EuroCup Women")
        self.assertEqual(parsed[0].score, "55:50")
        self.assertEqual(parsed[0].date, "2026-11-02")

    def test_fonbet_listbase_does_not_treat_future_as_live(self):
        base = {
            "sports": [
                {"id": 1, "name": "Basketball", "alias": "basketball", "kind": "sport"},
                {"id": 9, "name": "ABA League", "kind": "segment", "parentId": 1},
            ],
            "events": [
                {"id": 11, "sportId": 9, "level": 1, "kind": 1, "place": "line",
                 "team1": "Upcoming A", "team2": "Upcoming B", "startTime": 1793633400},
                {"id": 12, "sportId": 9, "level": 1, "kind": 1, "place": "live",
                 "team1": "Current A", "team2": "Current B", "startTime": 1793633400},
                {"id": 13, "sportId": 9, "level": 1, "kind": 1, "place": "live",
                 "parentId": 12, "team1": "Period A", "team2": "Period B",
                 "startTime": 1793633400},
            ]
        }
        result = parse_fonbet(base)
        self.assertEqual([match.providerId for match in result], ["12"])
        self.assertEqual(result[0].competition, "ABA League")

    def test_fonbet_rejects_delta_and_invalid_schema(self):
        base = {"sports": [], "events": []}
        self.assertEqual(parse_fonbet(base), [])
        self.assertIsNone(parse_fonbet({"events": []}))
        self.assertIsNone(parse_fonbet({**base, "fromVersion": 10472}))

    def test_fonbet_reconciles_only_unique_verified_sport_radar_match(self):
        football = Source("Football.com", status="ÚSPĚCH", matches=[
            Match("BC Khimki Moscow", "BC Chelbasket Chelyabinsk",
                  "Super League", "2026-11-02", "sr:match:74496890"),
            Match("Dubai Basketball", "KK Zadar", "ABA", "2026-11-02",
                  "sr:match:74131950"),
        ])
        fonbet = Source("Fonbet", status="ÚSPĚCH", matches=[
            Match("Khimki", "Chelbasket", "Russia Superleague",
                  "2026-11-02", providerId="15001"),
            Match("Dubai Basketball", "KK Zadar", "ABA",
                  "2026-11-02", providerId="15002"),
            Match("Some Club", "Another Club", "Other",
                  "2026-11-02", providerId="15003"),
            Match("Khimki", "Chelbasket", "Other",
                  "2026-11-03", providerId="15004"),
        ])
        count = reconcile_fonbet_references([football, fonbet])
        self.assertEqual(count, 2)
        self.assertEqual([m.eventId for m in fonbet.matches],
                         ["sr:match:74496890", "sr:match:74131950", "", ""])

    def test_fonbet_ref_match_rejects_ambiguous_reference(self):
        a = Source("SynotTip", matches=[
            Match("Dubai Basketball", "KK Zadar", "ABA",
                  "2026-11-02", "sr:match:12345678"),
        ])
        b = Source("Football.com", matches=[
            Match("Dubai Basketball", "KK Zadar", "ABA",
                  "2026-11-02", "sr:match:87654321"),
        ])
        fonbet = Source("Fonbet", matches=[
            Match("Dubai Basketball", "KK Zadar", "ABA",
                  "2026-11-02", providerId="1"),
        ])
        self.assertEqual(reconcile_fonbet_references([a, b, fonbet]), 0)
        self.assertEqual(fonbet.matches[0].eventId, "")

    def test_1xbit_current_v3_live_basketball_schema(self):
        def event(match_id, league, home="Mega", away="Spartak Subotica",
                  sport_id=3, menu=2, period=2, main_id=None):
            return {
                "sport": {"nameEng": "Basketball", "id": sport_id, "name": "Basketbal"},
                "liga": {"nameEng": league, "name": "Jadranská liga"},
                "opponent1": {"fullNameEng": home},
                "opponent2": {"fullNameEng": away},
                "startTs": 1793640600, "id": match_id,
                "mainGameId": match_id if main_id is None else main_id,
                "kind": 1, "menuSection": menu,
                "scores": {"currentPeriod": period, "currentPeriodName": "2. čtvrtina",
                           "scoreOpp1": 14, "scoreOpp2": 30},
            }

        payload = [
            event(767456285, "ABA League"),
            event(2, "NBA 2K26. Super Series"),
            event(3, "IPBL. Pro Division"),
            event(8, "Table Basketball League", "Brazil (TBL)", "Finland (TBL)"),
            event(9, "ABA League"),
            event(4, "ABA League", sport_id=1),
            event(5, "ABA League", menu=1),
            event(6, "ABA League", period=0),
            event(7, "ABA League", main_id=99),
        ]
        payload[3]["scores"]["statusLineStr"] = "Do začátku zbývá 11 min."
        parsed = parse_1xbit(payload)
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0].home, "Mega")
        self.assertEqual(parsed[0].away, "Spartak Subotica")
        self.assertEqual(parsed[0].competition, "ABA League")
        self.assertEqual(parsed[0].date, "2026-11-02")
        self.assertEqual(parsed[0].providerId, "767456285")
        self.assertEqual(parsed[0].score, "14:30")

    def test_1xbit_invalid_payload_distinct_from_empty(self):
        self.assertEqual(parse_1xbit([]), [])
        self.assertIsNone(parse_1xbit({"Value": []}))
        self.assertIsNone(parse_1xbit([{"unknown": True}]))

    def test_1xbit_unique_id_linkage_and_ambiguous_rejection(self):
        anchor = Source("Football.com", matches=[
            Match("KK Mega Basket", "Spartak Subotica", "ABA",
                  "2026-11-02", "sr:match:74131944"),
            Match("Team A", "Team B", "ABA", "2026-11-02",
                  "sr:match:11111111"),
        ])
        ambiguous = Source("SynotTip", matches=[
            Match("Team A", "Team B", "ABA", "2026-11-02",
                  "sr:match:22222222"),
        ])
        bit = Source("1xBit", matches=[
            Match("Mega", "Spartak Subotica", "ABA", "2026-11-02",
                  providerId="767456285"),
            Match("Team A", "Team B", "ABA", "2026-11-02",
                  providerId="99"),
            Match("Unseen", "Unknown", "ABA", "2026-11-02",
                  providerId="100"),
        ])
        self.assertEqual(reconcile_1xbit_references([anchor, ambiguous, bit]), 1)
        self.assertEqual([m.eventId for m in bit.matches],
                         ["sr:match:74131944", "", ""])

    def test_1xbit_verified_reversed_womens_fixtures(self):
        official = Source("SynotTip", matches=[
            Match("Ole Miss Rebels", "Alcorn State Braves", "NCAA Women",
                  "2026-11-02", "sr:match:74978916"),
            Match("Vanderbilt Commodores", "Lipscomb Bisons", "NCAA Women",
                  "2026-11-02", "sr:match:73869150"),
        ])
        bit = Source("1xBit", matches=[
            Match("Alcorn State Braves (Women)", "Ole Miss Rebels (Women)",
                  "WNCAA", "2026-11-02", providerId="111"),
            Match("Lipscomb Bisons (Women)", "Vanderbilt Commodores (Women)",
                  "WNCAA", "2026-11-02", providerId="222"),
        ])
        self.assertEqual(reconcile_1xbit_references([official, bit]), 2)
        self.assertEqual([m.eventId for m in bit.matches],
                         ["sr:match:74978916", "sr:match:73869150"])

    def test_semantic_aliases_papagou_panionios(self):
        self.assertTrue(team_equivalent("AS Papagou", "Papagou"))
        self.assertTrue(team_equivalent("Panionios BC Atény", "Panionios Athens"))
        self.assertTrue(team_equivalent("Panionios Athens", "Panionios"))
        self.assertFalse(team_equivalent("Papagou U19", "Papagou"))
        self.assertFalse(team_equivalent("Panionios Women", "Panionios"))
        self.assertFalse(team_equivalent("Panionios B", "Panionios"))
        self.assertFalse(team_equivalent("Panionios Academy", "Panionios"))

        anchor = Source("SynotTip", matches=[
            Match("AS Papagou", "Panionios BC Atény",
                  "Řecko / Elite League", "2026-11-02", "sr:match:73113286")])
        fon = Source("Fonbet", matches=[
            Match("AS Papagou", "Panionios Athens",
                  "Greece. Elite League", "2026-11-02", providerId="123")])
        bit = Source("1xBit", matches=[
            Match("Papagou", "Panionios",
                  "Greece. Elite League", "2026-11-02", providerId="456")])
        self.assertEqual(reconcile_semantic_references([anchor, fon, bit]), 2)
        self.assertEqual(fon.matches[0].eventId, "sr:match:73113286")
        self.assertEqual(bit.matches[0].eventId, "sr:match:73113286")

    def test_semantic_aliases_avoid_wrong_competition_and_multiple_ids(self):
        a = Source("SynotTip", matches=[
            Match("AS Papagou", "Panionios Athens",
                  "Greece. Elite League", "2026-11-02", "sr:match:73113286"),
            Match("AS Papagou", "Panionios Athens",
                  "Greece. Elite League", "2026-11-02", "sr:match:99999991"),
        ])
        fon = Source("Fonbet", matches=[
            Match("Papagou", "Panionios",
                  "Greece. Elite League", "2026-11-02", providerId="123"),
            Match("Papagou", "Panionios",
                  "Italy. Serie A", "2026-11-02", providerId="124"),
        ])
        self.assertEqual(reconcile_semantic_references([a, fon]), 0)
        self.assertTrue(all(not m.eventId for m in fon.matches))

    def test_women_and_greek_aliases_match_verified_sport_radar_ids(self):
        synot = Source("SynotTip", matches=[
            Match("Stjarnan FC", "Fjolnir Reykjavik",
                  "Iceland women", "2026-11-02", "sr:match:74932484"),
        ])
        football = Source("Football.com", matches=[
            Match("Bnei Yehuda (Women)", "Maccabi Haifa (Women)",
                  "Israel women", "2026-11-02", "sr:match:111111114474703"),
            Match("Fea Nf Nx", "Enosi Iliou",
                  "Greek A1", "2026-11-02", "sr:match:75585950"),
        ])
        fon = Source("Fonbet", matches=[
            Match("Stjarnan (w)", "Fjölnir (w)", "Iceland women",
                  "2026-11-02", providerId="101"),
            Match("Bnei Yehuda Beava (w)", "Maccabi Haifa (w)",
                  "Israel women", "2026-11-02", providerId="102"),
        ])
        bit = Source("1xBit", matches=[
            Match("UMF Stjarnan (Women)", "Fjolnir (Women)",
                  "Iceland women", "2026-11-02", providerId="103"),
            Match("FEA Neas Filadelfeias Neas Chalkidonas", "Enosi Iliou",
                  "Greece regional", "2026-11-02", providerId="104"),
        ])
        self.assertEqual(reconcile_fonbet_references([synot, football, fon]), 2)
        self.assertEqual(reconcile_1xbit_references([synot, football, fon, bit]), 2)
        self.assertEqual([m.eventId for m in fon.matches],
                         ["sr:match:74932484", "sr:match:111111114474703"])
        self.assertEqual([m.eventId for m in bit.matches],
                         ["sr:match:74932484", "sr:match:75585950"])

    def test_team_split_with_dashes(self):
        self.assertEqual(split_teams("BC Khimki - CSKA-2 Moscow"),
                         ("BC Khimki", "CSKA-2 Moscow"))


if __name__ == '__main__':
    unittest.main()