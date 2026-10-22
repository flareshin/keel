import unittest

from accounts.emails import same_address


class SameAddressTest(unittest.TestCase):
    def test_equalAddresses_match(self) -> None:
        self.assertTrue(same_address("ada@example.com", "ada@example.com"))
