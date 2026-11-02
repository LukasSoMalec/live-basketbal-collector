import unittest
from collector import parse_synot, parse_football, split_teams


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

    def test_team_split_with_dashes(self):
        self.assertEqual(split_teams("BC Khimki - CSKA-2 Moscow"),
                         ("BC Khimki", "CSKA-2 Moscow"))


if __name__ == '__main__':
    unittest.main()