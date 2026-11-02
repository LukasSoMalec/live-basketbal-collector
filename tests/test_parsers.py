import unittest
from collector import parse_synot, parse_football, parse_fonbet, split_teams


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

    def test_team_split_with_dashes(self):
        self.assertEqual(split_teams("BC Khimki - CSKA-2 Moscow"),
                         ("BC Khimki", "CSKA-2 Moscow"))


if __name__ == '__main__':
    unittest.main()