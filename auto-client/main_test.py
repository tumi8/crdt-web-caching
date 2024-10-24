

import unittest

from main import run_autonomous_client


class TestAutonomousClient(unittest.TestCase):

    def test_flights_proxy(self):
        run_autonomous_client('flights', 'proxy', 'localhost:8005', 20, 1)

    def test_flights_cache(self):
        run_autonomous_client('flights', 'cache', 'localhost:8005', 20, 1)

    def test_flights_ttl_cache(self):
        run_autonomous_client('flights', 'ttl', 'localhost:8005', 20, 1)

    def test_flights_crdt(self):
        run_autonomous_client('flights', 'crdt', 'localhost:8005', 20, 1)

    def test_forum_proxy(self):
        run_autonomous_client('forums', 'proxy', 'localhost:8005', 20, 1)

    def test_forum_cache(self):
        run_autonomous_client('forums', 'cache', 'localhost:8005', 20, 1)

    def test_forum_ttl_cache(self):
        run_autonomous_client('forums', 'ttl', 'localhost:8005', 20)

    def test_forum_crdt(self):
        run_autonomous_client('forums', 'crdt', 'localhost:8005', 20)


if __name__ == '__main__':
    unittest.main()
